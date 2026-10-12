package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProcessDirectoryReadsCurrentProcess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	got := processDirectory(ctx, os.Getpid())
	if !samePath(wd, got) {
		t.Fatalf("got %q, want %q", got, wd)
	}
}

func systemRequest(t *testing.T, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	s := &Server{Address: "127.0.0.1:4000", Token: "admin"}
	r := httptest.NewRequest(method, "http://127.0.0.1:4000"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("X-Stakl", "1")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func fakeObservationTools(t *testing.T, dir string, containers []map[string]any) {
	t.Helper()
	tools := t.TempDir()
	// docker inspect's format emits one JSON object per container.
	var lines []string
	for _, c := range containers {
		b, _ := json.Marshal(c)
		lines = append(lines, string(b))
	}
	if err := os.WriteFile(filepath.Join(tools, "containers"), []byte(strings.Join(lines, "\n")), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OBSERVE_FIXTURE", filepath.Join(tools, "containers"))
	t.Setenv("OBSERVE_CWD", dir)
	for name, script := range map[string]string{
		"docker": "#!/bin/sh\ncase \"$1\" in\nps) printf 'abc123\\n';;\ninspect) /bin/cat \"$OBSERVE_FIXTURE\";;\n*) exit 1;;\nesac\n",
		"lsof":   "#!/bin/sh\ncase \"$*\" in\n*'-d cwd'*) printf 'p99999999\\nn%s\\n' \"$OBSERVE_CWD\";;\n*) printf 'p99999999\\ng40\\ncnode\\nn127.0.0.1:3000\\n';;\nesac\n",
	} {
		if err := os.WriteFile(filepath.Join(tools, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", tools)
}

func composeFixture(dir, project, filename, address string) map[string]any {
	return map[string]any{
		"labels": map[string]string{
			"com.docker.compose.project":              project,
			"com.docker.compose.project.working_dir":  dir,
			"com.docker.compose.project.config_files": filepath.Join(dir, filename),
		},
		"ports": map[string]any{"80/tcp": []map[string]string{{"HostIp": address, "HostPort": "3000"}}},
	}
}

func TestObservationAutofillsExistingComposeMetadata(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "custom.yaml"), []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	fakeObservationTools(t, dir, []map[string]any{composeFixture(dir, "actual-project", "custom.yaml", "0.0.0.0")})
	for _, body := range []string{
		fmt.Sprintf(`{"path":%q,"indicator":"custom.yaml"}`, dir),
		`{"pid":99999999,"pgid":40,"process":"node","protocol":"TCP","address":"127.0.0.1","port":3000}`,
	} {
		w := systemRequest(t, "POST", "/api/system/observe", body, "admin")
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
		var result struct {
			Cwd    string
			Docker struct {
				ComposeFile string `json:"compose_file"`
				ProjectName string `json:"project_name"`
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Cwd != dir || result.Docker.ComposeFile != filepath.Join(dir, "custom.yaml") || result.Docker.ProjectName != "actual-project" {
			t.Fatalf("incorrect metadata: %s", w.Body.String())
		}
	}
}

func TestObservationDoesNotGuessAmbiguousOrInaccessibleComposeProjects(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "compose.yml"), []byte("services: {}"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, containers := range [][]map[string]any{
		{composeFixture(dir, "one", "compose.yml", "0.0.0.0"), composeFixture(dir, "two", "compose.yml", "0.0.0.0")},
		{composeFixture(dir, "missing", "missing.yml", "0.0.0.0")},
		{composeFixture(dir, "multiple", "compose.yml,override.yml", "0.0.0.0")},
	} {
		fakeObservationTools(t, dir, containers)
		w := systemRequest(t, "POST", "/api/system/observe", fmt.Sprintf(`{"path":%q,"indicator":"compose.yml"}`, dir), "admin")
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 200 || result["docker"] != nil || result["warning"] == "" {
			t.Fatalf("unsafe metadata: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestObservationKeepsProcessDirectoryWithoutDocker(t *testing.T) {
	dir := t.TempDir()
	fakeObservationTools(t, dir, nil)
	w := systemRequest(t, "POST", "/api/system/observe", `{"pid":99999999,"pgid":40,"process":"node","protocol":"TCP","address":"127.0.0.1","port":3000}`, "admin")
	var result struct{ Cwd string }
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || result.Cwd != dir {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	// A stale listener must not reuse the PID's unrelated directory.
	w = systemRequest(t, "POST", "/api/system/observe", `{"pid":99999999,"protocol":"TCP","address":"127.0.0.1","port":3001}`, "admin")
	if strings.Contains(w.Body.String(), dir) {
		t.Fatalf("stale listener used directory: %s", w.Body.String())
	}
}

func TestObservationValidatesSourceAndRequiresAdmin(t *testing.T) {
	for _, body := range []string{`{}`, `{"pid":-1}`, `{"pid":99999999,"protocol":"UDP","port":3000}`, `{"path":"/tmp","pid":99999999}`} {
		if w := systemRequest(t, "POST", "/api/system/observe", body, "admin"); w.Code != 400 {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
	if w := systemRequest(t, "POST", "/api/system/observe", `{}`, "peer-token"); w.Code != 401 {
		t.Fatal(w.Code)
	}
}

func TestComposeWildcardMatchingRequiresCompatibleAddressFamily(t *testing.T) {
	var project composeObservation
	b, _ := json.Marshal(composeFixture("/projects", "stack", "compose.yml", "0.0.0.0"))
	if err := json.Unmarshal(b, &project); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		address, family string
		want            bool
	}{
		{"*", "IPv4", true}, {"*", "IPv6", false}, {"*", "", false},
		{"127.0.0.1", "IPv4", true}, {"[::1]", "IPv6", false},
	} {
		// Decode the future family field so this test can fail against the existing type.
		var source observationSource
		input, _ := json.Marshal(map[string]any{"address": test.address, "family": test.family, "port": 3000, "protocol": "TCP"})
		if err := json.Unmarshal(input, &source); err != nil {
			t.Fatal(err)
		}
		if got := project.matches(source); got != test.want {
			t.Errorf("%s %s: got %v, want %v", test.address, test.family, got, test.want)
		}
	}
}

func TestObservationExplainsUnavailableMetadata(t *testing.T) {
	fakeObservationTools(t, t.TempDir(), nil)
	t.Setenv("OBSERVE_CWD", "/does-not-exist")
	if err := os.Remove(filepath.Join(os.Getenv("PATH"), "docker")); err != nil {
		t.Fatal(err)
	}
	w := systemRequest(t, "POST", "/api/system/observe", `{"pid":99999999,"protocol":"TCP","address":"127.0.0.1","port":3000}`, "admin")
	var result struct{ Cwd, Warning string }
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || result.Cwd != "" || !strings.Contains(result.Warning, "working directory") || !strings.Contains(result.Warning, "Docker") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
