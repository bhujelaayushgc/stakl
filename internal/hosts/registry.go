package hosts

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

const pollInterval = 5 * time.Second
const staleAfter = 10 * time.Second

// Each entry is one immutable connection generation. The record's Access and
// observation fields are protected by Registry.mu. Replacement/removal cancels
// ctx, including any future forwarded streams owned by this generation.
type hostEntry struct {
	record       storage.HostConnection
	client       *Client
	ctx          context.Context
	cancel       context.CancelFunc
	refreshSlot  chan struct{}
	wake         chan struct{}
	state        ConnectionState
	errorMessage string
	lastSeen     time.Time
	cached       []byte
	failures     int
}

type Registry struct {
	mu              sync.RWMutex
	store           *storage.Store
	localID         string
	entries         map[string]*hostEntry
	ctx             context.Context
	cancel          context.CancelFunc
	sem             chan struct{}
	wg              sync.WaitGroup
	started, closed bool
	stopParent      func() bool
}

func NewRegistry(store *storage.Store, localID string) (*Registry, error) {
	if store == nil || localID == "" {
		return nil, unavailable("Controller identity is required")
	}
	records, err := store.Hosts()
	if err != nil {
		return nil, unavailable("Could not load host registrations")
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Registry{store: store, localID: localID, entries: map[string]*hostEntry{}, ctx: ctx, cancel: cancel, sem: make(chan struct{}, 4)}
	for _, record := range records {
		r.entries[record.ID] = r.newEntry(record, nil)
	}
	return r, nil
}

func (r *Registry) newEntry(record storage.HostConnection, client *Client) *hostEntry {
	ctx, cancel := context.WithCancel(r.ctx)
	return &hostEntry{record: record, client: client, ctx: ctx, cancel: cancel, refreshSlot: make(chan struct{}, 1), wake: make(chan struct{}, 1), state: StateConnecting}
}

func (r *Registry) Start(ctx context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started || r.closed {
		return
	}
	r.started = true
	r.stopParent = context.AfterFunc(ctx, r.cancel)
	for _, entry := range r.entries {
		r.startEntry(entry)
	}
}

// startEntry is called with mu held, so Add cannot race Close's Wait.
func (r *Registry) startEntry(entry *hostEntry) {
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		for {
			if entry.ctx.Err() != nil {
				return
			}
			r.refresh(entry.ctx, entry)
			r.mu.RLock()
			delay := retryDelay(entry.failures)
			r.mu.RUnlock()
			timer := time.NewTimer(delay)
		wait:
			for {
				select {
				case <-entry.ctx.Done():
					timer.Stop()
					return
				case <-entry.wake:
					r.mu.RLock()
					delay = retryDelay(entry.failures)
					r.mu.RUnlock()
					timer.Reset(delay)
				case <-timer.C:
					break wait
				}
			}
		}
	}()
}

func closeEntry(entry *hostEntry) {
	entry.cancel()
	if entry.client != nil {
		entry.client.http.CloseIdleConnections()
		entry.client.mutationHTTP.CloseIdleConnections()
	}
}

func (r *Registry) Close() {
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		r.cancel()
		if r.stopParent != nil {
			r.stopParent()
		}
		for _, entry := range r.entries {
			closeEntry(entry)
		}
	}
	r.mu.Unlock()
	r.wg.Wait()
}

func linkedContext(parent, connection context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(connection, cancel)
	if connection.Err() != nil {
		cancel()
	}
	return ctx, func() { stop(); cancel() }
}

func (r *Registry) Register(ctx context.Context, input HostInput) (Description, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		return Description{}, unavailable("Host name is required")
	}
	client, err := NewClient(input.URL, input.Token, input.CAPEM, "")
	if err != nil {
		return Description{}, err
	}
	defer client.http.CloseIdleConnections()
	ctx, cancel := linkedContext(ctx, r.ctx)
	defer cancel()
	info, err := client.Info(ctx)
	if err != nil {
		return Description{}, err
	}
	if info.ControllerID == r.localID {
		return Description{}, unavailable("Cannot register this controller")
	}
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return Description{}, unavailable("Could not create host registration")
	}
	record := storage.HostConnection{ID: hex.EncodeToString(bytes[:]), Name: input.Name, URL: client.endpoint.String(), ControllerID: info.ControllerID, Token: input.Token, CAPEM: input.CAPEM, Access: info.Access}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || ctx.Err() != nil {
		return Description{}, unavailable("Host registration canceled")
	}
	for _, entry := range r.entries {
		if entry.record.ControllerID == record.ControllerID {
			return Description{}, unavailable("Controller is already registered")
		}
	}
	if err := r.store.SaveHost(record); err != nil {
		return Description{}, unavailable("Could not save host registration")
	}
	client.expectedID = record.ControllerID
	entry := r.newEntry(record, client)
	r.entries[record.ID] = entry
	if r.started {
		r.startEntry(entry)
	}
	return description(entry, time.Now()), nil
}

func (r *Registry) Update(ctx context.Context, id string, patch HostPatch) (Description, error) {
	r.mu.RLock()
	old := r.entries[id]
	if old == nil || r.closed {
		r.mu.RUnlock()
		return Description{}, unavailable("Host registration is unavailable")
	}
	record := old.record
	r.mu.RUnlock()
	if patch.Name != nil {
		record.Name = strings.TrimSpace(*patch.Name)
	}
	if patch.URL != nil {
		record.URL = *patch.URL
	}
	if patch.Token != nil {
		record.Token = *patch.Token
	}
	if patch.CAPEM != nil {
		record.CAPEM = *patch.CAPEM
	}
	if record.Name == "" {
		return Description{}, unavailable("Host name is required")
	}
	client, err := NewClient(record.URL, record.Token, record.CAPEM, record.ControllerID)
	if err != nil {
		return Description{}, err
	}
	defer client.http.CloseIdleConnections()
	ctx, cancel := linkedContext(ctx, old.ctx)
	defer cancel()
	info, err := client.Info(ctx)
	if err != nil {
		return Description{}, err
	}
	record.URL = client.endpoint.String()
	record.Access = info.Access
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.entries[id] != old || ctx.Err() != nil {
		return Description{}, unavailable("Host registration changed")
	}
	if err := r.store.SaveHost(record); err != nil {
		return Description{}, unavailable("Could not save host registration")
	}
	entry := r.newEntry(record, client)
	entry.cached, entry.lastSeen = old.cached, old.lastSeen
	r.entries[id] = entry
	closeEntry(old)
	if r.started {
		r.startEntry(entry)
	}
	return description(entry, time.Now()), nil
}

func (r *Registry) Remove(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return unavailable("Host registry is closed")
	}
	if err := r.store.DeleteHost(id); err != nil {
		return unavailable("Could not remove host registration")
	}
	if entry := r.entries[id]; entry != nil {
		delete(r.entries, id)
		closeEntry(entry)
	}
	return nil
}

func (r *Registry) Reconnect(ctx context.Context, id string) error {
	r.mu.RLock()
	entry := r.entries[id]
	closed := r.closed
	r.mu.RUnlock()
	if entry == nil || closed {
		return unavailable("Host registration is unavailable")
	}
	err := r.refresh(ctx, entry)
	select {
	case entry.wake <- struct{}{}:
	default:
	}
	return err
}

func (r *Registry) refresh(ctx context.Context, entry *hostEntry) error {
	ctx, cancel := linkedContext(ctx, entry.ctx)
	defer cancel()
	select {
	case entry.refreshSlot <- struct{}{}:
		defer func() { <-entry.refreshSlot }()
	case <-ctx.Done():
		return unavailable("Host refresh canceled")
	}
	select {
	case r.sem <- struct{}{}:
		defer func() { <-r.sem }()
	case <-ctx.Done():
		return unavailable("Host refresh canceled")
	}
	r.mu.Lock()
	if r.closed || r.entries[entry.record.ID] != entry || ctx.Err() != nil {
		r.mu.Unlock()
		return unavailable("Host registration changed")
	}
	client := entry.client
	record := entry.record
	r.mu.Unlock()
	var err error
	if client == nil {
		client, err = NewClient(record.URL, record.Token, record.CAPEM, record.ControllerID)
	}
	var snapshot Snapshot
	if err == nil {
		snapshot, err = client.Snapshot(ctx)
	}
	var cached []byte
	if err == nil {
		cached, err = json.Marshal(snapshot)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.entries[record.ID] != entry || entry.ctx.Err() != nil {
		if client != nil {
			client.http.CloseIdleConnections()
		}
		return unavailable("Host registration changed")
	}
	entry.client = client
	if err == nil && record.Access != snapshot.Info.Access {
		record.Access = snapshot.Info.Access
		if saveErr := r.store.SaveHost(record); saveErr != nil {
			err = unavailable("Could not save host access")
		}
	}
	if err != nil {
		entry.failures++
		entry.state = StateUnavailable
		entry.errorMessage = "Peer connection failed"
		var hostErr *HostError
		if errors.As(err, &hostErr) {
			entry.state = hostErr.State
			entry.errorMessage = hostErr.Message
		}
		return err
	}
	entry.record = record
	entry.cached = cached
	entry.lastSeen = time.Now().UTC()
	entry.failures = 0
	entry.state = StateOnline
	entry.errorMessage = ""
	return nil
}

func retryDelay(failures int) time.Duration {
	switch {
	case failures <= 1:
		return pollInterval
	case failures == 2:
		return 10 * time.Second
	case failures == 3:
		return 20 * time.Second
	default:
		return 30 * time.Second
	}
}

func description(entry *hostEntry, now time.Time) Description {
	h := entry.record
	return Description{ID: h.ID, ControllerID: h.ControllerID, Name: h.Name, URL: h.URL, Access: h.Access, State: entry.state, LastSeen: entry.lastSeen, Stale: entry.state != StateOnline || entry.lastSeen.IsZero() || now.Sub(entry.lastSeen) > staleAfter, Error: entry.errorMessage}
}

func (r *Registry) Descriptions() []Description {
	r.mu.RLock()
	defer r.mu.RUnlock()
	result := make([]Description, 0, len(r.entries))
	now := time.Now()
	for _, entry := range r.entries {
		result = append(result, description(entry, now))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func (r *Registry) Snapshots() []Envelope {
	r.mu.RLock()
	result := make([]Envelope, 0, len(r.entries))
	cached := make(map[string][]byte, len(r.entries))
	now := time.Now()
	for id, entry := range r.entries {
		result = append(result, Envelope{Host: description(entry, now)})
		cached[id] = entry.cached
	}
	r.mu.RUnlock()
	for i := range result {
		var snapshot Snapshot
		if len(cached[result[i].Host.ID]) > 0 {
			_ = json.Unmarshal(cached[result[i].Host.ID], &snapshot)
		}
		result[i].Groups = snapshot.Groups
		result[i].Apps = snapshot.Apps
		if result[i].Groups == nil {
			result[i].Groups = map[string]config.Group{}
		}
		if result[i].Apps == nil {
			result[i].Apps = []manager.AppView{}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Host.ID < result[j].Host.ID })
	return result
}

// connection captures a generation without exposing connection secrets. Network
// work holds no registry lock and is canceled when this generation is replaced.
func (r *Registry) connection(id string, control bool) (*hostEntry, *Client, error) {
	r.mu.RLock()
	entry := r.entries[id]
	if r.closed || entry == nil {
		r.mu.RUnlock()
		return nil, nil, &HostError{Message: "Host registration is unavailable", State: StateUnavailable, StatusCode: http.StatusNotFound}
	}
	record, client := entry.record, entry.client
	r.mu.RUnlock()
	if client == nil {
		var err error
		client, err = NewClient(record.URL, record.Token, record.CAPEM, record.ControllerID)
		if err != nil {
			return nil, nil, err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.entries[id] != entry || entry.ctx.Err() != nil {
		client.http.CloseIdleConnections()
		return nil, nil, unavailable("Host registration changed")
	}
	if entry.client == nil {
		entry.client = client
	}
	if control {
		if description(entry, time.Now()).Stale {
			return nil, nil, &HostError{Message: "Host observation is stale; reconnect before operating", State: entry.state, StatusCode: http.StatusConflict}
		}
		if entry.record.Access != "control" {
			return nil, nil, &HostError{Message: "Peer control access is required", State: StateUnauthorized, StatusCode: http.StatusForbidden}
		}
	}
	return entry, entry.client, nil
}

func (r *Registry) forwardError(entry *hostEntry, err error) {
	var hostErr *HostError
	if !errors.As(err, &hostErr) {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.entries[entry.record.ID] != entry || entry.ctx.Err() != nil {
		return
	}
	entry.state = hostErr.State
	entry.errorMessage = hostErr.Message
}

func (r *Registry) ReadApp(ctx context.Context, hostID, appID, resource string, query url.Values, lastEventID string) (*http.Response, error) {
	entry, client, err := r.connection(hostID, false)
	if err != nil {
		return nil, err
	}
	ctx, cancel := linkedContext(ctx, entry.ctx)
	response, err := client.ReadApp(ctx, appID, resource, query, lastEventID)
	if err != nil {
		cancel()
		r.forwardError(entry, err)
		return nil, err
	}
	response.Body = &connectionBody{ReadCloser: response.Body, cancel: cancel}
	return response, nil
}

func (r *Registry) Operate(ctx context.Context, hostID, appID, action string) (PeerActionResult, error) {
	entry, client, err := r.connection(hostID, true)
	if err != nil {
		return PeerActionResult{}, err
	}
	ctx, cancel := linkedContext(ctx, entry.ctx)
	defer cancel()
	result, err := client.Mutate(ctx, appID, action)
	if err != nil {
		r.forwardError(entry, err)
	}
	return result, err
}

type connectionBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *connectionBody) Close() error {
	b.cancel()
	return b.ReadCloser.Close()
}
