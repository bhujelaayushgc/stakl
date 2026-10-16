package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/workspaces"
)

func TestWorkspaceReadsAreAdminOnlyAndSanitized(t *testing.T) {
	s, h := peerFixture(t)
	s.Manager.Config().Workspaces = map[string]config.Workspace{"project": {
		Name: "Project", Services: map[string]config.WorkspaceService{"db": {Controller: "local", App: "missing", Condition: "running", Required: true}},
		Checks: map[string]config.WorkspaceProbe{"query": {Name: "Database query", Service: "db", EnvFile: []string{"private-credentials"}, Check: config.WorkspaceCheck{Type: "command", Command: "secret-command"}}},
	}}
	_, token := issuePeer(t, h, "control")
	for _, path := range []string{"/api/workspaces", "/api/workspaces/project", "/api/workspaces/impact?controller=local&app=missing"} {
		for _, credential := range []string{"", token} {
			w := peerRequest(h, "GET", path, credential, "", "")
			if w.Code != 401 {
				t.Fatalf("%s accepted peer: %d", path, w.Code)
			}
		}
		w := peerRequest(h, "GET", path, "admin", "", "")
		if w.Code != 200 || strings.Contains(w.Body.String(), "secret-command") || strings.Contains(w.Body.String(), "private-credentials") {
			t.Fatalf("unsafe response: %d %s", w.Code, w.Body.String())
		}
	}
	w := peerRequest(h, "GET", "/api/workspaces/project", "admin", "", "")
	var v workspaces.View
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	if v.State != "unknown" || len(v.Members) != 1 || v.Members[0].App != "missing" {
		t.Fatalf("%+v", v)
	}
	for _, path := range []string{"/api/workspaces/nope", "/api/workspaces/impact?controller=URL&app=missing"} {
		w := peerRequest(h, "GET", path, "admin", "", "")
		if w.Code == http.StatusOK {
			t.Fatal(path)
		}
	}
}

func TestWorkspaceCheckSchedulesOnlyConfiguredAdminProbes(t *testing.T) {
	s, h := peerFixture(t)
	c, err := config.Parse([]byte(`version: 1
apps: {}
workspaces:
  project:
    name: Project
    services: {db: {controller: local, app: missing}}
    checks:
      query: {service: db, check: {type: command, command: 'touch workspace-checked'}}
`), s.Manager.Dir)
	if err != nil {
		t.Fatal(err)
	}
	s.Manager.Config().Workspaces = c.Workspaces
	s.Workspaces.Start(t.Context(), s.Manager.Bus)
	t.Cleanup(s.Workspaces.Close)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.Workspaces.Views()[0].Members[0].Checks[0].State == "ready" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.Remove(filepath.Join(s.Manager.Dir, "workspace-checked")); err != nil {
		t.Fatal(err)
	}
	_, token := issuePeer(t, h, "control")
	for _, credential := range []string{"", token} {
		if w := peerRequest(h, "POST", "/api/workspaces/project/check", credential, "", ""); w.Code != 401 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w := peerRequest(h, "POST", "/api/workspaces/project/check", "admin", "", `{"command":"touch unconfigured"}`); w.Code != 400 {
		t.Fatal("accepted request-supplied probe", w.Code, w.Body.String())
	}
	w := peerRequest(h, "POST", "/api/workspaces/project/check", "admin", "", "")
	if w.Code != http.StatusAccepted {
		t.Fatal(w.Code, w.Body.String())
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(s.Manager.Dir, "workspace-checked")); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "workspace-checked")); err != nil {
		t.Fatal("configured check did not run")
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "unconfigured")); !os.IsNotExist(err) {
		t.Fatal("arbitrary request command ran")
	}
	v, _ := s.Manager.View("a")
	if v.Runtime.State != "stopped" {
		t.Fatal("probe operated on app", v.Runtime)
	}
	if w := peerRequest(h, "POST", "/api/workspaces/nope/check", "admin", "", ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
}
