package manager

import (
	"context"
	"fmt"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/runner"
	"github.com/bhujelaayushgc/stakl/internal/storage"
	"github.com/bhujelaayushgc/stakl/internal/supervisor"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestObservationLifecycleAndDependencies(t *testing.T) {
	dir := t.TempDir()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	raw := fmt.Sprintf("version: 1\napps:\n  db:\n    type: external\n    detect: {type: tcp, port: %d}\n  api:\n    start: {command: unused}\n    depends_on: [db]\n", port)
	c, err := config.Parse([]byte(raw), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.cancel()
	m.refresh("db")
	v, _ := m.View("db")
	if v.Runtime.State != "external" || v.Runtime.Owned || v.Runtime.PID != 0 || v.Runtime.Launch != "" {
		t.Fatalf("observation claimed ownership or missed listener: %+v", v.Runtime)
	}
	for _, state := range []string{"external", "stopped"} {
		m.apps["db"].Runtime.State = state
		for _, action := range []string{"start", "stop", "restart", "kill"} {
			out := m.Operate(context.Background(), action, []string{"db"}, true)
			if !strings.Contains(out["db"], "observation-only") || m.apps["db"].Runtime.State != state {
				t.Fatalf("%s mutated observation or was not refused: %v, %+v", action, out, m.apps["db"].Runtime)
			}
		}
	}
	m.apps["db"].LastCheck = time.Time{}
	m.refresh("db")
	// The API is already running, so this verifies dependency traversal without spawning it.
	m.apps["api"].Runtime.State = "running"
	if out := m.Operate(context.Background(), "start", []string{"api"}, false); out["api"] != "ok" {
		t.Fatalf("available observed dependency blocked managed app: %v", out)
	}
	c.Profiles["stack"] = config.Profile{Name: "Existing stack", Apps: []string{"db", "api"}}
	if out := m.Profile(context.Background(), "stack", "start"); out["api"] != "ok" || out["db"] != "ok" {
		t.Fatalf("profile tried to operate on its observed dependency: %v", out)
	}
	if ids := m.GlobalIDs(false); len(ids) != 1 || ids[0] != "api" {
		t.Fatalf("global operations include observed apps: %v", ids)
	}
	listener.Close()
	m.apps["db"].LastCheck = time.Time{}
	m.refresh("db")
	v, _ = m.View("db")
	if v.Runtime.State != "stopped" || v.Runtime.Owned {
		t.Fatalf("missing service remains detected: %+v", v.Runtime)
	}
}

func TestReloadUpdatesAndRemovesLiveObservation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	raw := "version: 1\napps: {db: {type: external, detect: {type: tcp, port: 5432}}}\n"
	c, err := config.Parse([]byte(raw), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, path, dir, db)
	defer m.cancel()
	m.apps["db"].Runtime.State = "external"
	m.apps["db"].Runtime.Health = "healthy"
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(raw, "5432", "5433")), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	if m.apps["db"].Effective.Detect.Port != 5433 {
		t.Fatal("live observation kept stale detection settings")
	}
	if m.apps["db"].Runtime.Health != "unknown" || Active(m.apps["db"].Runtime) {
		t.Fatal("edited observation retained availability or health from its previous target")
	}
	if err := os.WriteFile(path, []byte("version: 1\napps: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(); err != nil {
		t.Fatalf("cannot remove an observation without stopping its service: %v", err)
	}
}

func TestRefusedObservationDoesNotStartItsDependencies(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps:\n  observed:\n    type: external\n    detect: {type: tcp, port: 5432}\n    depends_on: [worker]\n  worker:\n    start: {command: sleep, args: ['60']}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.cancel()
	defer m.Operate(context.Background(), "stop", []string{"worker"}, true)
	for _, action := range []string{"start", "restart"} {
		out := m.Operate(context.Background(), action, []string{"observed"}, false)
		v, _ := m.View("worker")
		if v.Runtime.State != "stopped" || v.Runtime.Launch != "" || out["worker"] != "" {
			t.Fatalf("refused %s changed a dependency: %v %+v", action, out, v.Runtime)
		}
	}
}

func TestReloadDiscardsPreviousObservationProbe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	started, release := make(chan struct{}), make(chan struct{})
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-release:
			w.WriteHeader(200)
		case <-r.Context().Done():
		}
	}))
	defer old.Close()
	raw := fmt.Sprintf("version: 1\napps: {db: {type: external, detect: {type: http, url: '%s'}}}\n", old.URL)
	c, err := config.Parse([]byte(raw), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, path, dir, db)
	defer m.cancel()
	done := make(chan struct{})
	go func() { m.refresh("db"); close(done) }()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("old probe did not start")
	}
	if err := os.WriteFile(path, []byte(strings.ReplaceAll(raw, old.URL, "http://127.0.0.1:1")), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("probe did not finish")
	}
	v, _ := m.View("db")
	if v.Runtime.State != "stopped" || v.Runtime.Health != "unknown" {
		t.Fatalf("old probe overwrote the edited observation: %+v", v.Runtime)
	}
}

func TestObservationRestartRequiresFreshAvailability(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps: {db: {type: external, detect: {type: tcp, port: 5432}}}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.cancel()
	m.apps["db"].Runtime.State = "external"
	m.apps["db"].Runtime.Health = "healthy"
	m.save("db", m.apps["db"])
	restarted := New(c, m.ConfigPath, dir, db)
	defer restarted.cancel()
	v, _ := restarted.View("db")
	if v.Runtime.State != "stopped" || v.Runtime.Health != "unknown" {
		t.Fatalf("restart trusted a previous availability check: %+v", v.Runtime)
	}
}

type snapshotRunner struct {
	runner.Runner
	status runner.Status
}

func (r *snapshotRunner) Status(context.Context, config.App, runner.Runtime) (runner.Status, error) {
	return r.status, nil
}

func TestRefreshPublishesDetailsWithoutStateChange(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps:\n  a:\n    start: {command: sleep, args: ['60']}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.cancel()
	m.apps["a"].Runtime = runner.Runtime{State: "running", Owned: true}
	fake := &snapshotRunner{Runner: m.registry["process"], status: runner.Status{Running: true}}
	m.registry["process"] = fake
	ch, unsub := m.Bus.Subscribe()
	defer unsub()
	for _, port := range []int{8787, 9000} {
		fake.status.Containers = []runner.Container{{Name: "web", State: "running", Publishers: []int{port}}}
		m.apps["a"].LastCheck = time.Time{}
		m.refresh("a")
		select {
		case e := <-ch:
			view, _ := m.View("a")
			if e.Type != "app.updated" || e.App != "a" || view.Runtime.State != "running" || view.Containers[0].Publishers.([]int)[0] != port {
				t.Fatalf("event %+v did not expose the new snapshot: %+v", e, view)
			}
		default:
			t.Fatal("details changed but no UI update was published")
		}
	}
	m.apps["a"].LastCheck = time.Time{}
	m.refresh("a")
	select {
	case e := <-ch:
		t.Fatalf("unchanged snapshot produced an unnecessary event: %+v", e)
	default:
	}
}

func TestRestartPolicies(t *testing.T) {
	zero, one := 0, 1
	for _, tc := range []struct {
		policy string
		code   *int
		want   bool
	}{{"never", &one, false}, {"always", &zero, true}, {"on-failure", &zero, false}, {"on-failure", &one, true}, {"on-failure", nil, false}} {
		if ShouldRestart(config.Restart{Policy: tc.policy}, tc.code) != tc.want {
			t.Fatal(tc)
		}
	}
	p := config.Restart{Delay: config.Duration(time.Second), Backoff: "exponential"}
	if RestartDelay(p, 3) != 8*time.Second || RestartDelay(p, 100) != 5*time.Minute {
		t.Fatal("backoff bounds")
	}
}
func TestActiveStates(t *testing.T) {
	for _, s := range []string{"running", "healthy", "unhealthy", "external", "starting", "stopping"} {
		if !Active(runner.Runtime{State: s}) {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"stopped", "failed", "unknown"} {
		if Active(runner.Runtime{State: s}) {
			t.Fatal(s)
		}
	}
}

func TestRebootClearsStaleActiveStateBeforeAutostart(t *testing.T) {
	dir := t.TempDir()
	c, e := config.Parse([]byte("version: 1\napps:\n  a:\n    start: {command: sleep, args: ['60']}\n    autostart: true\n"), dir)
	if e != nil {
		t.Fatal(e)
	}
	store, e := storage.Open(filepath.Join(dir, "state.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer store.DB.Close()
	current, e := supervisor.BootID()
	if e != nil {
		t.Fatal(e)
	}
	os.Mkdir(filepath.Join(dir, "launches"), 0700)
	spec := supervisor.Spec{ID: supervisor.Token()[:24], BootID: "previous-" + current, App: c.Apps["a"], Socket: filepath.Join(dir, "missing.sock"), Token: supervisor.Token()}
	supervisor.AtomicJSON(filepath.Join(dir, "launches", spec.ID+".json"), spec)
	store.Save("a", struct {
		Runtime   runner.Runtime
		Effective config.App
	}{runner.Runtime{State: "healthy", Owned: true, Launch: spec.ID}, c.Apps["a"]})
	m := New(c, filepath.Join(dir, "config.yml"), dir, store)
	v, _ := m.View("a")
	if v.Runtime.State != "stopped" || v.Runtime.Owned || v.Runtime.Launch != "" {
		t.Fatalf("autostart would skip stale state: %+v", v.Runtime)
	}
}
