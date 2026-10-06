package api

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestHostDirectoryBrowserListsFoldersAndResolvesSymlinks(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"projects", ".hidden"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "projects"), filepath.Join(dir, "linked")); err != nil {
		t.Fatal(err)
	}
	w := systemRequest(t, "GET", "/api/system/directories?path="+url.QueryEscape(dir), "", "admin")
	var result struct {
		Path, Parent string
		Directories  []string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	canonical, _ := filepath.EvalSymlinks(dir)
	if w.Code != 200 || result.Path != canonical || result.Parent != filepath.Dir(canonical) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if len(result.Directories) != 3 || result.Directories[0] != ".hidden" || result.Directories[1] != "linked" || result.Directories[2] != "projects" {
		t.Fatal(result.Directories)
	}
	w = systemRequest(t, "GET", "/api/system/directories?path="+url.QueryEscape(filepath.Join(dir, "linked")), "", "admin")
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	for _, path := range []string{filepath.Join(dir, "file.txt"), filepath.Join(dir, "missing")} {
		w = systemRequest(t, "GET", "/api/system/directories?path="+url.QueryEscape(path), "", "admin")
		if w.Code != 400 {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	if w := systemRequest(t, "GET", "/api/system/directories", "", "peer-token"); w.Code != 401 {
		t.Fatal(w.Code)
	}
}
