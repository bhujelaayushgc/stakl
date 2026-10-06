package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"

	"github.com/bhujelaayushgc/stakl/internal/config"
)

func (s *Server) directories(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		var err error
		path, err = os.UserHomeDir()
		if err != nil {
			errorJSON(w, err, 500)
			return
		}
	}
	path, err := filepath.Abs(config.Expand(path, ""))
	if err == nil {
		path, err = filepath.EvalSymlinks(path)
	}
	if err != nil || !isDirectory(path) {
		errorJSON(w, fmt.Errorf("directory does not exist or is not accessible"), 400)
		return
	}
	dir, err := os.Open(path)
	if err != nil {
		errorJSON(w, fmt.Errorf("cannot read directory: %w", err), 403)
		return
	}
	defer dir.Close()
	// ponytail: cap at 1,000 entries; add pagination if large folders need full browsing.
	entries, err := dir.ReadDir(1001)
	if err != nil && !errors.Is(err, io.EOF) {
		errorJSON(w, fmt.Errorf("cannot read directory: %w", err), 403)
		return
	}
	truncated := len(entries) > 1000
	if truncated {
		entries = entries[:1000]
	}
	folders := []string{}
	for _, entry := range entries {
		if entry.IsDir() || (entry.Type()&os.ModeSymlink != 0 && isDirectory(filepath.Join(path, entry.Name()))) {
			folders = append(folders, entry.Name())
		}
	}
	sort.Strings(folders)
	parent := filepath.Dir(path)
	if parent == path {
		parent = ""
	}
	JSON(w, map[string]any{"path": path, "parent": parent, "directories": folders, "truncated": truncated})
}
