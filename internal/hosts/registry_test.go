package hosts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

func registryStore(t *testing.T) *storage.Store {
	t.Helper()
	s, err := storage.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Close() })
	return s
}

func registryPeer(t *testing.T, id string, snapshot func(http.ResponseWriter, *http.Request)) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/peer/v1/info" {
			json.NewEncoder(w).Encode(Info{ControllerID: id, Protocol: 1, Access: "control"})
			return
		}
		if snapshot != nil {
			snapshot(w, r)
			return
		}
		json.NewEncoder(w).Encode(Snapshot{Info: Info{ControllerID: id, Protocol: 1, Access: "control"}, Groups: map[string]config.Group{"g": {Name: "Group"}}, Apps: []manager.AppView{{Config: config.App{ID: "app", Env: map[string]string{"key": "value"}}, Ports: map[int]bool{80: true}}}})
	}))
	t.Cleanup(s.Close)
	return s
}

func registryRegister(t *testing.T, r *Registry, s *httptest.Server) Description {
	t.Helper()
	d, err := r.Register(context.Background(), HostInput{Name: "Peer", URL: s.URL, Token: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// Detects saving unverified/duplicate identities or serializing credentials and live caches.
func TestRegistrationIdentityAndPersistence(t *testing.T) {
	store := registryStore(t)
	r, err := NewRegistry(store, "local")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	self := registryPeer(t, "local", nil)
	if _, err := r.Register(context.Background(), HostInput{Name: "self", URL: self.URL, Token: "secret"}); err == nil {
		t.Fatal("accepted self")
	}
	peer := registryPeer(t, "remote", nil)
	d := registryRegister(t, r, peer)
	if _, err := r.Register(context.Background(), HostInput{Name: "duplicate", URL: peer.URL, Token: "secret"}); err == nil {
		t.Fatal("accepted duplicate")
	}
	if err := r.Reconnect(context.Background(), d.ID); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(r.Snapshots())
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "ca_pem") {
		t.Fatal("credentials exposed")
	}
	r.Close()
	peer.Close()
	restarted, err := NewRegistry(store, "local")
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	got := restarted.Snapshots()
	if len(got) != 1 || got[0].Host.ControllerID != "remote" || !got[0].Host.Stale || len(got[0].Apps) != 0 || !got[0].Host.LastSeen.IsZero() {
		t.Fatalf("restart restored current observations: %+v", got)
	}
	saved, err := store.Hosts()
	if err != nil || len(saved) != 1 || saved[0].Token != "secret" || saved[0].ControllerID != "remote" {
		t.Fatalf("persistence: %+v %v", saved, err)
	}
}

// Detects destructive failed edits and replacement identities at the edited endpoint.
func TestFailedUpdatePreservesConnection(t *testing.T) {
	store := registryStore(t)
	r, _ := NewRegistry(store, "local")
	defer r.Close()
	peer := registryPeer(t, "remote", nil)
	d := registryRegister(t, r, peer)
	bad := "bad-token"
	if _, err := r.Update(context.Background(), d.ID, HostPatch{Token: &bad}); err == nil {
		t.Fatal("accepted failed authentication")
	}
	replacement := registryPeer(t, "replacement", nil)
	url := replacement.URL
	if _, err := r.Update(context.Background(), d.ID, HostPatch{URL: &url}); err == nil {
		t.Fatal("accepted replacement identity")
	}
	name := "Renamed"
	emptyCA := ""
	got, err := r.Update(context.Background(), d.ID, HostPatch{Name: &name, CAPEM: &emptyCA})
	if err != nil || got.Name != name {
		t.Fatalf("rename: %+v %v", got, err)
	}
	saved, _ := store.Hosts()
	if saved[0].Token != "secret" || saved[0].URL != peer.URL || saved[0].Name != name {
		t.Fatal("failed edit replaced connection")
	}
	if err := r.Reconnect(context.Background(), d.ID); err != nil {
		t.Fatal(err)
	}
}

// Detects failure clearing history, cross-host blocking, and aliased nested cache values.
func TestSnapshotsIndependentAndStale(t *testing.T) {
	r, _ := NewRegistry(registryStore(t), "local")
	defer r.Close()
	var fail atomic.Bool
	peer := registryPeer(t, "first", func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode(Snapshot{Info: Info{ControllerID: "first", Protocol: 1, Access: "control"}, Apps: []manager.AppView{{Config: config.App{ID: "app", Env: map[string]string{"key": "value"}}, Ports: map[int]bool{80: true}}}})
	})
	other := registryPeer(t, "second", nil)
	a := registryRegister(t, r, peer)
	b := registryRegister(t, r, other)
	for _, id := range []string{a.ID, b.ID} {
		if err := r.Reconnect(context.Background(), id); err != nil {
			t.Fatal(err)
		}
	}
	copied := r.Snapshots()
	for i := range copied {
		if copied[i].Host.ID == a.ID {
			copied[i].Apps[0].Config.Env["key"] = "changed"
			copied[i].Apps[0].Ports[80] = false
		}
	}
	fail.Store(true)
	if err := r.Reconnect(context.Background(), a.ID); err == nil {
		t.Fatal("failure missing")
	}
	got := r.Snapshots()
	for _, e := range got {
		if e.Host.ID == a.ID {
			if !e.Host.Stale || e.Host.State != StateUnauthorized || len(e.Apps) != 1 || e.Apps[0].Config.Env["key"] != "value" || !e.Apps[0].Ports[80] {
				t.Fatalf("lost history or aliased cache: %+v", e)
			}
		} else if e.Host.Stale || len(e.Apps) != 1 {
			t.Fatal("unavailable host blocked other snapshots")
		}
	}
	r.mu.Lock()
	r.entries[b.ID].lastSeen = time.Now().Add(-11 * time.Second)
	r.mu.Unlock()
	for _, e := range r.Snapshots() {
		if e.Host.ID == b.ID && !e.Host.Stale {
			t.Fatal("old observation is current")
		}
	}
}

// Detects unlimited snapshot concurrency, omitted independent workers, and unbounded backoff.
func TestPollingConcurrencyAndBackoff(t *testing.T) {
	r, _ := NewRegistry(registryStore(t), "local")
	defer r.Close()
	var active, maxActive atomic.Int32
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	for i := range 6 {
		id := string(rune('a' + i))
		peer := registryPeer(t, id, func(w http.ResponseWriter, req *http.Request) {
			n := active.Add(1)
			defer active.Add(-1)
			for old := maxActive.Load(); n > old && !maxActive.CompareAndSwap(old, n); old = maxActive.Load() {
			}
			entered <- struct{}{}
			select {
			case <-release:
				json.NewEncoder(w).Encode(Snapshot{Info: Info{ControllerID: id, Protocol: 1, Access: "read"}})
			case <-req.Context().Done():
			}
		})
		registryRegister(t, r, peer)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Start(ctx)
	for range 4 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("pollers did not run independently")
		}
	}
	if maxActive.Load() > 4 {
		t.Fatal("snapshot concurrency exceeded four")
	}
	listed := make(chan []Envelope, 1)
	go func() { listed <- r.Snapshots() }()
	select {
	case snapshots := <-listed:
		if len(snapshots) != 6 {
			t.Fatal("pending peer hidden from snapshots")
		}
	case <-time.After(time.Second):
		t.Fatal("pending network blocked cached list")
	}
	close(release)
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("queued poller did not run")
		}
	}
	r.Close()
	if maxActive.Load() > 4 {
		t.Fatal("snapshot concurrency exceeded four")
	}
	for n, want := range []time.Duration{5 * time.Second, 5 * time.Second, 10 * time.Second, 20 * time.Second, 30 * time.Second} {
		if got := retryDelay(n); got != want {
			t.Fatalf("delay(%d)=%s", n, got)
		}
	}
	if retryDelay(10) != 30*time.Second {
		t.Fatal("retry delay is not bounded")
	}
}

// Detects late snapshots or late edits resurrecting removed/replaced state.
func TestRemovalRejectsLateSnapshot(t *testing.T) {
	store := registryStore(t)
	r, _ := NewRegistry(store, "local")
	defer r.Close()
	entered := make(chan struct{})
	canceled := make(chan struct{})
	peer := registryPeer(t, "remote", func(w http.ResponseWriter, req *http.Request) {
		close(entered)
		<-req.Context().Done()
		close(canceled)
	})
	d := registryRegister(t, r, peer)
	done := make(chan error, 1)
	go func() { done <- r.Reconnect(context.Background(), d.ID) }()
	<-entered
	if err := r.Remove(d.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("removal did not cancel request")
	}
	<-done
	if len(r.Snapshots()) != 0 {
		t.Fatal("late request restored obsolete state")
	}
	saved, _ := store.Hosts()
	if len(saved) != 0 {
		t.Fatal("removal kept credentials")
	}
}

func TestFailedUpdateRejectsLateGeneration(t *testing.T) {
	store := registryStore(t)
	r, _ := NewRegistry(store, "local")
	defer r.Close()
	entered, canceled := make(chan struct{}), make(chan struct{})
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") == "Bearer obsolete" {
			close(entered)
			<-req.Context().Done()
			close(canceled)
			return
		}
		json.NewEncoder(w).Encode(Info{ControllerID: "remote", Protocol: 1, Access: "control"})
	}))
	defer peer.Close()
	d := registryRegister(t, r, peer)
	obsolete := "obsolete"
	done := make(chan error, 1)
	go func() { _, err := r.Update(context.Background(), d.ID, HostPatch{Token: &obsolete}); done <- err }()
	<-entered
	name := "Current generation"
	if _, err := r.Update(context.Background(), d.ID, HostPatch{Name: &name}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("replacement did not cancel old edit")
	}
	if err := <-done; err == nil {
		t.Fatal("late edit accepted")
	}
	saved, _ := store.Hosts()
	if saved[0].Token != "secret" || saved[0].Name != name {
		t.Fatal("late request restored obsolete state")
	}
}

func TestPollingReconnectResetsBackoff(t *testing.T) {
	r, _ := NewRegistry(registryStore(t), "local")
	defer r.Close()
	var failed atomic.Bool
	failed.Store(true)
	observed := make(chan bool, 4)
	peer := registryPeer(t, "remote", func(w http.ResponseWriter, req *http.Request) {
		failure := failed.Load()
		observed <- failure
		if failure {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(Snapshot{Info: Info{ControllerID: "remote", Protocol: 1, Access: "read"}})
	})
	d := registryRegister(t, r, peer)
	r.mu.Lock()
	entry := r.entries[d.ID]
	entry.failures = 3
	r.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	r.Start(ctx)
	select {
	case <-observed:
	case <-ctx.Done():
		t.Fatal("initial poll missing")
	}
	// Waiting for refreshSlot makes the failure's backoff state deterministic.
	entry.refreshSlot <- struct{}{}
	<-entry.refreshSlot
	failed.Store(false)
	if err := r.Reconnect(context.Background(), d.ID); err != nil {
		t.Fatal(err)
	}
	<-observed
	select {
	case <-observed:
	case <-ctx.Done():
		t.Fatal("reconnect left poller waiting on obsolete backoff")
	}
}
