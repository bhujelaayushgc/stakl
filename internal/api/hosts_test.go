package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/hosts"
)

// Missing admin protection would let peer grants manage the hub's connections.
func TestHostRoutesRequireAdmin(t *testing.T) {
	s, h := peerFixture(t)
	_, read := issuePeer(t, h, "read")
	_, control := issuePeer(t, h, "control")
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/hosts"}, {"GET", "/api/hosts/apps"}, {"POST", "/api/hosts"},
		{"POST", "/api/hosts/x/update"}, {"POST", "/api/hosts/x/reconnect"}, {"POST", "/api/hosts/x/remove"},
		{"GET", "/api/hosts/x/apps/a"}, {"GET", "/api/hosts/x/apps/a/health"}, {"GET", "/api/hosts/x/apps/a/history"}, {"GET", "/api/hosts/x/apps/a/logs"},
		{"POST", "/api/hosts/x/apps/a/start"}, {"POST", "/api/hosts/x/apps/a/stop"}, {"POST", "/api/hosts/x/apps/a/restart"},
	} {
		for _, token := range []string{"", read, control} {
			if w := peerRequest(h, route.method, route.path, token, "", "{}"); w.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s: %d", route.method, route.path, w.Code)
			}
		}
	}
	w := peerRequest(h, "GET", "/api/hosts", "admin", "", "")
	var descriptions []hosts.Description
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &descriptions) != nil || len(descriptions) != 1 || descriptions[0].ID != "local" || descriptions[0].ControllerID != s.ControllerID {
		t.Fatalf("local descriptor: %d %s", w.Code, w.Body.String())
	}
}

func hostFixture(t *testing.T, peerHandler http.Handler, token string) (*Server, http.Handler, string) {
	t.Helper()
	upstream := httptest.NewServer(peerHandler)
	t.Cleanup(upstream.Close)
	hub, _ := peerFixture(t)
	registry, err := hosts.NewRegistry(hub.Manager.Store, hub.ControllerID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(registry.Close)
	hub.Hosts = registry
	h := hub.Handler()
	input, _ := json.Marshal(hosts.HostInput{Name: "Peer", URL: upstream.URL, Token: token})
	w := peerRequest(h, "POST", "/api/hosts", "admin", "", string(input))
	var desc hosts.Description
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &desc) != nil || desc.ID == "" {
		t.Fatalf("register: %d %s", w.Code, w.Body.String())
	}
	w = peerRequest(h, "POST", "/api/hosts/"+desc.ID+"/reconnect", "admin", "", "")
	if w.Code != 200 {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	return hub, h, desc.ID
}

func networkPeer(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { r.Host = "127.0.0.1:49152"; h.ServeHTTP(w, r) })
}

// Equal app IDs must never select the hub manager, leak secrets, or lose outcomes.
func TestHostForwardingIsIsolated(t *testing.T) {
	peer, ph := peerFixture(t)
	_, token := issuePeer(t, ph, "control")
	var posts atomic.Int32
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
		}
		networkPeer(ph).ServeHTTP(w, r)
	})
	hub, h, id := hostFixture(t, upstream, token)
	base := "/api/hosts/" + id + "/apps/a"
	for _, route := range []string{"", "/health", "/history", "/logs"} {
		w := peerRequest(h, "GET", base+route, "admin", "", "")
		var envelope struct {
			Host hosts.Description
			Data json.RawMessage
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || envelope.Host.ID != id || len(envelope.Data) == 0 || strings.Contains(w.Body.String(), "super-secret-value") {
			t.Fatalf("read %s: %d %s", route, w.Code, w.Body.String())
		}
	}
	w := peerRequest(h, "GET", base+"/logs?download=true", "admin", "", "")
	if w.Code != 200 || w.Header().Get("X-Stakl-Host-ID") != id || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("download: %d %v", w.Code, w.Header())
	}
	for _, action := range []string{"start", "restart", "stop"} {
		w = peerRequest(h, "POST", base+"/"+action, "admin", "", "")
		var response struct {
			Host hosts.Description
			Data map[string]string
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.Host.ID != id || response.Data["a"] == "" {
			t.Fatalf("action: %d %s", w.Code, w.Body.String())
		}
		if _, err := os.Stat(filepath.Join(hub.Manager.Dir, "started")); !os.IsNotExist(err) {
			t.Fatal("action reached local manager")
		}
		if action == "start" {
			if _, err := os.Stat(filepath.Join(peer.Manager.Dir, "started")); err != nil {
				t.Fatal("peer was not started")
			}
		}
	}
	if posts.Load() != 3 {
		t.Fatalf("mutation retried: %d", posts.Load())
	}
	for _, route := range []string{"/kill", "/directory", "/terminal", "/config", "/discover"} {
		w = peerRequest(h, "POST", base+route, "admin", "", "")
		if w.Code < 400 {
			t.Fatalf("unsupported action allowed: %s", route)
		}
	}
	w = peerRequest(h, "GET", "/api/hosts/apps", "admin", "", "")
	var aggregate []hosts.Envelope
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &aggregate) != nil || len(aggregate) != 2 || aggregate[0].Host.ID != "local" || len(aggregate[0].Apps) != 1 || len(aggregate[1].Apps) != 1 {
		t.Fatalf("aggregate: %s", w.Body.String())
	}
	w = peerRequest(ph, "GET", "/api/peer/v1/snapshot", token, "", "")
	var snap hosts.Snapshot
	if json.Unmarshal(w.Body.Bytes(), &snap) != nil || len(snap.Apps) != 1 || strings.Contains(w.Body.String(), `"hosts"`) {
		t.Fatalf("peer snapshot recursed: %s", w.Body.String())
	}
	for _, suffix := range []string{"", "/health", "/history", "/logs"} {
		w = peerRequest(h, "GET", "/api/hosts/local/apps/a"+suffix, "admin", "", "")
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"id":"local"`) {
			t.Fatalf("local read: %d %s", w.Code, w.Body.String())
		}
	}
	// Registration edits must invalidate observations until refreshed.
	w = peerRequest(h, "POST", "/api/hosts/"+id+"/update", "admin", "", `{"name":"Renamed"}`)
	if w.Code != 200 || strings.Contains(w.Body.String(), token) {
		t.Fatalf("update: %s", w.Body.String())
	}
	w = peerRequest(h, "POST", base+"/start", "admin", "", "")
	if w.Code < 400 || posts.Load() != 3 {
		t.Fatal("stale host authorized mutation")
	}
	_, read := issuePeer(t, ph, "read")
	input, _ := json.Marshal(map[string]string{"token": read})
	w = peerRequest(h, "POST", "/api/hosts/"+id+"/update", "admin", "", string(input))
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	peerRequest(h, "POST", "/api/hosts/"+id+"/reconnect", "admin", "", "")
	w = peerRequest(h, "POST", base+"/start", "admin", "", "")
	if w.Code != 403 || posts.Load() != 3 {
		t.Fatal("read grant authorized mutation")
	}
}

// A replacement between preflight and POST must be rejected by the real peer.
func TestHostIdentitySwapBeforeMutation(t *testing.T) {
	first, fh := peerFixture(t)
	replacement, rh := peerFixture(t)
	_, token := issuePeer(t, fh, "control")
	_, replacementToken := issuePeer(t, rh, "control")
	var posts atomic.Int32
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
			if r.Header.Get("X-Stakl-Peer-ID") != first.ControllerID {
				t.Error("expected identity missing")
			}
			r.Header.Set("Authorization", "Bearer "+replacementToken)
			networkPeer(rh).ServeHTTP(w, r)
			return
		}
		networkPeer(fh).ServeHTTP(w, r)
	})
	_, h, id := hostFixture(t, proxy, token)
	w := peerRequest(h, "POST", "/api/hosts/"+id+"/apps/a/start", "admin", "", "")
	if w.Code != 409 || posts.Load() != 1 {
		t.Fatalf("identity swap: %d %s posts=%d", w.Code, w.Body.String(), posts.Load())
	}
	if _, err := os.Stat(filepath.Join(replacement.Manager.Dir, "started")); !os.IsNotExist(err) {
		t.Fatal("replacement mutated")
	}
}

func TestHostAmbiguousActionResponse(t *testing.T) {
	_, ph := peerFixture(t)
	_, token := issuePeer(t, ph, "control")
	var posts atomic.Int32
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts.Add(1)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		networkPeer(ph).ServeHTTP(w, r)
	})
	_, h, id := hostFixture(t, proxy, token)
	w := peerRequest(h, "POST", "/api/hosts/"+id+"/apps/a/start", "admin", "", "")
	var result struct {
		OutcomeUnknown bool `json:"outcome_unknown"`
		Data           any
	}
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || !result.OutcomeUnknown || result.Data != nil || w.Code < 400 || posts.Load() != 1 {
		t.Fatalf("ambiguous action claimed success or retried: %d %s count=%d", w.Code, w.Body.String(), posts.Load())
	}
}

func TestHostStreamCancellation(t *testing.T) {
	for _, mode := range []string{"browser", "remove", "revoke", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			_, ph := peerFixture(t)
			grant, token := issuePeer(t, ph, "read")
			closed := make(chan struct{})
			proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/logs") {
					defer close(closed)
				}
				networkPeer(ph).ServeHTTP(w, r)
			})
			hub, h, id := hostFixture(t, proxy, token)
			downstream := httptest.NewServer(networkPeer(h))
			defer downstream.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, "GET", downstream.URL+"/api/hosts/"+id+"/apps/a/logs?follow=true", nil)
			req.Header.Set("Authorization", "Bearer admin")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != 200 || res.Header.Get("X-Stakl-Host-ID") != id || res.Header.Get("Content-Type") != "text/event-stream" {
				t.Fatalf("stream headers: %d %v", res.StatusCode, res.Header)
			}
			switch mode {
			case "browser":
				cancel()
			case "remove":
				peerRequest(h, "POST", "/api/hosts/"+id+"/remove", "admin", "", "")
			case "revoke":
				peerRequest(ph, "POST", "/api/peer-tokens/"+grant+"/revoke", "admin", "", "")
			case "shutdown":
				hub.Hosts.Close()
			}
			select {
			case <-closed:
			case <-time.After(3 * time.Second):
				t.Fatal("upstream stream leaked")
			}
			if mode == "revoke" {
				body, err := io.ReadAll(res.Body)
				if err != nil || !strings.Contains(string(body), "event: connection-error") {
					t.Fatalf("missing connection error: %q %v", body, err)
				}
			}
		})
	}
}

type blockedHostResponse struct {
	*stalledPeerResponse
	writes chan struct{}
}

func (w *blockedHostResponse) Write(data []byte) (int, error) {
	w.writes <- struct{}{}
	return w.stalledPeerResponse.Write(data)
}

func TestHostReplayAndBlockedWriterCancellation(t *testing.T) {
	for _, mode := range []string{"browser", "remove", "shutdown"} {
		t.Run(mode, func(t *testing.T) {
			peer, ph := peerFixture(t)
			_, token := issuePeer(t, ph, "read")
			logDir := filepath.Join(peer.Manager.Dir, "logs")
			if err := os.MkdirAll(logDir, 0700); err != nil {
				t.Fatal(err)
			}
			logs := "{\"seq\":1,\"time\":\"2026-10-03T01:02:03Z\",\"app\":\"a\",\"stream\":\"stdout\",\"text\":\"old log\"}\n{\"seq\":2,\"time\":\"2026-10-03T01:02:04Z\",\"app\":\"a\",\"stream\":\"stdout\",\"text\":\"new log\"}\n"
			if err := os.WriteFile(filepath.Join(logDir, "a-123456789012345678901234.jsonl"), []byte(logs), 0600); err != nil {
				t.Fatal(err)
			}
			hub, h, id := hostFixture(t, networkPeer(ph), token)
			writer, reader := net.Pipe()
			defer writer.Close()
			defer reader.Close()
			w := &blockedHostResponse{stalledPeerResponse: &stalledPeerResponse{conn: writer, header: make(http.Header), writing: make(chan struct{})}, writes: make(chan struct{}, 4)}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := httptest.NewRequest("GET", "http://127.0.0.1:49152/api/hosts/"+id+"/apps/a/logs?follow=true", nil).WithContext(ctx)
			r.Header.Set("Authorization", "Bearer admin")
			r.Header.Set("Last-Event-ID", "2026-10-03T01:02:03Z")
			done := make(chan struct{})
			go func() { h.ServeHTTP(w, r); close(done) }()
			select {
			case <-w.writes:
			case <-time.After(3 * time.Second):
				t.Fatal("SSE did not replay")
			}
			// Read the first replay and then deliberately block the next write.
			reader.SetReadDeadline(time.Now().Add(2 * time.Second))
			replay := make([]byte, 4096)
			n, err := reader.Read(replay)
			if err != nil || !strings.Contains(string(replay[:n]), "id: 2026-10-03T01:02:04Z") || strings.Contains(string(replay[:n]), "old log") {
				t.Fatalf("replay lost IDs or Last-Event-ID: %q %v", replay[:n], err)
			}
			// A new record guarantees another downstream write that cannot complete.
			file, err := os.OpenFile(filepath.Join(logDir, "a-123456789012345678901234.jsonl"), os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			_, err = file.WriteString("{\"seq\":3,\"time\":\"2026-10-03T01:02:05Z\",\"app\":\"a\",\"stream\":\"stdout\",\"text\":\"blocked log\"}\n")
			file.Close()
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-w.writes:
			case <-time.After(2 * time.Second):
				t.Fatal("next log did not reach blocked writer")
			}
			switch mode {
			case "browser":
				cancel()
			case "remove":
				hub.Hosts.Remove(id)
			case "shutdown":
				hub.Hosts.Close()
			}
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("cancellation left downstream write blocked")
			}
		})
	}
}

func TestHostCachedSnapshotsStayResponsive(t *testing.T) {
	_, ph := peerFixture(t)
	_, token := issuePeer(t, ph, "control")
	var offline atomic.Bool
	entered := make(chan struct{}, 1)
	proxy := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if offline.Load() {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-r.Context().Done()
			return
		}
		networkPeer(ph).ServeHTTP(w, r)
	})
	hub, h, id := hostFixture(t, proxy, token)
	offline.Store(true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- hub.Hosts.Reconnect(ctx, id) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("refresh did not reach unavailable peer")
	}
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() { result <- peerRequest(h, "GET", "/api/hosts/apps", "admin", "", "") }()
	select {
	case w := <-result:
		if w.Code != 200 || !strings.Contains(w.Body.String(), id) {
			t.Fatal(w.Body.String())
		}
	case <-time.After(time.Second):
		t.Fatal("unavailable peer blocked aggregate")
	}
	cancel()
	<-done
	w := peerRequest(h, "POST", "/api/hosts/"+id+"/apps/a/start", "admin", "", "")
	if w.Code != 409 {
		t.Fatalf("failed snapshot authorized lifecycle: %d %s", w.Code, w.Body.String())
	}
}

type canceledHostBody struct{ deadline <-chan struct{} }

func (b canceledHostBody) Read([]byte) (int, error) { <-b.deadline; return 0, context.Canceled }
func (b canceledHostBody) Close() error             { return nil }

type deadlineHostResponse struct {
	*stalledPeerResponse
	deadline chan struct{}
	notified sync.Once
}

func (w *deadlineHostResponse) SetWriteDeadline(deadline time.Time) error {
	err := w.conn.SetWriteDeadline(deadline)
	w.notified.Do(func() { close(w.deadline) })
	return err
}
func TestHostCanceledUpstreamEmitsConnectionError(t *testing.T) {
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	w := &deadlineHostResponse{stalledPeerResponse: &stalledPeerResponse{conn: writer, header: make(http.Header), writing: make(chan struct{})}, deadline: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	upstream, _ := http.NewRequestWithContext(ctx, "GET", "http://peer.invalid/logs", nil)
	response := &http.Response{Request: upstream, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: canceledHostBody{w.deadline}}
	downstream := httptest.NewRequest("GET", "http://hub.invalid/logs?follow=true", nil)
	done := make(chan struct{})
	go func() { forwardHostStream(w, downstream, response, "remote"); writer.Close(); close(done) }()
	reader.SetReadDeadline(time.Now().Add(2 * time.Second))
	result, err := io.ReadAll(reader)
	if err != nil || !strings.Contains(string(result), "event: connection-error") {
		t.Fatalf("healthy downstream lost canceled upstream error: %q %v", result, err)
	}
	<-done
}

func TestHostDependencyOutcomesAndCSRF(t *testing.T) {
	peer, ph := peerFixture(t)
	configText := `version: 1
apps:
  dependency:
    type: custom
    start: {command: 'touch dependency-started', shell: true}
    stop: {command: 'rm -f dependency-started', shell: true}
    status: {command: 'test -f dependency-started', shell: true}
  a:
    type: custom
    depends_on: [dependency]
    start: {command: 'touch started', shell: true}
    stop: {command: 'rm -f started', shell: true}
    status: {command: 'test -f started', shell: true}
`
	if err := os.WriteFile(peer.Manager.ConfigPath, []byte(configText), 0600); err != nil {
		t.Fatal(err)
	}
	if err := peer.Manager.Reload(); err != nil {
		t.Fatal(err)
	}
	_, token := issuePeer(t, ph, "control")
	hub, h, id := hostFixture(t, networkPeer(ph), token)
	route := "/api/hosts/" + id + "/apps/a/start"
	for _, origin := range []string{"", "http://evil.invalid"} {
		req := httptest.NewRequest("POST", "http://127.0.0.1:49152"+route, nil)
		req.Header.Set("Authorization", "Bearer admin")
		if origin != "" {
			req.Header.Set("X-Stakl", "1")
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 403 {
			t.Fatalf("missing CSRF or cross origin accepted: %d", w.Code)
		}
	}
	w := peerRequest(h, "POST", route, "admin", "", "")
	var envelope struct{ Data map[string]string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &envelope) != nil || envelope.Data["a"] == "" || envelope.Data["dependency"] == "" {
		t.Fatalf("lost peer dependency outcomes: %d %s", w.Code, w.Body.String())
	}
	for _, file := range []string{"started", "dependency-started"} {
		if _, err := os.Stat(filepath.Join(peer.Manager.Dir, file)); err != nil {
			t.Fatal("peer dependency was not started")
		}
		if _, err := os.Stat(filepath.Join(hub.Manager.Dir, file)); !os.IsNotExist(err) {
			t.Fatal("dependency changed hub workload")
		}
	}
}
