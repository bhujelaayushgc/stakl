package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/events"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

func peerFixture(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	c, err := config.Parse([]byte(`version: 1
groups:
  test: {name: Test, order: 1}
apps:
  a:
    type: custom
    group: test
    start: {command: 'touch started', shell: true}
    stop: {command: 'rm -f started', shell: true}
    status: {command: 'test -f started', shell: true}
    env: {SECRET: super-secret-value}
`), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	m := manager.New(c, filepath.Join(dir, "config.yml"), dir, db)
	t.Cleanup(func() { m.Close(); db.DB.Close() })
	s := &Server{Manager: m, Address: "127.0.0.1:49152", Token: "admin", Version: "test"}
	t.Cleanup(s.CancelPeerStreams)
	return s, s.Handler()
}

func peerRequest(h http.Handler, method, path, token, identity, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:49152"+path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Stakl", "1")
	r.Header.Set("X-Stakl-Peer-ID", identity)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func issuePeer(t *testing.T, h http.Handler, access string) (string, string) {
	t.Helper()
	w := peerRequest(h, "POST", "/api/peer-tokens", "admin", "", `{"name":"test","access":"`+access+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.ID == "" || result.Token == "" {
		t.Fatalf("missing issued grant/token: %s", w.Body.String())
	}
	return result.ID, result.Token
}

func TestPeerAccessMatrix(t *testing.T) {
	s, h := peerFixture(t)
	observed := time.Date(2026, 10, 3, 1, 2, 3, 0, time.UTC)
	if err := s.Manager.Store.Check("a", storage.Health{Time: observed, OK: true, Message: "retained health"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Manager.Store.Event(events.Event{Time: observed, App: "a", Type: "app.test", Message: "retained lifecycle"}); err != nil {
		t.Fatal(err)
	}
	_, read := issuePeer(t, h, "read")
	_, control := issuePeer(t, h, "control")
	info := peerRequest(h, "GET", "/api/peer/v1/info", read, "", "")
	var identity struct {
		ControllerID string `json:"controller_id"`
		Protocol     int    `json:"protocol"`
		Access       string `json:"access"`
	}
	if err := json.Unmarshal(info.Body.Bytes(), &identity); err != nil {
		t.Fatal(err)
	}
	if identity.ControllerID == "" || identity.Protocol != 1 || identity.Access != "read" {
		t.Fatalf("info: %s", info.Body.String())
	}
	w := peerRequest(h, "GET", "/api/peer/v1/snapshot", read, "", "")
	var snapshot hosts.Snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Info.ControllerID != identity.ControllerID || len(snapshot.Apps) != 1 || snapshot.Apps[0].Config.ID != "a" || snapshot.Groups["test"].Name != "Test" || snapshot.Apps[0].Config.Env["SECRET"] != "[redacted]" || snapshot.Apps[0].EffectiveConfig.Env["SECRET"] != "[redacted]" {
		t.Fatalf("snapshot lost local metadata or redaction: %s", w.Body.String())
	}
	for _, token := range []string{read, control} {
		for _, path := range []string{"/api/peer/v1/info", "/api/peer/v1/snapshot", "/api/peer/v1/apps/a", "/api/peer/v1/apps/a/health", "/api/peer/v1/apps/a/history", "/api/peer/v1/apps/a/logs", "/api/peer/v1/apps/a/logs?download=true"} {
			w := peerRequest(h, "GET", path, token, "", "")
			if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("super-secret-value")) {
				t.Fatalf("read %s: %d %s", path, w.Code, w.Body.String())
			}
			if strings.HasSuffix(path, "/health") && !strings.Contains(w.Body.String(), "retained health") {
				t.Fatal("peer discarded health history")
			}
			if strings.HasSuffix(path, "/history") && !strings.Contains(w.Body.String(), "retained lifecycle") {
				t.Fatal("peer discarded lifecycle history")
			}
		}
		for _, path := range []string{"/api/apps", "/api/config?raw=true", "/api/profiles", "/api/system/status", "/api/system/directories", "/api/peer-tokens", "/api/hosts", "/api/history"} {
			if w := peerRequest(h, "GET", path, token, "", ""); w.Code != 401 {
				t.Fatalf("admin %s: %d", path, w.Code)
			}
		}
		for _, path := range []string{"/api/discover", "/api/system/observe", "/api/config/save", "/api/actions/start", "/api/profiles/test/start", "/api/peer-tokens", "/api/hosts"} {
			if w := peerRequest(h, "POST", path, token, identity.ControllerID, `{}`); w.Code != 401 {
				t.Fatalf("admin mutation %s: %d", path, w.Code)
			}
		}
	}
	for _, action := range []string{"start", "stop", "restart"} {
		w := peerRequest(h, "POST", "/api/peer/v1/apps/a/"+action, read, identity.ControllerID, "")
		if w.Code != 403 {
			t.Fatalf("read mutation %s: %d", action, w.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "started")); !os.IsNotExist(err) {
		t.Fatal("read grant changed workload")
	}
	for _, action := range []string{"start", "restart", "stop"} {
		w := peerRequest(h, "POST", "/api/peer/v1/apps/a/"+action, control, identity.ControllerID, "")
		var result struct {
			Info struct {
				ControllerID string `json:"controller_id"`
			} `json:"info"`
			Results map[string]string `json:"results"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || result.Results["a"] != "ok" || result.Info.ControllerID != identity.ControllerID {
			t.Fatalf("control %s: %d %s", action, w.Code, w.Body.String())
		}
		_, err := os.Stat(filepath.Join(s.Manager.Dir, "started"))
		if (action == "stop" && !os.IsNotExist(err)) || (action != "stop" && err != nil) {
			t.Fatalf("%s did not operate workload: %v", action, err)
		}
	}
	for _, path := range []string{"/api/peer/v1/apps/a/kill", "/api/peer/v1/apps/a/directory", "/api/peer/v1/apps/a/terminal", "/api/peer/v1/config", "/api/peer/v1/discover"} {
		if w := peerRequest(h, "POST", path, control, identity.ControllerID, ""); w.Code != 404 {
			t.Fatalf("unsupported %s: %d", path, w.Code)
		}
	}
	w = peerRequest(h, "GET", "/api/peer-tokens", "admin", "", "")
	if w.Code != 200 || strings.Contains(w.Body.String(), read) || strings.Contains(w.Body.String(), control) || strings.Contains(w.Body.String(), "hash") {
		t.Fatalf("token listing leaked secrets: %s", w.Body.String())
	}
}

func TestPeerExpectedIdentity(t *testing.T) {
	s, h := peerFixture(t)
	_, token := issuePeer(t, h, "control")
	for _, identity := range []string{"", "wrong-controller"} {
		for _, action := range []string{"start", "stop", "restart"} {
			w := peerRequest(h, "POST", "/api/peer/v1/apps/a/"+action, token, identity, "")
			if w.Code != 409 {
				t.Fatalf("identity mismatch: %d %s", w.Code, w.Body.String())
			}
		}
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "started")); !os.IsNotExist(err) {
		t.Fatal("identity mismatch operated workload")
	}
	if len(s.Manager.Store.History("a")) != 0 {
		t.Fatal("identity mismatch reached manager")
	}
}

func TestPeerTransportAndMutationHeaders(t *testing.T) {
	_, h := peerFixture(t)
	_, token := issuePeer(t, h, "control")
	for _, tc := range []struct {
		remote string
		secure bool
		want   int
	}{{"192.0.2.4:12345", false, 403}, {"192.0.2.4:12345", true, 200}, {"[::1]:12345", false, 200}, {"invalid", false, 403}} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:49152/api/peer/v1/info", nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("X-Forwarded-Proto", "https")
		if tc.secure {
			r.TLS = &tls.ConnectionState{}
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("transport %+v: %d", tc, w.Code)
		}
	}
	r := httptest.NewRequest("POST", "http://127.0.0.1:49152/api/peer/v1/apps/a/start", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("missing X-Stakl: %d", w.Code)
	}
	if w := peerRequest(h, "GET", "/api/peer/v1/info", "admin", "", ""); w.Code != 401 {
		t.Fatalf("admin credential became peer credential: %d", w.Code)
	}
}

func TestPeerRevocationCancelsLogs(t *testing.T) {
	s, h := peerFixture(t)
	id, token := issuePeer(t, h, "read")
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { r.Host = s.Address; h.ServeHTTP(w, r) }))
	defer func() { s.CancelPeerStreams(); ts.Close() }()
	req, _ := http.NewRequestWithContext(t.Context(), "GET", ts.URL+"/api/peer/v1/apps/a/logs?follow=true", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, response.Body); done <- err }()
	w := peerRequest(h, "POST", "/api/peer-tokens/"+id+"/revoke", "admin", "", "")
	if w.Code != 200 {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("revocation did not cancel follow stream")
	}
	if w := peerRequest(h, "GET", "/api/peer/v1/info", token, "", ""); w.Code != 401 {
		t.Fatalf("revoked token authorized: %d", w.Code)
	}
}

func TestPeerRevocationPreventsLateStreamRegistration(t *testing.T) {
	s, h := peerFixture(t)
	id, token := issuePeer(t, h, "read")
	r := httptest.NewRequest("GET", "http://"+s.Address+"/api/peer/v1/apps/a/logs?follow=true", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	authenticated, ok := s.authenticatePeer(w, r)
	if !ok {
		t.Fatalf("initial authentication: %d", w.Code)
	}
	if w := peerRequest(h, "POST", "/api/peer-tokens/"+id+"/revoke", "admin", "", ""); w.Code != 200 {
		t.Fatal(w.Code)
	}
	authenticated.SetPathValue("id", "a")
	w = httptest.NewRecorder()
	s.peerLogs(w, authenticated)
	if w.Code != 401 {
		t.Fatalf("late registration after revoke: %d", w.Code)
	}
}

type stalledPeerResponse struct {
	conn    net.Conn
	header  http.Header
	writing chan struct{}
	once    sync.Once
}

func (w *stalledPeerResponse) Header() http.Header { return w.header }
func (w *stalledPeerResponse) WriteHeader(int)     {}
func (w *stalledPeerResponse) Flush()              {}
func (w *stalledPeerResponse) SetWriteDeadline(deadline time.Time) error {
	return w.conn.SetWriteDeadline(deadline)
}
func (w *stalledPeerResponse) Write(b []byte) (int, error) {
	w.once.Do(func() { close(w.writing) })
	return w.conn.Write(b)
}

func TestPeerRevocationUnblocksStalledLogWriter(t *testing.T) {
	s, h := peerFixture(t)
	id, token := issuePeer(t, h, "read")
	logDir := filepath.Join(s.Manager.Dir, "logs")
	if err := os.MkdirAll(logDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logDir, "a-123456789012345678901234.jsonl"), []byte("{\"seq\":1,\"time\":\"2026-10-03T01:02:03Z\",\"app\":\"a\",\"stream\":\"stdout\",\"text\":\"retained log\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	writer, reader := net.Pipe()
	defer writer.Close()
	defer reader.Close()
	w := &stalledPeerResponse{conn: writer, header: make(http.Header), writing: make(chan struct{})}
	r := httptest.NewRequest("GET", "http://"+s.Address+"/api/peer/v1/apps/a/logs?follow=true", nil)
	r.RemoteAddr = "127.0.0.1:12345"
	r.Header.Set("Authorization", "Bearer "+token)
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, r); close(done) }()
	select {
	case <-w.writing:
	case <-time.After(2 * time.Second):
		t.Fatal("follow stream did not write retained log")
	}
	if result := peerRequest(h, "POST", "/api/peer-tokens/"+id+"/revoke", "admin", "", ""); result.Code != 200 {
		t.Fatal(result.Code)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("revocation left a stalled log write blocked")
	}
}

func TestPeerShutdownCancelsLogs(t *testing.T) {
	s, h := peerFixture(t)
	_, token := issuePeer(t, h, "read")
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { r.Host = s.Address; h.ServeHTTP(w, r) }))
	defer func() { s.CancelPeerStreams(); ts.Close() }()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/peer/v1/apps/a/logs?follow=true", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	response, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, response.Body); done <- err }()
	s.CancelPeerStreams()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown did not cancel follow stream")
	}
	if w := peerRequest(h, "GET", "/api/peer/v1/apps/a/logs?follow=true", token, "", ""); w.Code != 503 {
		t.Fatalf("stream accepted after shutdown: %d", w.Code)
	}
}

func TestPeerControllerInitialization(t *testing.T) {
	fixture, _ := peerFixture(t)
	s := &Server{Manager: fixture.Manager, Address: fixture.Address, Token: fixture.Token}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			h := s.Handler()
			if w := peerRequest(h, "GET", "/api/apps", "admin", "", ""); w.Code != 200 {
				t.Errorf("local fixture initialization: %d", w.Code)
			}
		})
	}
	wg.Wait()
	stored, err := s.Manager.Store.ControllerID()
	if err != nil || s.ControllerID != stored {
		t.Fatalf("stored identity not used: %q %q %v", s.ControllerID, stored, err)
	}
	if _, err := s.Manager.Store.DB.Exec("DELETE FROM metadata WHERE key='controller_id'"); err != nil {
		t.Fatal(err)
	}
	broken := &Server{Manager: s.Manager, Address: s.Address, Token: "admin"}
	h := broken.Handler()
	if w := peerRequest(h, "GET", "/api/peer/v1/info", "anything", "", ""); w.Code != 500 {
		t.Fatalf("identity error hidden: %d %s", w.Code, w.Body.String())
	}
}

func TestPeerTokenValidationAndMissingApps(t *testing.T) {
	_, h := peerFixture(t)
	w := peerRequest(h, "POST", "/api/peer-tokens", "admin", "", `{"name":"default"}`)
	var grant struct {
		Access string `json:"access"`
		Token  string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &grant); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || grant.Access != "read" {
		t.Fatalf("default scope: %d %s", w.Code, w.Body.String())
	}
	for _, body := range []string{`{`, `{}`, `{"name":"test","access":"admin"}`} {
		if w := peerRequest(h, "POST", "/api/peer-tokens", "admin", "", body); w.Code != 400 {
			t.Fatalf("invalid issuance accepted: %s %d", body, w.Code)
		}
	}
	for _, suffix := range []string{"", "/health", "/history", "/logs"} {
		if w := peerRequest(h, "GET", "/api/peer/v1/apps/missing"+suffix, grant.Token, "", ""); w.Code != 404 {
			t.Fatalf("missing app %s: %d", suffix, w.Code)
		}
	}
}
