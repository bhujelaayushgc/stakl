package workspaces

import (
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
)

func TestMemberActionsRespectFreshnessAccessAndOwnership(t *testing.T) {
	for _, tt := range []struct {
		name, kind, state                           string
		owned, customStop, stale, read, start, stop bool
	}{
		{name: "stopped shell", kind: "shell", state: "stopped", start: true},
		{name: "failed shell", kind: "shell", state: "failed", start: true},
		{name: "owned running", kind: "shell", state: "running", owned: true, stop: true},
		{name: "owned unhealthy", kind: "shell", state: "unhealthy", owned: true, stop: true},
		{name: "external process", kind: "shell", state: "external"},
		{name: "observation stopped", kind: "external", state: "stopped"},
		{name: "observation available", kind: "external", state: "external"},
		{name: "custom stop", kind: "custom", state: "running", customStop: true, stop: true},
		{name: "custom no stop", kind: "custom", state: "running"},
		{name: "starting", kind: "shell", state: "starting", owned: true},
		{name: "stopping", kind: "shell", state: "stopping", owned: true},
		{name: "unknown", kind: "shell", state: "unknown"},
		{name: "stale stopped", kind: "shell", state: "stopped", stale: true},
		{name: "read only stopped", kind: "shell", state: "stopped", read: true},
		{name: "read only running", kind: "shell", state: "running", owned: true, read: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			now := time.Now().UTC()
			c, env := fixture(now)
			a := &env[0].Apps[0]
			a.Config.Type, a.EffectiveConfig.Type = tt.kind, tt.kind
			a.Runtime.State, a.Runtime.Owned = tt.state, tt.owned
			if tt.customStop {
				a.EffectiveConfig.Stop.Command = "stop"
			}
			if tt.stale {
				a.ObservedAt = now.Add(-time.Minute)
			}
			if tt.read {
				env[0].Host.Access = "read"
			}
			m := Evaluate(c, env, nil, now)[0].Members[1]
			if m.Actions.Start != tt.start || m.Actions.Stop != tt.stop {
				t.Fatalf("actions %+v, expected start=%v stop=%v", m.Actions, tt.start, tt.stop)
			}
			if !tt.start && !tt.stop && m.Actions.Reason == "" {
				t.Fatal("disabled controls have no explanation")
			}
		})
	}
}

func TestProjectProbeFailureDoesNotRemoveMemberActions(t *testing.T) {
	now := time.Now().UTC()
	c, env := fixture(now)
	env[0].Apps[0].Config.Type, env[0].Apps[0].EffectiveConfig.Type = "shell", "shell"
	env[0].Apps[0].Runtime.State, env[0].Apps[0].Runtime.Owned = "running", true
	w := c.Workspaces["a"]
	w.Checks = map[string]config.WorkspaceProbe{"query": {Service: "db", Check: config.WorkspaceCheck{Type: "command"}}}
	c.Workspaces["a"] = w
	v := Evaluate(c, env, map[Key]ProbeResult{{"a", "query"}: {CheckedAt: now, OK: false, Message: "Command check failed"}}, now)[0]
	if v.State != "blocked" || !v.Members[1].Actions.Stop {
		t.Fatalf("probe failure removed lifecycle access: %+v", v)
	}
	w.Services["again"] = config.WorkspaceService{Controller: localIdentity, App: "db", Condition: "running", Required: true}
	c.Workspaces["a"] = w
	for _, m := range Evaluate(c, env, nil, now)[0].Members {
		if m.Controller == "local" || m.Controller == localIdentity {
			if m.Actions.Start || m.Actions.Stop {
				t.Fatal("ambiguous member permits a mutation", m)
			}
		}
	}
}
