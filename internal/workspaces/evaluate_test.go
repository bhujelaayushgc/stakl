package workspaces

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/runner"
)

const localIdentity = "0123456789abcdef0123456789abcdef"
const peerIdentity = "abcdef0123456789abcdef0123456789"

func fixture(now time.Time) (*config.Config, []hosts.Envelope) {
	c := &config.Config{Workspaces: map[string]config.Workspace{"a": {Name: "A", Services: map[string]config.WorkspaceService{
		"db":    {Controller: "local", App: "db", Condition: "running", Required: true},
		"cache": {Controller: peerIdentity, App: "db", Condition: "running", Required: false},
	}}}}
	app := manager.AppView{Config: config.App{ID: "db", Name: "Database"}, EffectiveConfig: config.App{ID: "db"}, Runtime: runner.Runtime{State: "external"}, ObservedAt: now}
	env := []hosts.Envelope{
		{Host: hosts.Description{ID: "local", ControllerID: localIdentity, State: hosts.StateOnline, Access: "control"}, Apps: []manager.AppView{app}},
		{Host: hosts.Description{ID: "renamed-peer", ControllerID: peerIdentity, State: hosts.StateOnline, Access: "read"}, Apps: []manager.AppView{app}},
	}
	return c, env
}

func TestReadinessPrecedenceAndFreshness(t *testing.T) {
	now := time.Now().UTC()
	cases := []struct {
		name, state, want string
		age               time.Duration
		stale             bool
	}{
		{"fresh", "external", "ready", 0, false},
		{"stopped", "stopped", "blocked", 0, false},
		{"transitional", "starting", "unknown", 0, false},
		{"stale observation", "external", "unknown", 16 * time.Second, false},
		{"future observation", "external", "unknown", -6 * time.Second, false},
		{"stale host", "external", "degraded", 0, true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			c, env := fixture(now)
			env[0].Apps[0].Runtime.State = tt.state
			env[0].Apps[0].ObservedAt = now.Add(-tt.age)
			env[1].Host.Stale = tt.stale
			got := Evaluate(c, env, nil, now)[0]
			if got.State != tt.want {
				t.Fatalf("got %+v, want %s", got, tt.want)
			}
		})
	}
	c, env := fixture(now)
	env[0].Apps[0].Runtime.State = "stopped"
	env[1].Apps[0].ObservedAt = time.Time{}
	if got := Evaluate(c, env, nil, now)[0].State; got != "blocked" {
		t.Fatal(got)
	}
	env[0].Apps[0].ObservedAt = time.Time{}
	if got := Evaluate(c, env, nil, now)[0].State; got != "unknown" {
		t.Fatal(got)
	}
}

func TestHealthyRequiresFreshActualHealthEvidence(t *testing.T) {
	now := time.Now().UTC()
	c, env := fixture(now)
	w := c.Workspaces["a"]
	s := w.Services["db"]
	s.Condition = "healthy"
	w.Services["db"] = s
	env[0].Apps[0].Runtime.Health = "healthy"
	if got := Evaluate(c, env, nil, now)[0].State; got != "unknown" {
		t.Fatal(got)
	}
	env[0].Apps[0].EffectiveConfig.Health = config.Check{Type: "http"}
	env[0].Apps[0].HealthObservation = &manager.HealthObservation{Time: now, OK: false}
	if got := Evaluate(c, env, nil, now)[0].State; got != "blocked" {
		t.Fatal(got)
	}
	env[0].Apps[0].HealthObservation.OK = true
	if got := Evaluate(c, env, nil, now)[0].State; got != "ready" {
		t.Fatal(got)
	}
	env[0].Apps[0].HealthObservation.Time = now.Add(-time.Minute)
	if got := Evaluate(c, env, nil, now)[0].State; got != "unknown" {
		t.Fatal(got)
	}
}

func TestIdentityResolutionDuplicateAndSharedImpact(t *testing.T) {
	now := time.Now().UTC()
	c, env := fixture(now)
	c.Workspaces["b"] = config.Workspace{Name: "B", Services: map[string]config.WorkspaceService{"db": {Controller: localIdentity, App: "db", Required: false}}}
	uses := Impact(c, env, "local", "db")
	if len(uses) != 2 || !uses[0].Required || uses[1].Required {
		t.Fatalf("%+v", uses)
	}
	env[1].Host.ControllerID = "11111111111111111111111111111111"
	v := Evaluate(c, env, nil, now)[0]
	if v.State != "degraded" || v.Members[0].Alias != "cache" || v.Members[0].Host != nil {
		t.Fatalf("%+v", v)
	}
	w := c.Workspaces["a"]
	w.Services["duplicate"] = config.WorkspaceService{Controller: localIdentity, App: "db", Condition: "running", Required: true}
	if got := Evaluate(c, env, nil, now)[0].State; got != "unknown" {
		t.Fatal(got)
	}
}

func TestProbeCannotOverrideUnavailableServiceAndExpires(t *testing.T) {
	now := time.Now().UTC()
	c, env := fixture(now)
	w := c.Workspaces["a"]
	w.Checks = map[string]config.WorkspaceProbe{"login": {Name: "Query", Service: "db", Check: config.WorkspaceCheck{Type: "command", Command: "SECRET", Interval: config.Duration(30 * time.Second)}}}
	c.Workspaces["a"] = w
	results := map[Key]ProbeResult{{Workspace: "a", Probe: "login"}: {CheckedAt: now, OK: true}}
	if got := Evaluate(c, env, results, now)[0].State; got != "ready" {
		t.Fatal(got)
	}
	env[0].Apps[0].Runtime.State = "stopped"
	if got := Evaluate(c, env, results, now)[0].State; got != "blocked" {
		t.Fatal(got)
	}
	env[0].Apps[0].Runtime.State = "external"
	results[Key{"a", "login"}] = ProbeResult{CheckedAt: now.Add(-61 * time.Second), OK: true}
	v := Evaluate(c, env, results, now)[0]
	if v.State != "unknown" {
		t.Fatal(v)
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "SECRET") {
		t.Fatal(string(b))
	}
}
