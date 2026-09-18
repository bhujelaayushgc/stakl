package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"localdesk/internal/config"
	"localdesk/internal/supervisor"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type Runtime struct {
	Launch       string     `json:"launch"`
	PID          int        `json:"pid"`
	PGID         int        `json:"pgid"`
	Owned        bool       `json:"owned"`
	Started      time.Time  `json:"started"`
	Exited       *time.Time `json:"exited,omitempty"`
	ExitCode     *int       `json:"exit_code,omitempty"`
	State        string     `json:"state"`
	Error        string     `json:"error,omitempty"`
	RestartCount int        `json:"restart_count"`
	Health       string     `json:"health"`
	NextRestart  *time.Time `json:"next_restart,omitempty"`
}
type Status struct {
	Running    bool
	External   bool
	Unknown    bool
	State      supervisor.State
	Containers []Container
}
type Container struct {
	Name       string `json:"name"`
	Service    string `json:"service"`
	State      string `json:"state"`
	Health     string `json:"health"`
	Publishers any    `json:"publishers,omitempty"`
}
type Runner interface {
	Start(context.Context, config.App) (Runtime, error)
	Stop(context.Context, config.App, Runtime, bool) error
	Status(context.Context, config.App, Runtime) (Status, error)
	LogCommand(config.App) config.Command
}
type Base struct {
	Dir     string
	Logging config.Logging
}
type Process struct{ Base }
type Compose struct{ Base }
type Custom struct{ Base }

func Registry(dir string, l config.Logging) map[string]Runner {
	b := Base{dir, l}
	p := &Process{b}
	return map[string]Runner{"process": p, "shell": p, "docker-compose": &Compose{b}, "custom": &Custom{b}}
}
func Environment(a config.App) ([]string, error) {
	m := map[string]string{}
	if a.InheritEnv == nil || *a.InheritEnv {
		for _, s := range os.Environ() {
			k, v, _ := strings.Cut(s, "=")
			m[k] = v
		}
	}
	for _, p := range a.EnvFile {
		f, e := os.Open(config.Expand(p, a.Cwd))
		if e != nil {
			return nil, e
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimPrefix(line, "export ")
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				f.Close()
				return nil, fmt.Errorf("env file %s: expected KEY=value", p)
			}
			k = strings.TrimSpace(k)
			v = strings.TrimSpace(v)
			if len(v) >= 2 && (v[0] == '\'' && v[len(v)-1] == '\'' || v[0] == '"' && v[len(v)-1] == '"') {
				v = v[1 : len(v)-1]
			}
			if strings.ContainsAny(k, " \t\x00") || k == "" {
				f.Close()
				return nil, fmt.Errorf("env file %s: invalid variable name", p)
			}
			m[k] = v
		}
		e = sc.Err()
		f.Close()
		if e != nil {
			return nil, e
		}
	}
	for k, v := range a.Env {
		m[k] = v
	}
	keys := []string{}
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := []string{}
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out, nil
}
func (p *Process) Start(ctx context.Context, a config.App) (Runtime, error) {
	env, e := Environment(a)
	if e != nil {
		return Runtime{}, e
	}
	command := a.Start
	if a.Type == "shell" {
		command.Shell = true
	}
	s, st, e := supervisor.Launch(p.Dir, a, command, env, p.Logging)
	r := Runtime{Launch: s.ID, PID: st.PID, PGID: st.PGID, Owned: true, Started: st.Started, State: "running"}
	return r, e
}
func (p *Process) Stop(ctx context.Context, a config.App, r Runtime, force bool) error {
	if !r.Owned || r.Launch == "" {
		return fmt.Errorf("refusing to stop an externally detected or unverified process")
	}
	s, st, verified, e := supervisor.Inspect(p.Dir, r.Launch)
	if !verified {
		return fmt.Errorf("ownership cannot be verified: %w", e)
	}
	if !st.Running {
		return nil
	}
	st, e = supervisor.Query(s, "stop", map[string]bool{"force": force})
	if e == nil && st.Running {
		return fmt.Errorf("workload remains alive after stop escalation; ownership retained for inspection")
	}
	return e
}
func (p *Process) Status(ctx context.Context, a config.App, r Runtime) (Status, error) {
	if r.Launch == "" {
		return Status{}, nil
	}
	_, st, ok, e := supervisor.Inspect(p.Dir, r.Launch)
	if !ok {
		return Status{Unknown: true}, e
	}
	return Status{Running: st.Running, State: st}, nil
}
func (p *Process) LogCommand(a config.App) config.Command { return config.Command{} }

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 1024*1024 {
		left := 1024*1024 - b.Len()
		if len(p) > left {
			p = p[:left]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}
func Run(ctx context.Context, a config.App, c config.Command) (string, error) {
	env, e := Environment(a)
	if e != nil {
		return "", e
	}
	cmd, e := supervisor.Command(c, a, env)
	if e != nil {
		return "", e
	}
	supervisor.Group(cmd)
	var out limitedBuffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	cmd.WaitDelay = time.Second
	if e = cmd.Start(); e != nil {
		return "", e
	}
	done := make(chan struct{})
	var killMu sync.Mutex
	reaped := false
	go func() {
		select {
		case <-ctx.Done():
			killMu.Lock()
			if !reaped {
				_ = supervisor.SignalGroup(cmd.Process.Pid, "KILL")
			}
			killMu.Unlock()
		case <-done:
		}
	}()
	observeErr := supervisor.WaitExited(cmd.Process.Pid)
	killMu.Lock()
	if observeErr == nil {
		_ = supervisor.SignalGroup(cmd.Process.Pid, "KILL")
	}
	e = cmd.Wait()
	reaped = true
	close(done)
	killMu.Unlock()
	if ctx.Err() != nil {
		return out.String(), ctx.Err()
	}
	if e != nil {
		return out.String(), fmt.Errorf("%s (cwd %s): %w\n%s", c.Command, a.Cwd, e, strings.TrimSpace(out.String()))
	}
	return out.String(), nil
}
func ComposeCommand(a config.App, args ...string) config.Command {
	all := []string{"compose", "-f", a.Docker.ComposeFile, "--project-name", a.Docker.ProjectName}
	for _, p := range a.Docker.Profiles {
		all = append(all, "--profile", p)
	}
	for _, p := range a.Docker.EnvFiles {
		all = append(all, "--env-file", p)
	}
	all = append(all, a.Docker.Args...)
	all = append(all, args...)
	return config.Command{Command: "docker", Args: all}
}
func (c *Compose) Start(ctx context.Context, a config.App) (Runtime, error) {
	_, e := Run(ctx, a, ComposeCommand(a, "up", "-d"))
	if e != nil {
		return Runtime{}, fmt.Errorf("Docker Compose could not start; check Docker installation and daemon. %w", e)
	}
	return Runtime{Owned: true, Started: time.Now().UTC(), State: "running"}, nil
}
func (c *Compose) Stop(ctx context.Context, a config.App, r Runtime, force bool) error {
	if !r.Owned {
		return fmt.Errorf("Compose project is external; use Docker directly or explicitly configure custom stop logic")
	}
	args := []string{a.Docker.StopMode, "--timeout", fmt.Sprintf("%d", int(a.Stop.Timeout.Value().Seconds()))}
	if force {
		args = []string{"kill"}
	}
	_, e := Run(ctx, a, ComposeCommand(a, args...))
	return e
}
func (c *Compose) Status(ctx context.Context, a config.App, r Runtime) (Status, error) {
	text, e := Run(ctx, a, ComposeCommand(a, "ps", "--all", "--format", "json"))
	if e != nil {
		return Status{Unknown: true}, e
	}
	containers := []Container{}
	if strings.HasPrefix(strings.TrimSpace(text), "[") {
		e = json.Unmarshal([]byte(text), &containers)
	} else {
		sc := bufio.NewScanner(strings.NewReader(text))
		for sc.Scan() {
			var item Container
			if e = json.Unmarshal(sc.Bytes(), &item); e != nil {
				break
			}
			containers = append(containers, item)
		}
	}
	if e != nil {
		return Status{}, fmt.Errorf("could not parse docker compose ps: %w", e)
	}
	running := false
	for _, v := range containers {
		if v.State == "running" || v.State == "restarting" {
			running = true
		}
	}
	return Status{Running: running, External: running && !r.Owned, Containers: containers}, nil
}
func (c *Compose) LogCommand(a config.App) config.Command {
	return ComposeCommand(a, "logs", "--follow", "--no-color", "--timestamps", "--tail", "200")
}
func (c *Custom) Start(ctx context.Context, a config.App) (Runtime, error) {
	if a.Status.Command == "" {
		return (&Process{c.Base}).Start(ctx, a)
	}
	_, e := Run(ctx, a, a.Start)
	return Runtime{Owned: true, Started: time.Now().UTC(), State: "running"}, e
}
func (c *Custom) Stop(ctx context.Context, a config.App, r Runtime, force bool) error {
	if force && r.Owned && r.Launch != "" {
		return (&Process{c.Base}).Stop(ctx, a, r, true)
	}
	if a.Stop.Command != "" {
		_, e := Run(ctx, a, config.Command{Command: a.Stop.Command, Shell: a.Stop.Shell})
		if e != nil {
			return e
		}
		if !r.Owned || r.Launch == "" {
			return nil
		}
	}
	return (&Process{c.Base}).Stop(ctx, a, r, force)
}
func (c *Custom) Status(ctx context.Context, a config.App, r Runtime) (Status, error) {
	if a.Status.Command != "" {
		_, e := Run(ctx, a, a.Status)
		return Status{Running: e == nil, External: e == nil && !r.Owned}, nil
	}
	return (&Process{c.Base}).Status(ctx, a, r)
}
func (c *Custom) LogCommand(a config.App) config.Command { return a.Logs }
func LogPaths(dir, id string) []string {
	matches, _ := filepath.Glob(filepath.Join(dir, "logs", id+"-*.jsonl"))
	paths := []string{}
	for _, path := range matches {
		suffix := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), id+"-"), ".jsonl")
		if len(suffix) == 24 && !strings.Contains(suffix, "-") {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}

func DockerAvailable() map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "info", "--format", "{{.ServerVersion}}")
	b, e := cmd.CombinedOutput()
	return map[string]any{"available": e == nil, "message": strings.TrimSpace(string(b))}
}
