package manager

import (
	"context"
	"encoding/json"
	"fmt"
	"localdesk/internal/config"
	"localdesk/internal/events"
	"localdesk/internal/health"
	"localdesk/internal/runner"
	"localdesk/internal/storage"
	"localdesk/internal/supervisor"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

type AppView struct {
	EffectiveConfig config.App         `json:"effective_config"`
	Config          config.App         `json:"config"`
	Runtime         runner.Runtime     `json:"runtime"`
	Containers      []runner.Container `json:"containers"`
	Ports           map[int]bool       `json:"ports"`
}
type tracked struct {
	Runtime             runner.Runtime
	Effective           config.App
	Containers          []runner.Container
	Ports               map[int]bool
	LastCheck           time.Time
	Failures, Successes int
	LogLaunch           string
	RecoveryError       string
}
type Manager struct {
	mu              sync.RWMutex
	op              sync.Mutex
	cfg             *config.Config
	apps            map[string]*tracked
	registry        map[string]runner.Runner
	Store           *storage.Store
	Bus             *events.Bus
	Dir, ConfigPath string
	ConfigError     string
	ctx             context.Context
	cancel          context.CancelFunc
	wg              sync.WaitGroup
	Notify          func(string, string)
}

func New(c *config.Config, path, dir string, db *storage.Store) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	m := &Manager{cfg: c, apps: map[string]*tracked{}, registry: runner.Registry(dir, c.Logging), Store: db, Bus: events.New(), Dir: dir, ConfigPath: path, ctx: ctx, cancel: cancel}
	saved := db.Load()
	for id, a := range c.Apps {
		t := &tracked{Runtime: runner.Runtime{State: "stopped", Health: "unknown"}, Effective: a, Ports: map[int]bool{}}
		if b, ok := saved[id]; ok {
			var p struct {
				Runtime   runner.Runtime
				Effective config.App
				LogLaunch string
			}
			if json.Unmarshal(b, &p) == nil {
				t.Runtime = p.Runtime
				t.LogLaunch = p.LogLaunch
				if p.Effective.ID != "" {
					t.Effective = p.Effective
				}
			}
		}
		m.apps[id] = t
	}
	// Recover launch intent even if the controller exited between spawn and runtime save.
	paths, _ := filepath.Glob(filepath.Join(dir, "launches", "*.json"))
	for _, path := range paths {
		var spec supervisor.Spec
		b, err := os.ReadFile(path)
		if err != nil || json.Unmarshal(b, &spec) != nil {
			continue
		}
		t, ok := m.apps[spec.App.ID]
		if !ok {
			continue
		}
		_, st, verified, err := supervisor.Inspect(dir, spec.ID)
		if verified && st.Rebooted && t.Runtime.Launch == spec.ID {
			t.Runtime.State = "stopped"
			t.Runtime.Owned = false
			t.Runtime.PID = 0
			t.Runtime.PGID = 0
			t.Runtime.Exited = st.Exited
			t.Runtime.ExitCode = st.ExitCode
			t.Runtime.Health = "unknown"
			t.Runtime.NextRestart = nil
			t.Runtime.Error = ""
			m.Store.Launch(spec.ID, spec.App.ID, t.Runtime.Started, t.Runtime)
			t.Runtime.Launch = ""
		}
		if verified && st.Running {
			if spec.Purpose == "logs" {
				t.LogLaunch = spec.ID
				continue
			}
			if t.Runtime.Launch != "" && t.Runtime.Launch != spec.ID {
				t.Runtime.State = "unknown"
				t.RecoveryError = "Multiple active launches found; inspect launch records before operating"
				t.Runtime.Error = t.RecoveryError
				continue
			}
			t.Runtime.Launch = spec.ID
			t.Runtime.PID = st.PID
			t.Runtime.PGID = st.PGID
			t.Runtime.Started = st.Started
			t.Runtime.Owned = true
			t.Runtime.State = "running"
			t.Effective = spec.App
		} else if !verified && spec.Purpose != "logs" && (t.Runtime.Launch == spec.ID || t.Runtime.Launch == "") {
			t.Runtime.State = "unknown"
			t.Runtime.Launch = spec.ID
			t.Runtime.Error = fmt.Sprintf("Supervisor ownership cannot be verified: %v", err)
		}
	}
	for id, t := range m.apps {
		if t.RecoveryError != "" {
			t.Runtime.State = "unknown"
			t.Runtime.Error = t.RecoveryError
		}
		if t.Runtime.Launch == "" && !Active(t.Runtime) {
			t.Effective = c.Apps[id]
		}
		if (t.Runtime.State == "starting" || t.Runtime.State == "stopping") && t.Runtime.Launch == "" {
			t.Runtime.State = "stopped"
		}
		m.save(id, t)
	}
	return m
}
func (m *Manager) Config() *config.Config { m.mu.RLock(); defer m.mu.RUnlock(); return m.cfg }
func (m *Manager) Error() string          { m.mu.RLock(); defer m.mu.RUnlock(); return m.ConfigError }
func (m *Manager) save(id string, t *tracked) {
	if t.Runtime.Launch != "" {
		if e := m.Store.Launch(t.Runtime.Launch, id, t.Runtime.Started, t.Runtime); e != nil {
			log.Printf("persist launch %s: %v", id, e)
		}
	}
	if e := m.Store.Save(id, struct {
		Runtime   runner.Runtime
		Effective config.App
		LogLaunch string
	}{t.Runtime, t.Effective, t.LogLaunch}); e != nil {
		log.Printf("persist %s: %v", id, e)
	}
}
func (m *Manager) event(kind, id, message string) {
	e := events.Event{Type: kind, App: id, Message: message, Time: time.Now().UTC()}
	if err := m.Store.Event(e); err != nil {
		log.Printf("persist event: %v", err)
	}
	m.Bus.Publish(e)
	if strings.Contains(kind, "failed") || kind == "app.restart.exhausted" {
		c := m.Config()
		a, ok := c.Apps[id]
		enabled := c.Notifications
		if ok && a.Notifications != nil {
			enabled = *a.Notifications
		}
		if enabled && m.Notify != nil {
			go m.Notify("LocalDesk", message)
		}
	}
}
func (m *Manager) Views() []AppView {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []AppView{}
	for _, id := range m.cfg.IDs() {
		a := m.cfg.Apps[id]
		t := m.apps[id]
		ports := map[int]bool{}
		for p, open := range t.Ports {
			ports[p] = open
		}
		out = append(out, AppView{Config: config.Redacted(a), EffectiveConfig: config.Redacted(t.Effective), Runtime: t.Runtime, Containers: append([]runner.Container{}, t.Containers...), Ports: ports})
	}
	return out
}
func (m *Manager) View(id string) (AppView, bool) {
	for _, v := range m.Views() {
		if v.Config.ID == id {
			return v, true
		}
	}
	return AppView{}, false
}
func Active(r runner.Runtime) bool {
	switch r.State {
	case "starting", "running", "healthy", "unhealthy", "external", "stopping":
		return true
	}
	return false
}
func (m *Manager) StartWorkers() {
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.refreshAll()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		lastPrune := time.Time{}
		for {
			select {
			case <-m.ctx.Done():
				return
			case <-ticker.C:
				m.refreshAll()
				if time.Since(lastPrune) > time.Minute {
					m.Store.Prune(m.Config().Logging.RetentionDays)
					m.pruneLogs()
					lastPrune = time.Now()
				}
			}
		}
	}()
	m.wg.Add(1)
	go func() { defer m.wg.Done(); m.autostart() }()
}
func (m *Manager) autostart() {
	c := m.Config()
	type item struct {
		ids   []string
		delay time.Duration
	}
	items := []item{}
	for id, a := range c.Apps {
		if a.Autostart.Enabled {
			items = append(items, item{[]string{id}, a.Autostart.Delay.Value()})
		}
	}
	for _, p := range c.Profiles {
		if p.Autostart.Enabled {
			items = append(items, item{p.Apps, p.Autostart.Delay.Value()})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].delay < items[j].delay })
	start := time.Now()
	for _, i := range items {
		wait := i.delay - time.Since(start)
		if wait > 0 {
			select {
			case <-m.ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		m.Operate(m.ctx, "start", i.ids, false)
	}
}
func (m *Manager) refreshAll() {
	for _, id := range m.Config().IDs() {
		if m.ctx.Err() != nil {
			return
		}
		m.refresh(id)
	}
}
func (m *Manager) refresh(id string) {
	m.mu.RLock()
	t, ok := m.apps[id]
	if !ok {
		m.mu.RUnlock()
		return
	}
	if t.RecoveryError != "" {
		m.mu.RUnlock()
		return
	}
	a := t.Effective
	r := t.Runtime
	last := t.LastCheck
	reg := m.registry[a.Type]
	m.mu.RUnlock()
	if r.State == "starting" || r.State == "stopping" {
		return
	}
	interval := a.Health.Interval.Value()
	if interval == 0 {
		interval = a.Detect.Interval.Value()
	}
	if interval == 0 {
		interval = 5 * time.Second
	}
	if time.Since(last) < interval {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
	defer cancel()
	st, e := reg.Status(ctx, a, r)
	if st.State.ExitCode != nil && *st.State.ExitCode != 0 && !st.State.Stopped && r.Launch != "" {
		stderr := []string{}
		if spec, err := supervisor.LoadSpec(m.Dir, r.Launch); err == nil {
			for _, line := range supervisor.ReadLogs(spec.LogPath, m.Config().Logging.MaxFiles, 20, 0) {
				if line.Stream == "stderr" {
					stderr = append(stderr, line.Text)
				}
			}
		}
		st.State.Error = fmt.Sprintf("%s exited with code %d.\nCommand: %s\nWorking directory: %s", a.Name, *st.State.ExitCode, a.Start.Command, a.Cwd)
		if len(stderr) > 0 {
			st.State.Error += "\nstderr:\n" + strings.Join(stderr, "\n")
		}
	}
	running := st.Running
	external := st.External
	if !running && r.Launch == "" && a.Detect.Type != "" {
		h := health.Check(ctx, a.Detect, a, r, nil)
		running = h.OK
		external = h.OK
	}
	if st.Unknown && a.Detect.Type != "" {
		h := health.Check(ctx, a.Detect, a, r, nil)
		if h.OK {
			running = true
			external = true
		}
	}
	newState := "stopped"
	if running {
		newState = "running"
	}
	if external {
		newState = "external"
	}
	if st.Unknown && !running {
		newState = "unknown"
	}
	var h *storage.Health
	if running && a.Health.Type != "" && (r.Started.IsZero() || time.Since(r.Started) >= a.Health.InitialDelay.Value()) {
		v := health.Check(ctx, a.Health, a, r, st.Containers)
		h = &v
		m.Store.Check(id, v)
	}
	ports := map[int]bool{}
	for _, p := range a.Ports {
		ports[p.Port] = health.Check(ctx, config.Check{Type: "tcp", Host: "127.0.0.1", Port: p.Port, Timeout: config.Duration(300 * time.Millisecond)}, a, r, nil).OK
	}
	m.mu.Lock()
	t, ok = m.apps[id]
	if !ok || t.Runtime.Launch != r.Launch || t.Runtime.State != r.State {
		m.mu.Unlock()
		return
	}
	oldState := t.Runtime.State
	detailsChanged := !reflect.DeepEqual(t.Containers, st.Containers) || !reflect.DeepEqual(t.Ports, ports)
	t.LastCheck = time.Now()
	t.Containers = st.Containers
	t.Ports = ports
	t.Runtime.State = newState
	if external {
		t.Runtime.Owned = false
	}
	if st.State.ID != "" {
		t.Runtime.Owned = st.State.Running
		t.Runtime.PID = st.State.PID
		t.Runtime.PGID = st.State.PGID
		t.Runtime.Exited = st.State.Exited
		t.Runtime.ExitCode = st.State.ExitCode
		if !st.State.Running {
			t.Runtime.PID = 0
			t.Runtime.PGID = 0
			t.Runtime.Owned = false
		}
	}
	healthChanged := ""
	if h != nil {
		oldHealth := t.Runtime.Health
		if h.OK {
			t.Successes++
			t.Failures = 0
			if t.Successes >= a.Health.SuccessThreshold {
				t.Runtime.Health = "healthy"
				t.Runtime.Error = ""
			}
		} else {
			t.Failures++
			t.Successes = 0
			if t.Failures >= a.Health.FailureThreshold {
				t.Runtime.Health = "unhealthy"
				t.Runtime.Error = h.Message
			}
		}
		if !external && (t.Runtime.Health == "healthy" || t.Runtime.Health == "unhealthy") {
			t.Runtime.State = t.Runtime.Health
		}
		if oldHealth != t.Runtime.Health {
			healthChanged = t.Runtime.Health
		}
	}
	if e != nil {
		t.Runtime.Error = e.Error()
	} else if running && a.Health.Type == "" {
		t.Runtime.Error = ""
	}
	daemonExit := r.Launch == "" && r.Owned && Active(r) && !running && !st.Unknown
	if daemonExit {
		now := time.Now().UTC()
		code := 1
		st.State.Exited = &now
		st.State.ExitCode = &code
		st.State.Error = "Managed service stopped unexpectedly"
		t.Runtime.Exited = &now
		t.Runtime.ExitCode = &code
		t.Runtime.Owned = false
	}
	exited := (r.Launch != "" && st.State.Exited != nil && !running) || daemonExit
	if exited {
		t.Runtime.Launch = ""
		t.Runtime.Health = "unknown"
		t.Failures = 0
		t.Successes = 0
		if st.State.ExitCode != nil && *st.State.ExitCode != 0 && !st.State.Stopped {
			t.Runtime.State = "failed"
			t.Runtime.Error = st.State.Error
		}
		if !st.State.Stopped && ShouldRestart(a.Restart, st.State.ExitCode) {
			if t.Runtime.RestartCount < a.Restart.MaxAttempts {
				delay := RestartDelay(a.Restart, t.Runtime.RestartCount)
				next := time.Now().Add(delay)
				t.Runtime.NextRestart = &next
			} else {
				t.Runtime.State = "failed"
				t.Runtime.Error = "Restart limit reached; start manually to reset attempts"
			}
		}
	}
	if !running && oldState == "failed" && !exited {
		t.Runtime.State = "failed"
	}
	if exited && r.Launch != "" {
		m.Store.Launch(r.Launch, id, t.Runtime.Started, t.Runtime)
	}
	next := t.Runtime.NextRestart
	changed := oldState != t.Runtime.State
	final := t.Runtime.State
	finalError := t.Runtime.Error
	viewChanged := detailsChanged || !reflect.DeepEqual(r, t.Runtime)
	if changed || exited || healthChanged != "" {
		m.save(id, t)
	}
	m.mu.Unlock()
	if viewChanged {
		m.Bus.Publish(events.Event{Type: "app.updated", App: id, Time: time.Now().UTC()})
	}
	if h != nil {
		m.Bus.Publish(events.Event{Type: "app.health.checked", App: id, Time: time.Now().UTC()})
	}
	if changed {
		kind := "app." + final
		message := a.Name + ": " + final
		if final == "external" {
			kind = "app.external.detected"
		}
		if final == "failed" && finalError != "" {
			message += "\n" + finalError
		}
		m.event(kind, id, message)
	}
	if healthChanged != "" {
		kind := "app.health.changed"
		if healthChanged == "unhealthy" {
			kind = "app.health.failed"
		}
		m.event(kind, id, a.Name+": "+healthChanged)
	}
	if exited && ShouldRestart(a.Restart, st.State.ExitCode) && r.RestartCount >= a.Restart.MaxAttempts {
		m.event("app.restart.exhausted", id, a.Name+": restart limit reached")
	}
	if next != nil && time.Now().After(*next) && m.op.TryLock() {
		m.mu.Lock()
		t = m.apps[id]
		do := t != nil && t.Runtime.NextRestart != nil && !Active(t.Runtime)
		if do {
			t.Runtime.NextRestart = nil
			t.Runtime.RestartCount++
		}
		m.mu.Unlock()
		if do {
			_ = m.startOne(m.ctx, id, true)
		}
		m.op.Unlock()
	}
	if running {
		m.ensureLogs(id)
	}
}
func ShouldRestart(p config.Restart, code *int) bool {
	return p.Policy == "always" || p.Policy == "on-failure" && code != nil && *code != 0
}
func RestartDelay(p config.Restart, attempt int) time.Duration {
	d := p.Delay.Value()
	if p.Backoff == "exponential" {
		for i := 0; i < attempt && d < 5*time.Minute; i++ {
			d *= 2
		}
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}
func (m *Manager) Operate(ctx context.Context, action string, ids []string, force bool) map[string]string {
	m.op.Lock()
	defer m.op.Unlock()
	if e := ctx.Err(); e != nil {
		return map[string]string{"error": e.Error()}
	}
	if (action == "start" || action == "restart") && m.ctx.Err() != nil {
		return map[string]string{"error": "LocalDesk is shutting down"}
	}
	c := m.Config()
	order, e := c.Order(ids)
	out := map[string]string{}
	if e != nil {
		out["error"] = e.Error()
		return out
	}
	selected := map[string]bool{}
	for _, id := range ids {
		selected[id] = true
	}
	if action == "stop" || action == "kill" {
		for i := len(order) - 1; i >= 0; i-- {
			id := order[i]
			if selected[id] {
				if e := m.stopOne(ctx, id, force || action == "kill"); e != nil {
					out[id] = e.Error()
				} else {
					out[id] = "ok"
				}
			}
		}
		return out
	}
	if action == "restart" {
		for _, id := range ids {
			m.mu.RLock()
			t := m.apps[id]
			a := t.Effective
			r := t.Runtime
			m.mu.RUnlock()
			if a.Type == "custom" && a.RestartCommand.Command != "" && Active(r) {
				restartCtx, cancel := context.WithTimeout(ctx, a.Stop.Timeout.Value()+time.Minute)
				_, err := runner.Run(restartCtx, a, a.RestartCommand)
				cancel()
				if err != nil {
					out[id] = err.Error()
					m.event("app.failed", id, err.Error())
				} else {
					out[id] = "ok"
					m.event("app.restarted", id, a.Name+" restarted")
				}
			}
		}
		for i := len(order) - 1; i >= 0; i-- {
			id := order[i]
			if selected[id] && out[id] == "" {
				if e := m.stopOne(ctx, id, false); e != nil {
					out[id] = e.Error()
				}
			}
		}
	}
	if action != "start" && action != "restart" {
		out["error"] = "unknown action"
		return out
	}
	for _, id := range order {
		if out[id] != "" {
			continue
		}
		a := c.Apps[id]
		blocked := ""
		for dep, d := range a.DependsOn {
			if msg := out[dep]; msg != "" && msg != "ok" {
				blocked = fmt.Sprintf("dependency %s failed: %s", dep, msg)
				break
			}
			if e := m.waitDependency(ctx, dep, d.Condition); e != nil {
				blocked = e.Error()
				break
			}
		}
		if blocked != "" {
			out[id] = blocked
			continue
		}
		if e := m.startOne(ctx, id, false); e != nil {
			out[id] = e.Error()
		} else {
			out[id] = "ok"
		}
	}
	return out
}
func (m *Manager) waitDependency(ctx context.Context, id, condition string) error {
	deadline := time.Now().Add(m.Config().Defaults.DependencyTimeout.Value())
	for {
		v, ok := m.View(id)
		if !ok {
			return fmt.Errorf("missing dependency %s", id)
		}
		if Active(v.Runtime) && (condition != "healthy" || v.Runtime.Health == "healthy") {
			return nil
		}
		if v.Runtime.State == "failed" || time.Now().After(deadline) {
			return fmt.Errorf("dependency %s did not become %s: %s", id, condition, v.Runtime.Error)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (m *Manager) startOne(ctx context.Context, id string, retry bool) error {
	m.mu.Lock()
	t, ok := m.apps[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("unknown app %s", id)
	}
	a := m.cfg.Apps[id]
	r := t.Runtime
	reg := m.registry[a.Type]
	if Active(r) {
		m.mu.Unlock()
		return nil
	}
	if r.State == "unknown" {
		m.mu.Unlock()
		return fmt.Errorf("%s has an unverified previous launch; inspect it before starting a duplicate", a.Name)
	}
	m.mu.Unlock()
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	st, statusErr := reg.Status(checkCtx, a, r)
	cancel()
	if st.Running {
		m.mu.Lock()
		t.Runtime.State = "external"
		t.Runtime.Owned = r.Owned || st.State.ID != ""
		if t.Runtime.Owned {
			t.Runtime.State = "running"
		}
		m.save(id, t)
		m.mu.Unlock()
		return nil
	}
	if st.Unknown && r.Launch != "" {
		return fmt.Errorf("previous launch cannot be verified: %v", statusErr)
	}
	if a.Detect.Type != "" {
		h := health.Check(ctx, a.Detect, a, r, nil)
		if h.OK {
			m.mu.Lock()
			t.Runtime.State = "external"
			t.Runtime.Owned = false
			m.save(id, t)
			m.mu.Unlock()
			m.event("app.external.detected", id, a.Name+" is running externally")
			return nil
		}
	}
	for _, p := range a.Ports {
		if health.Check(ctx, config.Check{Type: "tcp", Host: "127.0.0.1", Port: p.Port, Timeout: config.Duration(300 * time.Millisecond)}, a, r, nil).OK {
			return fmt.Errorf("%s: port %d is already occupied; inspect the existing service or add a detection check", a.Name, p.Port)
		}
	}
	m.mu.Lock()
	t.Runtime.State = "starting"
	t.Runtime.Error = ""
	t.Runtime.NextRestart = nil
	t.Effective = a
	t.LastCheck = time.Time{}
	count := t.Runtime.RestartCount
	if !retry {
		count = 0
	}
	m.save(id, t)
	m.mu.Unlock()
	m.event("app.starting", id, a.Name+" is starting")
	startCtx, stop := context.WithTimeout(ctx, 2*time.Minute)
	defer stop()
	newRuntime, e := reg.Start(startCtx, a)
	m.mu.Lock()
	if e != nil {
		t.Runtime.State = "failed"
		t.Runtime.Error = e.Error()
		if newRuntime.Launch != "" {
			t.Runtime.Launch = newRuntime.Launch
			t.Runtime.Started = newRuntime.Started
			t.Runtime.State = "unknown"
		}
	} else {
		newRuntime.RestartCount = count
		newRuntime.Health = "unknown"
		t.Runtime = newRuntime
		t.Failures = 0
		t.Successes = 0
	}
	m.save(id, t)
	m.mu.Unlock()
	if e != nil {
		m.event("app.failed", id, a.Name+": "+e.Error())
		return e
	}
	m.event("app.started", id, a.Name+" started")
	m.ensureLogs(id)
	return nil
}
func (m *Manager) stopOne(ctx context.Context, id string, force bool) error {
	m.mu.Lock()
	t, ok := m.apps[id]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("unknown app %s", id)
	}
	if t.RecoveryError != "" {
		err := fmt.Errorf("%s", t.RecoveryError)
		m.mu.Unlock()
		return err
	}
	a := t.Effective
	r := t.Runtime
	reg := m.registry[a.Type]
	t.Runtime.NextRestart = nil
	if !Active(r) && r.Launch == "" {
		m.save(id, t)
		m.mu.Unlock()
		return nil
	}
	t.Runtime.State = "stopping"
	m.mu.Unlock()
	m.event("app.stopping", id, a.Name+" is stopping")
	stopCtx, cancel := context.WithTimeout(ctx, a.Stop.Timeout.Value()+15*time.Second)
	defer cancel()
	e := reg.Stop(stopCtx, a, r, force)
	var stoppedState supervisor.State
	if e == nil && r.Launch != "" {
		_, stoppedState, _, _ = supervisor.Inspect(m.Dir, r.Launch)
	}
	m.mu.Lock()
	if e != nil {
		t.Runtime.State = r.State
		t.Runtime.Error = e.Error()
	} else {
		t.Runtime.State = "stopped"
		t.Runtime.Owned = false
		t.Runtime.PID = 0
		t.Runtime.PGID = 0
		t.Runtime.Launch = ""
		t.Runtime.Health = "unknown"
		now := time.Now().UTC()
		t.Runtime.Exited = &now
		if stoppedState.ExitCode != nil {
			t.Runtime.ExitCode = stoppedState.ExitCode
			t.Runtime.Exited = stoppedState.Exited
		}
		t.Runtime.Error = ""
	}
	if e == nil && r.Launch != "" {
		m.Store.Launch(r.Launch, id, t.Runtime.Started, t.Runtime)
	}
	logLaunch := t.LogLaunch
	if e == nil {
		t.LogLaunch = ""
	}
	m.save(id, t)
	m.mu.Unlock()
	if e == nil && logLaunch != "" {
		if s, _, verified, _ := supervisor.Inspect(m.Dir, logLaunch); verified {
			supervisor.Query(s, "stop", map[string]bool{"force": true})
		}
	}
	if e != nil {
		m.event("app.stop.failed", id, a.Name+": "+e.Error())
		return e
	}
	m.event("app.stopped", id, a.Name+" stopped")
	return nil
}
func (m *Manager) ensureLogs(id string) {
	m.mu.Lock()
	t, ok := m.apps[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	a := t.Effective
	if t.Runtime.Launch != "" || !Active(t.Runtime) {
		m.mu.Unlock()
		return
	}
	cmd := m.registry[a.Type].LogCommand(a)
	if cmd.Command == "" {
		m.mu.Unlock()
		return
	}
	old := t.LogLaunch
	if old == "pending" {
		m.mu.Unlock()
		return
	}
	if old != "" {
		_, st, verified, _ := supervisor.Inspect(m.Dir, old)
		if verified && st.Running {
			m.mu.Unlock()
			return
		}
	}
	t.LogLaunch = "pending"
	logging := m.cfg.Logging
	m.mu.Unlock()
	env, e := runner.Environment(a)
	var s supervisor.Spec
	if e == nil {
		s, _, e = supervisor.Launch(m.Dir, a, cmd, env, logging, "logs")
	}
	m.mu.Lock()
	if e == nil {
		t.LogLaunch = s.ID
	} else {
		t.LogLaunch = ""
	}
	m.save(id, t)
	m.mu.Unlock()
}
func (m *Manager) Profile(ctx context.Context, id, action string) map[string]string {
	p, ok := m.Config().Profiles[id]
	if !ok {
		return map[string]string{"error": "unknown profile"}
	}
	out := m.Operate(ctx, action, p.Apps, false)
	kind := "profile." + map[string]string{"start": "started", "stop": "stopped", "restart": "restarted"}[action]
	for _, msg := range out {
		if msg != "ok" {
			kind = "profile.failed"
			break
		}
	}
	b, _ := json.Marshal(out)
	m.event(kind, "", p.Name+": "+string(b))
	return out
}
func (m *Manager) GlobalIDs(runningOnly bool) []string {
	c := m.Config()
	exclude := map[string]bool{}
	for _, id := range c.GlobalActions.Exclude {
		exclude[id] = true
	}
	ids := []string{}
	for _, v := range m.Views() {
		if !exclude[v.Config.ID] && (!runningOnly || Active(v.Runtime)) {
			ids = append(ids, v.Config.ID)
		}
	}
	return ids
}
func (m *Manager) Reload() error {
	m.op.Lock()
	defer m.op.Unlock()
	c, e := config.Load(m.ConfigPath)
	if e == nil {
		m.mu.RLock()
		for id, t := range m.apps {
			if _, ok := c.Apps[id]; !ok && (Active(t.Runtime) || t.Runtime.Launch != "") {
				e = fmt.Errorf("cannot remove active app %s; stop it before removing its configuration", id)
				break
			}
		}
		if c.Server.Host != m.cfg.Server.Host || c.Server.Port != m.cfg.Server.Port || c.Server.Token != m.cfg.Server.Token {
			e = fmt.Errorf("server binding/authentication changed; restart LocalDesk to apply")
		}
		m.mu.RUnlock()
	}
	m.mu.Lock()
	if e != nil {
		m.ConfigError = e.Error()
		m.mu.Unlock()
		m.event("config.failed", "", e.Error())
		return e
	}
	for id, a := range c.Apps {
		if t, ok := m.apps[id]; ok {
			if !Active(t.Runtime) && t.Runtime.Launch == "" {
				t.Effective = a
			}
		} else {
			m.apps[id] = &tracked{Runtime: runner.Runtime{State: "stopped", Health: "unknown"}, Effective: a, Ports: map[int]bool{}}
		}
	}
	for id := range m.apps {
		if _, ok := c.Apps[id]; !ok {
			delete(m.apps, id)
		}
	}
	m.cfg = c
	m.registry = runner.Registry(m.Dir, c.Logging)
	m.ConfigError = ""
	m.mu.Unlock()
	m.event("config.reloaded", "", "Configuration reloaded")
	return nil
}
func (m *Manager) Close() {
	m.cancel()
	m.wg.Wait()
	ids := []string{}
	for _, v := range m.Views() {
		if v.Config.Lifecycle.StopOnExit {
			ids = append(ids, v.Config.ID)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	m.Operate(ctx, "stop", ids, false)
}
func (m *Manager) Logs(id string, limit int, after time.Time) []supervisor.Log {
	paths := runner.LogPaths(m.Dir, id)
	sort.Slice(paths, func(i, j int) bool {
		a, ea := os.Stat(paths[i])
		b, eb := os.Stat(paths[j])
		return ea == nil && eb == nil && a.ModTime().After(b.ModTime())
	})
	all := []supervisor.Log{}
	for _, p := range paths {
		if st, e := os.Stat(p); e == nil && !after.IsZero() && st.ModTime().Before(after) {
			continue
		}
		for _, l := range supervisor.ReadLogs(p, m.Config().Logging.MaxFiles, limit, 0) {
			if l.Time.After(after) {
				all = append(all, l)
			}
		}
		if len(all) >= limit {
			break
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Time.Before(all[j].Time) })
	if len(all) > limit {
		all = all[len(all)-limit:]
	}
	return all
}
func (m *Manager) pruneLogs() {
	c := m.Config()
	cut := time.Now().Add(-time.Duration(c.Logging.RetentionDays) * 24 * time.Hour)
	protected := map[string]bool{}
	m.mu.RLock()
	for id, t := range m.apps {
		for _, launch := range []string{t.Runtime.Launch, t.LogLaunch} {
			if launch != "" {
				protected[filepath.Join(m.Dir, "logs", id+"-"+launch+".jsonl")] = true
			}
		}
	}
	m.mu.RUnlock()
	paths, _ := filepath.Glob(filepath.Join(m.Dir, "logs", "*"))
	type file struct {
		path string
		size int64
		time time.Time
	}
	byApp := map[string][]file{}
	for _, p := range paths {
		st, e := os.Stat(p)
		if e != nil {
			continue
		}
		if st.ModTime().Before(cut) && !protected[p] {
			os.Remove(p)
			continue
		}
		stem := strings.Split(filepath.Base(p), ".jsonl")[0]
		if len(stem) > 25 && stem[len(stem)-25] == '-' {
			id := stem[:len(stem)-25]
			byApp[id] = append(byApp[id], file{p, st.Size(), st.ModTime()})
		}
	}
	budget := int64(c.Logging.MaxSizeMB) * 1024 * 1024 * int64(c.Logging.MaxFiles+1)
	for _, files := range byApp {
		sort.Slice(files, func(i, j int) bool { return files[i].time.Before(files[j].time) })
		var size int64
		for _, f := range files {
			size += f.size
		}
		for _, f := range files {
			if size <= budget {
				break
			}
			if !protected[f.path] {
				if os.Remove(f.path) == nil {
					size -= f.size
				}
			}
		}
	}
	// Completed launch metadata contains resolved environment values; retain it only as long as history.
	specs, _ := filepath.Glob(filepath.Join(m.Dir, "launches", "*.json.exit"))
	for _, p := range specs {
		if st, e := os.Stat(p); e == nil && st.ModTime().Before(cut) {
			os.Remove(strings.TrimSuffix(p, ".exit"))
			os.Remove(p)
		}
	}
}
