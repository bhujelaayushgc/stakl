package supervisor

import (
	"fmt"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "__supervise" {
		if Run(os.Args[2]) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func TestOwnedProcessGroupAndRecovery(t *testing.T) {
	dir := t.TempDir()
	a := config.App{ID: "dummy", Type: "process", Cwd: dir, Stop: config.Stop{Signal: "TERM", Timeout: config.Duration(300 * time.Millisecond)}}
	c := config.Command{Command: `trap '' TERM; sleep 60 & echo $! > child.pid; echo hello; echo problem >&2; wait`, Shell: true}
	s, st, e := Launch(dir, a, c, os.Environ(), config.Logging{MaxSizeMB: 1, MaxFiles: 2, RetentionDays: 1})
	if e != nil {
		t.Fatal(e)
	}
	defer Query(s, "stop", map[string]bool{"force": true})
	if !st.Running || st.PID <= 1 || st.PGID != st.PID {
		t.Fatalf("invalid state %+v", st)
	}
	_, recovered, owned, e := Inspect(dir, s.ID)
	if e != nil || !owned || !recovered.Running {
		t.Fatalf("recover: %+v %v", recovered, e)
	}
	wrong := s
	wrong.Token = "wrong"
	if _, e = Query(wrong, "stop", nil); e == nil {
		t.Fatal("unauthenticated stop allowed")
	}
	logs := []Log{}
	logDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(logDeadline) {
		logs = ReadLogs(s.LogPath, 2, 20, 0)
		if len(logs) >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	text := ""
	for _, l := range logs {
		text += l.Stream + ":" + l.Text + "\n"
	}
	if !strings.Contains(text, "stdout:hello") || !strings.Contains(text, "stderr:problem") {
		t.Fatal(text)
	}
	b, e := os.ReadFile(filepath.Join(dir, "child.pid"))
	if e != nil {
		t.Fatal(e)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	st, e = Query(s, "stop", nil)
	if e != nil {
		t.Fatal(e)
	}
	if st.Running {
		t.Fatal("stop returned before exit")
	}
	deadline := time.Now().Add(3 * time.Second)
	for PIDAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(30 * time.Millisecond)
	}
	if PIDAlive(pid) {
		t.Fatalf("child %d survived group stop", pid)
	}
	_, final, verified, e := Inspect(dir, s.ID)
	if e != nil || !verified || final.Exited == nil || !final.Stopped {
		t.Fatalf("final state %+v %v", final, e)
	}
}
func TestNaturalExitCleansChildrenAndPersistsCode(t *testing.T) {
	dir := t.TempDir()
	a := config.App{ID: "exit", Type: "process", Cwd: dir, Stop: config.Stop{Signal: "TERM", Timeout: config.Duration(time.Second)}}
	s, _, e := Launch(dir, a, config.Command{Command: "sleep 60 & echo $! > child.pid; sleep 0.1; exit 7", Shell: true}, os.Environ(), config.Logging{MaxSizeMB: 1, MaxFiles: 1, RetentionDays: 1})
	if e != nil {
		t.Fatal(e)
	}
	defer Query(s, "stop", map[string]bool{"force": true})
	deadline := time.Now().Add(4 * time.Second)
	var st State
	for time.Now().Before(deadline) {
		_, st, _, _ = Inspect(dir, s.ID)
		if st.Exited != nil {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if st.ExitCode == nil || *st.ExitCode != 7 {
		t.Fatalf("exit state %+v", st)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "child.pid"))
	pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	for PIDAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(30 * time.Millisecond)
	}
	if PIDAlive(pid) {
		t.Fatal("orphan process", pid)
	}
}
func TestRotationBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.jsonl")
	w := &logWriter{path: path, policy: config.Logging{MaxSizeMB: 1, MaxFiles: 2, RetentionDays: 1}}
	for i := 0; i < 100; i++ {
		w.write("stdout", fmt.Sprintf("%d:%s", i, strings.Repeat("x", 64000)))
	}
	files, _ := filepath.Glob(path + "*")
	if len(files) > 3 {
		t.Fatal("rotation unbounded", len(files))
	}
	rows := ReadLogs(path, 2, 5, 0)
	if len(rows) != 5 || rows[4].Seq != 100 {
		t.Fatal("tail order", len(rows))
	}
}

func TestCommandUsesApplicationPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "stakl-only-test")
	if e := os.WriteFile(path, []byte("#!/bin/sh\nprintf '%s' \"$VALUE\"\n"), 0700); e != nil {
		t.Fatal(e)
	}
	cmd, e := Command(config.Command{Command: "stakl-only-test"}, config.App{Cwd: dir}, []string{"PATH=" + dir, "VALUE=app-env"})
	if e != nil {
		t.Fatal(e)
	}
	out, e := cmd.Output()
	if e != nil || string(out) != "app-env" {
		t.Fatalf("%q %v", out, e)
	}
}

func TestPriorBootRetiresStaleLaunch(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "launches"), 0700)
	current, e := BootID()
	if e != nil || current == "" {
		t.Fatalf("boot ID: %q %v", current, e)
	}
	spec := Spec{ID: Token()[:24], BootID: "previous-" + current, Socket: filepath.Join(dir, "missing.sock"), Token: Token()}
	if e = AtomicJSON(filepath.Join(dir, "launches", spec.ID+".json"), spec); e != nil {
		t.Fatal(e)
	}
	_, state, verified, e := Inspect(dir, spec.ID)
	if e != nil || !verified || state.Running || !state.Rebooted || !state.Stopped {
		t.Fatalf("previous boot: %+v %v", state, e)
	}
	spec.ID = Token()[:24]
	spec.BootID = current
	AtomicJSON(filepath.Join(dir, "launches", spec.ID+".json"), spec)
	_, _, verified, _ = Inspect(dir, spec.ID)
	if verified {
		t.Fatal("missing supervisor from this boot must remain unverified")
	}
}
