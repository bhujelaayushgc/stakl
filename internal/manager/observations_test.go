package manager

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

func TestCompletedObservationStartsEmptyAndTracksLatestHealth(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yml")
	raw := `version: 1
apps:
  db:
    type: external
    detect: {type: command, command: 'exit 0'}
    health: {type: command, command: 'exit 0', failure_threshold: 3}
`
	c, err := config.Parse([]byte(raw), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, path, dir, db)
	defer m.cancel()
	v, _ := m.View("db")
	if !v.ObservedAt.IsZero() || v.HealthObservation != nil {
		t.Fatal("invented observation on restart")
	}
	before := time.Now()
	m.refresh("db")
	v, _ = m.View("db")
	if v.ObservedAt.Before(before) || v.HealthObservation == nil || !v.HealthObservation.OK {
		t.Fatalf("missing completed evidence: %+v", v)
	}
	// A single failure does not cross the existing runtime failure threshold,
	// but a workspace must still see the real latest result.
	m.apps["db"].Effective.Health.Command = "exit 1"
	m.apps["db"].LastCheck = time.Time{}
	m.refresh("db")
	v, _ = m.View("db")
	if v.Runtime.Health != "healthy" || v.HealthObservation == nil || v.HealthObservation.OK {
		t.Fatalf("stale health green: %+v", v)
	}
	// A configuration target change invalidates evidence without stopping service.
	if err := os.WriteFile(path, []byte(raw+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	v, _ = m.View("db")
	if !v.ObservedAt.IsZero() || v.HealthObservation != nil {
		t.Fatal("edited target retained old evidence")
	}
}

func TestTransitionalAndRecoveryStatesDoNotCreateObservations(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps: {db: {type: external, detect: {type: command, command: 'exit 0'}}}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.cancel()
	for _, state := range []string{"starting", "stopping"} {
		m.apps["db"].Runtime.State = state
		m.refresh("db")
		v, _ := m.View("db")
		if !v.ObservedAt.IsZero() {
			t.Fatal(state)
		}
	}
	m.apps["db"].Runtime.State = "stopped"
	m.apps["db"].RecoveryError = "cannot verify"
	m.refresh("db")
	v, _ := m.View("db")
	if !v.ObservedAt.IsZero() {
		t.Fatal("recovery fabricated freshness")
	}
}
