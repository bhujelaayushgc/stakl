package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/workspaces"
)

func TestWorkspaceReadsAreAdminOnlyAndSanitized(t *testing.T) {
	s, h := peerFixture(t)
	s.Manager.Config().Workspaces = map[string]config.Workspace{"project": {
		Name: "Project", Services: map[string]config.WorkspaceService{"db": {Controller: "local", App: "missing", Condition: "running", Required: true}},
		Checks: map[string]config.WorkspaceProbe{"query": {Name: "Database query", Service: "db", EnvFile: []string{"private-credentials"}, Check: config.WorkspaceCheck{Type: "command", Command: "secret-command"}}},
	}}
	token, _ := issuePeer(t, h, "control")
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
