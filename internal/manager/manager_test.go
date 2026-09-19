package manager

import (
	"context"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/runner"
	"github.com/bhujelaayushgc/stakl/internal/storage"
	"github.com/bhujelaayushgc/stakl/internal/supervisor"
	"os"
	"path/filepath"
	"testing"
	"time"
)

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
