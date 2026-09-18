package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"localdesk/internal/config"
	"localdesk/internal/manager"
	"localdesk/internal/storage"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestAuthenticationOriginAndHost(t *testing.T) {
	dir := t.TempDir()
	c, e := config.Parse([]byte(config.Sample), dir)
	if e != nil {
		t.Fatal(e)
	}
	db, e := storage.Open(filepath.Join(dir, "state.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Close()
	m := manager.New(c, filepath.Join(dir, "config.yml"), dir, db)
	s := Server{Manager: m, Address: "127.0.0.1:49152", Token: "secret", Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}}
	for _, tc := range []struct {
		host, origin, token, path, method, header string
		want                                      int
	}{{"127.0.0.1:49152", "", "", "/api/apps", "GET", "", 401}, {"evil.example", "", "secret", "/api/apps", "GET", "", 403}, {"127.0.0.1:49152", "http://evil.example", "secret", "/api/apps", "GET", "", 403}, {"127.0.0.1:49152", "", "secret", "/api/apps", "GET", "", 200}, {"127.0.0.1:49152", "", "secret", "/api/actions/stop", "POST", "", 403}, {"127.0.0.1:49152", "", "secret", "/api/actions/stop", "POST", "1", 400}} {
		r := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Authorization", "Bearer "+tc.token)
		r.Header.Set("X-LocalDesk", tc.header)
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("%+v: status %d body %s", tc, w.Code, w.Body.String())
		}
	}
	_ = http.MethodGet
}

func TestConfigSaveRejectsStaleRevision(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	os.WriteFile(path, []byte(config.Sample), 0600)
	c, e := config.Load(path)
	if e != nil {
		t.Fatal(e)
	}
	db, e := storage.Open(filepath.Join(dir, "state.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Close()
	s := Server{Manager: manager.New(c, path, dir, db)}
	original := []byte(config.Sample)
	changed := []byte(config.Sample + "\n# edited externally\n")
	os.WriteFile(path, changed, 0600)
	body, _ := json.Marshal(map[string]string{"yaml": config.Sample, "revision": fmt.Sprintf("%x", sha256.Sum256(original))})
	req := httptest.NewRequest("POST", "/api/config/save", bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.save(w, req)
	if w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, changed) {
		t.Fatal("overwrote external changes")
	}
}

func TestConfigSaveRestoresFileWhenReloadIsRejected(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	original := []byte(config.Sample)
	if err := os.WriteFile(path, original, 0600); err != nil {
		t.Fatal(err)
	}
	c, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	s := Server{Manager: manager.New(c, path, dir, db)}
	changed := strings.Replace(string(original), "port: 49152", "port: 49153", 1)
	body, err := json.Marshal(map[string]string{"yaml": changed, "revision": fmt.Sprintf("%x", sha256.Sum256(original))})
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	s.save(w, httptest.NewRequest(http.MethodPost, "/api/config/save", bytes.NewReader(body)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status %d body %s", w.Code, w.Body.String())
	}
	actual, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, original) {
		t.Fatal("rejected configuration was left on disk")
	}
	if s.Manager.Error() != "" {
		t.Fatalf("restored configuration remained in error: %s", s.Manager.Error())
	}
}

func TestDiscoverTaskFiles(t *testing.T) {
	for _, filename := range []string{"Justfile", "justfile", ".justfile", "Makefile", "makefile", "GNUmakefile"} {
		t.Run(filename, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, filename), []byte("dev:\n\techo development\n"), 0600); err != nil {
				t.Fatal(err)
			}
			body, err := json.Marshal(map[string]string{"path": dir})
			if err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			(&Server{}).discover(w, httptest.NewRequest("POST", "/api/discover", bytes.NewReader(body)))
			if w.Code != http.StatusOK {
				t.Fatal(w.Code, w.Body.String())
			}
			var result struct {
				Suggestions []Suggestion `json:"suggestions"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			command := "make"
			if filename == "Justfile" || filename == "justfile" || filename == ".justfile" {
				command = "just"
			}
			want := Suggestion{Path: dir, Type: "process", Command: command, Indicator: filename, Name: filepath.Base(dir)}
			if len(result.Suggestions) != 1 || result.Suggestions[0] != want {
				t.Fatalf("got %+v, want %+v", result.Suggestions, want)
			}
		})
	}
}
