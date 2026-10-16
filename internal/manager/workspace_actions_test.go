package manager

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/runner"
	"github.com/bhujelaayushgc/stakl/internal/storage"
)

type unresolvedStartRunner struct{ runner.Runner }

func (r unresolvedStartRunner) Start(context.Context, config.App) (runner.Runtime, error) {
	return runner.Runtime{Launch: "unverified-launch", Started: time.Now()}, fmt.Errorf("launch could not be verified")
}

func TestUnverifiedLaunchPreservesTypedUncertainOutcome(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps: {a: {type: custom, start: {command: 'touch launched', shell: true}, stop: {command: 'exit 0', shell: true}, status: {command: 'exit 1', shell: true}}}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.Close()
	m.registry["custom"] = unresolvedStartRunner{m.registry["custom"]}
	result, err := m.OperateWithConfig(context.Background(), "start", []string{"a"}, false, c)
	if err != nil || !result.OutcomeUnknown {
		t.Fatalf("unverified launch lost its uncertainty: %+v %v", result, err)
	}
	v, _ := m.View("a")
	if v.Runtime.State != "unknown" || v.Runtime.Launch != "unverified-launch" {
		t.Fatal("unverified launch identity was discarded", v.Runtime)
	}
}

func TestOperateWithConfigRejectsObsoleteGeneration(t *testing.T) {
	dir := t.TempDir()
	c, err := config.Parse([]byte("version: 1\napps: {a: {type: custom, start: {command: 'touch launched', shell: true}, stop: {command: 'exit 0', shell: true}, status: {command: 'exit 1', shell: true}}}\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	m := New(c, filepath.Join(dir, "config.yml"), dir, db)
	defer m.Close()
	if _, err := m.OperateWithConfig(context.Background(), "start", []string{"a"}, false, &config.Config{}); err == nil {
		t.Fatal("obsolete config was accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "launched")); !os.IsNotExist(err) {
		t.Fatal("obsolete generation launched a service")
	}
	if out, err := m.OperateWithConfig(context.Background(), "start", []string{"a"}, false, c); err != nil || out.Results["a"] != "ok" {
		t.Fatal(out, err)
	}
}
