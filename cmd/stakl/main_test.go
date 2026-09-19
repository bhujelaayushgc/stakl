package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFailedBackupRemovesPartialArchive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yml")
	if e := os.WriteFile(configPath, []byte("version: 1\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "state.db"), []byte("not sqlite"), 0600); e != nil {
		t.Fatal(e)
	}
	if e := backup(configPath, dir); e == nil {
		t.Fatal("invalid database produced a backup")
	}
	archives, e := filepath.Glob(filepath.Join(dir, "backup-*.zip"))
	if e != nil {
		t.Fatal(e)
	}
	if len(archives) != 0 {
		t.Fatalf("failed backup left partial archives: %v", archives)
	}
}
