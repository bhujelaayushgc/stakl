package runner

import (
	"context"
	"localdesk/internal/config"
	"localdesk/internal/supervisor"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 2 && os.Args[1] == "__supervise" {
		if supervisor.Run(os.Args[2]) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestEnvironmentPrecedenceAndLiteralValues(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".env"), []byte("# ignored\nexport PORT=1234\nTOKEN='literal $PORT'\n"), 0600)
	inherit := false
	env, e := Environment(config.App{Cwd: dir, EnvFile: []string{".env"}, Env: map[string]string{"PORT": "5678"}, InheritEnv: &inherit})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Join(env, "\n") != "PORT=5678\nTOKEN=literal $PORT" {
		t.Fatal(env)
	}
}
func TestEnvironmentRejectsInvalidNames(t *testing.T) {
	inherit := false
	if _, e := Environment(config.App{Env: map[string]string{"BAD=NAME": "value"}, InheritEnv: &inherit}); e == nil {
		t.Fatal("accepted an invalid environment variable name")
	}
}
func TestFailedProcessStartDoesNotBlockRetry(t *testing.T) {
	dir := t.TempDir()
	p := &Process{Base{Dir: dir, Logging: config.Logging{MaxSizeMB: 1, MaxFiles: 1, RetentionDays: 1}}}
	a := config.App{ID: "broken", Name: "Broken", Cwd: dir, Start: config.Command{Command: "localdesk-command-that-does-not-exist"}, Stop: config.Stop{Timeout: config.Duration(time.Second)}}
	r, e := p.Start(context.Background(), a)
	if e == nil {
		t.Fatal("missing executable started")
	}
	if r.Launch != "" || r.Owned || r.State != "failed" || r.Exited == nil {
		t.Fatalf("failed launch retained unsafe ownership: %+v", r)
	}
}
func TestCommandsAndTimeout(t *testing.T) {
	a := config.App{Cwd: t.TempDir()}
	out, e := Run(context.Background(), a, config.Command{Command: "printf", Args: []string{"%s", "spaces and $literal"}})
	if e != nil || out != "spaces and $literal" {
		t.Fatalf("%q %v", out, e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, e = Run(ctx, a, config.Command{Command: "sleep 20"})
	if e == nil || time.Since(start) > 3*time.Second {
		t.Fatalf("command not bounded: %v", e)
	}
}
func TestComposeArgumentsAndLogIsolation(t *testing.T) {
	a := config.App{Docker: config.Docker{ComposeFile: "a file.yml", ProjectName: "test", Profiles: []string{"dev"}, EnvFiles: []string{".env.local"}}}
	c := ComposeCommand(a, "up", "-d")
	if c.Shell || c.Command != "docker" || c.Args[2] != "a file.yml" || c.Args[len(c.Args)-1] != "-d" {
		t.Fatal(c)
	}
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "logs"), 0700)
	for _, id := range []string{"app", "app-other"} {
		os.WriteFile(filepath.Join(dir, "logs", id+"-"+strings.Repeat("a", 24)+".jsonl"), nil, 0600)
	}
	paths := LogPaths(dir, "app")
	if len(paths) != 1 || strings.Contains(paths[0], "app-other") {
		t.Fatal(paths)
	}
}
