package workspaces

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
)

func probeConfig(t *testing.T, checks string) *config.Config {
	t.Helper()
	c, err := config.Parse([]byte("version: 1\napps: {}\nworkspaces:\n  a:\n    name: A\n    services: {db: {controller: local, app: db}}\n    checks:\n"+checks), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCommandProbeOverlaysControllerEnvironmentAndStartsUnknown(t *testing.T) {
	t.Setenv("WORKSPACE_SECRET", "inherited")
	dir := t.TempDir()
	secret := filepath.Join(dir, "credentials.env")
	if err := os.WriteFile(secret, []byte("WORKSPACE_SECRET=from-file\n"), 0600); err != nil {
		t.Fatal(err)
	}
	p := config.WorkspaceProbe{Cwd: dir, EnvFile: []string{"credentials.env"}, Check: config.WorkspaceCheck{Type: "command", Command: `test "$WORKSPACE_SECRET" = from-file && test -f credentials.env`, Timeout: config.Duration(time.Second)}}
	r := execute(t.Context(), p)
	if !r.OK {
		t.Fatal(r)
	}
	now := time.Now().UTC()
	c, env := fixture(now)
	w := c.Workspaces["a"]
	w.Checks = map[string]config.WorkspaceProbe{"query": p}
	p.Service = "db"
	w.Checks["query"] = p
	c.Workspaces["a"] = w
	e := New(func() *config.Config { return c }, func() []hosts.Envelope { return env })
	defer e.Close()
	if got := e.Views()[0].State; got != "unknown" {
		t.Fatal("new engine reused prior probe evidence", got)
	}
}
func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}

func TestEngineBoundsConcurrencyAndCoalescesCheckNow(t *testing.T) {
	var active, peak, calls atomic.Int32
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		n := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
		}
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer server.Close()
	defer close(release)
	checks := ""
	for i := 0; i < 8; i++ {
		checks += fmt.Sprintf("      c%d: {service: db, check: {type: http, url: '%s', timeout: 5s}}\n", i, server.URL)
	}
	c := probeConfig(t, checks)
	e := New(func() *config.Config { return c }, func() []hosts.Envelope { return nil })
	e.Start(t.Context(), nil)
	defer e.Close()
	eventually(t, func() bool { return active.Load() == 4 })
	for i := 0; i < 20; i++ {
		if _, err := e.CheckNow("a"); err != nil {
			t.Fatal(err)
		}
	}
	if peak.Load() != 4 || calls.Load() != 4 {
		t.Fatalf("unbounded/duplicate work: peak %d calls %d", peak.Load(), calls.Load())
	}
	release <- struct{}{}
	release <- struct{}{}
	release <- struct{}{}
	release <- struct{}{}
	eventually(t, func() bool { return calls.Load() == 8 })
	if peak.Load() > 4 {
		t.Fatal(peak.Load())
	}
}

func TestEngineRejectsOldGenerationAndCancelsShutdown(t *testing.T) {
	canceled := make(chan struct{}, 2)
	entered := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-r.Context().Done()
		canceled <- struct{}{}
	}))
	defer server.Close()
	old := probeConfig(t, fmt.Sprintf("      c: {service: db, check: {type: http, url: '%s', timeout: 30s}}\n", server.URL))
	var source atomic.Pointer[config.Config]
	source.Store(old)
	e := New(source.Load, func() []hosts.Envelope { return nil })
	e.Start(t.Context(), nil)
	defer e.Close()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("not started")
	}
	next := probeConfig(t, "      c: {service: db, check: {type: command, command: 'exit 1'}}\n")
	source.Store(next)
	if v := e.Views()[0].Members[0].Checks[0]; v.State != "unknown" {
		t.Fatalf("stale generation leaked: %+v", v)
	}
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("old request not canceled")
	}
	if _, err := e.CheckNow("a"); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return e.Views()[0].Members[0].Checks[0].State == "blocked" })
	source.Store(old)
	e.CheckNow("a")
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("new request not started")
	}
	done := make(chan struct{})
	go func() { e.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown did not cancel check")
	}
}

func TestRealProbeResultsTimeoutAndDiagnosticsStayPrivate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401); w.Write([]byte("SECRET-BODY")) }))
	defer server.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	c := probeConfig(t, fmt.Sprintf(`      http: {service: db, check: {type: http, url: '%s?token=SECRET-URL'}}
      tcp: {service: db, check: {type: tcp, host: 127.0.0.1, port: %d}}
      success: {service: db, check: {type: command, command: 'printf SECRET-OUTPUT; exit 0'}}
      failure: {service: db, check: {type: command, command: 'printf SECRET-OUTPUT >&2; exit 1'}}
      timeout: {service: db, check: {type: command, command: 'sleep 30', timeout: 50ms}}
`, server.URL, port))
	e := New(func() *config.Config { return c }, func() []hosts.Envelope { return nil })
	e.Start(t.Context(), nil)
	defer e.Close()
	eventually(t, func() bool {
		for _, p := range e.Views()[0].Members[0].Checks {
			if p.State == "unknown" {
				return false
			}
		}
		return true
	})
	v := e.Views()[0]
	states := map[string]string{}
	reasons := map[string]string{}
	for _, p := range v.Members[0].Checks {
		states[p.ID] = p.State
		reasons[p.ID] = p.Reason
	}
	if states["tcp"] != "ready" || states["success"] != "ready" || states["failure"] != "blocked" || reasons["http"] != "HTTP returned 401" || reasons["timeout"] != "Check timed out" {
		t.Fatalf("%v %v", states, reasons)
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "SECRET") || strings.Contains(string(b), "sleep 30") {
		t.Fatal(string(b))
	}
	if _, err := e.CheckNow("missing"); err == nil {
		t.Fatal("scheduled unknown workspace")
	}
	e.Close()
	if _, err := e.CheckNow("a"); err == nil {
		t.Fatal("scheduled after shutdown")
	}
}
