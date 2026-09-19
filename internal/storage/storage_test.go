package storage

import (
	"github.com/bhujelaayushgc/stakl/internal/events"
	"path/filepath"
	"testing"
	"time"
)

func TestPersistenceAndRetention(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Save("app", map[string]string{"state": "running"}); e != nil {
		t.Fatal(e)
	}
	s.Event(events.Event{App: "app", Type: "app.started", Time: time.Now()})
	s.Event(events.Event{App: "app", Type: "old", Time: time.Now().Add(-90 * 24 * time.Hour)})
	s.Check("app", Health{Time: time.Now(), OK: true, Latency: 2})
	if e = s.Prune(14); e != nil {
		t.Fatal(e)
	}
	s.DB.Close()
	s, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.DB.Close()
	if len(s.Load()) != 1 || len(s.History("app")) != 1 || len(s.Checks("app")) != 1 {
		t.Fatal("data did not survive reopen or retention failed")
	}
}
