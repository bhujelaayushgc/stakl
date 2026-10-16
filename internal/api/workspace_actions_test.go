package api

import (
	"encoding/json"
	"fmt"
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
	"github.com/bhujelaayushgc/stakl/internal/manager"
	"github.com/bhujelaayushgc/stakl/internal/runner"
	"github.com/bhujelaayushgc/stakl/internal/storage"
	"github.com/bhujelaayushgc/stakl/internal/workspaces"
)

const lifecycleConfig = `version: 1
apps:
  a:
    type: custom
    start: {command: 'echo launch >> launches; touch started', shell: true}
    stop: {command: 'rm -f started', shell: true}
    status: {command: 'test -f started', shell: true}
    health: {type: command, command: 'test -f started', interval: 100ms}
  broken:
    type: custom
    start: {command: 'printf PRIVATE-START-OUTPUT >&2; exit 1', shell: true}
    stop: {command: 'exit 0', shell: true}
    status: {command: 'exit 1', shell: true}
  external:
    type: external
    detect: {type: command, command: 'exit 0', interval: 100ms}
workspaces:
  project:
    name: Project
    services:
      a: {controller: local, app: a}
      broken: {controller: local, app: broken, required: false}
      external: {controller: local, app: external}
  other:
    name: Other project
    services: {a: {controller: local, app: a}}
`

func lifecycleFixture(t *testing.T, raw string) (*Server, http.Handler) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	c, err := config.Parse([]byte(raw), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	m := manager.New(c, path, dir, db)
	t.Cleanup(func() { m.Close(); db.DB.Close() })
	s := &Server{Manager: m, Token: "admin", Address: "127.0.0.1:49152", Version: "test"}
	h := s.Handler()
	m.StartWorkers()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		fresh := true
		for _, app := range m.Views() {
			fresh = fresh && !app.ObservedAt.IsZero()
		}
		if fresh {
			return s, h
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("initial service observations did not complete")
	return nil, nil
}

func waitForActionObservation(t *testing.T, s *Server, id string) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		v, ok := s.Manager.View(id)
		if ok && !v.ObservedAt.IsZero() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("service observation did not complete", id)
}

func TestWorkspaceStartSkipsActiveServicesAndReportsIndependentFailures(t *testing.T) {
	s, h := lifecycleFixture(t, lifecycleConfig)
	w := peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}")
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var result WorkspaceOperation
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	for _, member := range result.Results {
		statuses[member.Alias] = member.Status
	}
	if statuses["a"] != "started" || statuses["broken"] != "failed" || statuses["external"] != "already_running" {
		t.Fatal(statuses)
	}
	if strings.Contains(w.Body.String(), "PRIVATE-START-OUTPUT") || strings.Contains(w.Body.String(), "echo launch") {
		t.Fatal("unsafe lifecycle diagnostics", w.Body.String())
	}
	waitForActionObservation(t, s, "a")
	w = peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}")
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	data, err := os.ReadFile(filepath.Join(s.Manager.Dir, "launches"))
	if err != nil || string(data) != "launch\n" {
		t.Fatalf("repeated start duplicated launch: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "started")); err != nil {
		t.Fatal("partial failure rolled back successful service", err)
	}
}

func TestWorkspaceMemberStopRequiresSharedConfirmation(t *testing.T) {
	s, h := lifecycleFixture(t, lifecycleConfig)
	start := peerRequest(h, "POST", "/api/workspaces/project/members/a/start", "admin", "", "{}")
	if start.Code != 200 {
		t.Fatal(start.Code, start.Body.String())
	}
	waitForActionObservation(t, s, "a")
	w := peerRequest(h, "POST", "/api/workspaces/project/members/a/stop", "admin", "", "{}")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "Other project") {
		t.Fatal("shared stop was not guarded", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "started")); err != nil {
		t.Fatal("unconfirmed shared stop changed service")
	}
	w = peerRequest(h, "POST", "/api/workspaces/project/members/a/stop", "admin", "", `{"confirm_shared":true}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"stopped"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "started")); !os.IsNotExist(err) {
		t.Fatal("confirmed stop did not stop service")
	}
}

func TestWorkspaceLifecycleRejectsPeerArbitrarySettingsAndUnavailableMembers(t *testing.T) {
	_, h := lifecycleFixture(t, lifecycleConfig)
	_, peer := issuePeer(t, h, "control")
	for _, path := range []string{"/api/workspaces/project/start", "/api/workspaces/project/members/a/start", "/api/workspaces/project/members/a/stop"} {
		for _, token := range []string{"", peer} {
			if w := peerRequest(h, "POST", path, token, "", "{}"); w.Code != 401 {
				t.Fatal("peer gained workspace control", w.Code)
			}
		}
		for _, body := range []string{`{"app":"a"}`, `{"command":"touch injected"}`, `null`, `[]`, `{"confirm_shared":"yes"}`} {
			if w := peerRequest(h, "POST", path, "admin", "", body); w.Code != 400 {
				t.Fatal("accepted arbitrary settings", path, body, w.Code)
			}
		}
	}
	for _, path := range []string{"/api/workspaces/nope/start", "/api/workspaces/project/members/nope/start"} {
		if w := peerRequest(h, "POST", path, "admin", "", "{}"); w.Code != 404 {
			t.Fatal(path, w.Code)
		}
	}
	if w := peerRequest(h, "POST", "/api/workspaces/project/members/external/start", "admin", "", "{}"); w.Code != 409 {
		t.Fatal("operated on observation-only member", w.Code, w.Body.String())
	}
}

func TestWorkspaceStartRejectsOverlappingRequests(t *testing.T) {
	raw := strings.Replace(lifecycleConfig, "echo launch >> launches; touch started", "touch entered; sleep 0.3; echo launch >> launches; touch started", 1)
	s, h := lifecycleFixture(t, raw)
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}") }()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(s.Manager.Dir, "entered")); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "entered")); err != nil {
		t.Fatal("first action did not enter start command")
	}
	w := peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}")
	if w.Code != 409 || !strings.Contains(w.Body.String(), "already in progress") {
		t.Fatal("overlapping request was accepted", w.Code, w.Body.String())
	}
	if first := <-finished; first.Code != 200 {
		t.Fatal(first.Code, first.Body.String())
	}
}

func TestWorkspaceRemoteControlAndUncertainOutcomes(t *testing.T) {
	for _, tt := range []struct {
		name, access string
		uncertain    bool
		status       string
	}{
		{"control", "control", false, "started"},
		{"read only", "read", false, "skipped"},
		{"uncertain", "control", true, "outcome_unknown"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			peer, ph := peerFixture(t)
			peer.Manager.StartWorkers()
			waitForActionObservation(t, peer, "a")
			_, token := issuePeer(t, ph, tt.access)
			var mutations atomic.Int32
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					mutations.Add(1)
					if tt.uncertain {
						recorder := httptest.NewRecorder()
						networkPeer(ph).ServeHTTP(recorder, r)
						w.Header().Set("Content-Type", "application/json")
						w.Write([]byte("incomplete-response"))
						return
					}
				}
				networkPeer(ph).ServeHTTP(w, r)
			})
			hub, h, _ := hostFixture(t, upstream, token)
			hub.Manager.Config().Workspaces = map[string]config.Workspace{"project": {Name: "Remote project", Services: map[string]config.WorkspaceService{"remote": {Controller: peer.ControllerID, App: "a", Condition: "running", Required: true}}}}
			w := peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}")
			var result WorkspaceOperation
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Results) != 1 || result.Results[0].Status != tt.status {
				t.Fatal(w.Code, w.Body.String())
			}
			want := int32(1)
			if tt.access == "read" {
				want = 0
			}
			if mutations.Load() != want {
				t.Fatalf("unexpected remote attempts: %d, want %d", mutations.Load(), want)
			}
			if tt.access == "read" {
				if _, err := os.Stat(filepath.Join(peer.Manager.Dir, "started")); !os.IsNotExist(err) {
					t.Fatal("read-only peer was started")
				}
			}
		})
	}
}

func TestWorkspaceStartStopsDispatchingAfterConfigChanges(t *testing.T) {
	peer, ph := peerFixture(t)
	peer.Manager.StartWorkers()
	waitForActionObservation(t, peer, "a")
	_, token := issuePeer(t, ph, "control")
	entered, release := make(chan struct{}), make(chan struct{})
	upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			recorder := httptest.NewRecorder()
			networkPeer(ph).ServeHTTP(recorder, r)
			close(entered)
			<-release
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(recorder.Code)
			w.Write(recorder.Body.Bytes())
			return
		}
		networkPeer(ph).ServeHTTP(w, r)
	})
	hub, h, _ := hostFixture(t, upstream, token)
	hub.Manager.Config().Workspaces = map[string]config.Workspace{"project": {Name: "Project", Services: map[string]config.WorkspaceService{
		"a-remote": {Controller: peer.ControllerID, App: "a", Condition: "running", Required: true},
		"z-local":  {Controller: "local", App: "a", Condition: "running", Required: true},
	}}}
	hub.Manager.StartWorkers()
	waitForActionObservation(t, hub, "a")
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() { finished <- peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}") }()
	select {
	case <-entered:
	case <-time.After(4 * time.Second):
		close(release)
		t.Fatal("remote start did not begin")
	}
	raw := fmt.Sprintf(`version: 1
apps:
  a:
    type: custom
    start: {command: 'touch local-started', shell: true}
    stop: {command: 'rm -f local-started', shell: true}
    status: {command: 'test -f local-started', shell: true}
workspaces:
  project:
    name: Project
    services:
      a-remote: {controller: %s, app: a}
      z-local: {controller: local, app: a}
`, peer.ControllerID)
	if err := os.WriteFile(hub.Manager.ConfigPath, []byte(raw), 0600); err != nil {
		close(release)
		t.Fatal(err)
	}
	if err := hub.Manager.Reload(); err != nil {
		close(release)
		t.Fatal(err)
	}
	close(release)
	w := <-finished
	var result WorkspaceOperation
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || len(result.Results) != 2 || result.Results[1].Status != "skipped" {
		t.Fatal(w.Code, w.Body.String())
	}
	for _, name := range []string{"started", "local-started"} {
		if _, err := os.Stat(filepath.Join(hub.Manager.Dir, name)); !os.IsNotExist(err) {
			t.Fatal("operation started a remaining local member after reload", name)
		}
	}
}

func TestWorkspaceActionRejectsStaleVisibleDefinition(t *testing.T) {
	s, h := lifecycleFixture(t, lifecycleConfig)
	w := peerRequest(h, "GET", "/api/workspaces/project", "admin", "", "")
	var original struct {
		Revision string `json:"revision"`
	}
	if json.Unmarshal(w.Body.Bytes(), &original) != nil || original.Revision == "" {
		t.Fatal("workspace view has no action precondition", w.Body.String())
	}
	raw := strings.Replace(lifecycleConfig, "a: {controller: local, app: a}", "a: {controller: local, app: replacement}", 1)
	if err := os.WriteFile(s.Manager.ConfigPath, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.Manager.Reload(); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"revision": original.Revision})
	w = peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", string(body))
	if w.Code != 409 || !strings.Contains(w.Body.String(), "changed") {
		t.Fatal("stale UI definition was accepted", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(s.Manager.Dir, "launches")); !os.IsNotExist(err) {
		t.Fatal("stale definition started services")
	}
}

func TestWorkspaceRemoteUnverifiedLaunchRemainsUncertain(t *testing.T) {
	for _, reported := range []bool{true, false} {
		t.Run(fmt.Sprintf("metadata_%v", reported), func(t *testing.T) {
			peer, ph := peerFixture(t)
			peer.Manager.StartWorkers()
			waitForActionObservation(t, peer, "a")
			_, token := issuePeer(t, ph, "control")
			var mutations atomic.Int32
			var unknown *bool
			if reported {
				value := true
				unknown = &value
			}
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					mutations.Add(1)
					JSON(w, hosts.LifecycleResponse{Info: hosts.Info{ControllerID: peer.ControllerID, Protocol: 1, Access: "control"}, Results: map[string]string{"a": "unverified startup"}, OutcomeUnknown: unknown})
					return
				}
				networkPeer(ph).ServeHTTP(w, r)
			})
			hub, h, _ := hostFixture(t, upstream, token)
			hub.Manager.Config().Workspaces = map[string]config.Workspace{"project": {Name: "Project", Services: map[string]config.WorkspaceService{"a": {Controller: peer.ControllerID, App: "a", Condition: "running", Required: true}}}}
			w := peerRequest(h, "POST", "/api/workspaces/project/start", "admin", "", "{}")
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"status":"outcome_unknown"`) {
				t.Fatal("remote unverified launch was reported as definite failure", w.Code, w.Body.String())
			}
			if mutations.Load() != 1 {
				t.Fatal("uncertain launch was retried", mutations.Load())
			}
		})
	}
}

func TestUnresolvedLocalLaunchIsUncertainInWorkspaceAndPeerResponses(t *testing.T) {
	s, _ := peerFixture(t)
	c := s.Manager.Config()
	if err := s.Manager.Store.Save("a", map[string]any{"Runtime": runner.Runtime{State: "unknown", Launch: "missing-unverified-launch"}, "Effective": c.Apps["a"]}); err != nil {
		t.Fatal(err)
	}
	m := manager.New(c, s.Manager.ConfigPath, s.Manager.Dir, s.Manager.Store)
	t.Cleanup(m.Close)
	server := &Server{Manager: m, Token: "admin", Address: "127.0.0.1:49152", Version: "test"}
	h := server.Handler()
	view, _ := m.View("a")
	if view.Runtime.State != "unknown" || view.Runtime.Launch == "" {
		t.Fatal("fixture did not retain unresolved launch", view.Runtime)
	}
	request := httptest.NewRequest("POST", "http://127.0.0.1/api/workspaces/project/start", nil)
	result := server.dispatchWorkspaceAction(request, c, workspaces.Member{App: "a", Host: &hosts.Description{ID: "local"}}, "start", WorkspaceActionResult{App: "a"})
	if result.Status != "outcome_unknown" {
		t.Fatal("local unknown result became definite failure", result)
	}
	_, token := issuePeer(t, h, "control")
	w := peerRequest(h, "POST", "/api/peer/v1/apps/a/start", token, server.ControllerID, "")
	var response hosts.LifecycleResponse
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response.OutcomeUnknown == nil || !*response.OutcomeUnknown {
		t.Fatal("peer response lost local uncertainty", w.Code, w.Body.String())
	}
}
