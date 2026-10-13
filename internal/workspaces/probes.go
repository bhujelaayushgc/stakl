package workspaces

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/events"
	"github.com/bhujelaayushgc/stakl/internal/health"
	"github.com/bhujelaayushgc/stakl/internal/runner"
)

func (e *Engine) synchronizeLocked(c *config.Config) {
	if c == e.current {
		return
	}
	if e.generationCancel != nil {
		e.generationCancel()
	}
	e.current = c
	e.generation++
	e.results = map[Key]ProbeResult{}
	e.pending = map[Key]bool{}
	if e.active == nil {
		e.active = map[Key]bool{}
	}
	root := e.root
	if root == nil {
		root = context.Background()
	}
	e.generationContext, e.generationCancel = context.WithCancel(root)
}

// Start owns four workers until Close. Reload events cancel obsolete work;
// config pointer checks protect reads and completions even if an event drops.
func (e *Engine) Start(ctx context.Context, bus *events.Bus) {
	e.mu.Lock()
	c := e.config()
	if e.started || e.closed {
		e.mu.Unlock()
		return
	}
	e.started = true
	e.root, e.cancel = context.WithCancel(ctx)
	e.current = nil
	e.synchronizeLocked(c)
	e.scheduleLocked(time.Now(), "")
	e.wg.Add(5)
	root := e.root
	e.mu.Unlock()
	for i := 0; i < 4; i++ {
		go e.worker(root)
	}
	var changes <-chan events.Event
	unsubscribe := func() {}
	if bus != nil {
		var ch chan events.Event
		ch, unsubscribe = bus.Subscribe()
		changes = ch
	}
	go func() {
		defer e.wg.Done()
		defer unsubscribe()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-root.Done():
				return
			case event := <-changes:
				if event.Type != "config.reloaded" {
					continue
				}
			case <-ticker.C:
			}
			e.mu.Lock()
			c := e.config()
			e.synchronizeLocked(c)
			if !e.closed {
				e.scheduleLocked(time.Now(), "")
			}
			e.mu.Unlock()
		}
	}()
}

func (e *Engine) signalLocked() {
	select {
	case e.wake <- struct{}{}:
	default:
	}
}
func (e *Engine) scheduleLocked(now time.Time, workspace string) int {
	n := 0
	for id, w := range e.current.Workspaces {
		if workspace != "" && id != workspace {
			continue
		}
		for probeID, p := range w.Checks {
			k := Key{id, probeID}
			if _, exists := e.pending[k]; exists {
				continue
			}
			r := e.results[k]
			if workspace == "" && !r.CheckedAt.IsZero() && now.Sub(r.CheckedAt) < p.Check.Interval.Value() {
				continue
			}
			e.pending[k] = false
			n++
		}
	}
	if n > 0 {
		e.signalLocked()
	}
	return n
}

func (e *Engine) CheckNow(id string) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.config()
	e.synchronizeLocked(c)
	if e.closed || !e.started || e.root.Err() != nil {
		return 0, fmt.Errorf("workspace checks are unavailable")
	}
	if _, ok := c.Workspaces[id]; !ok {
		return 0, fmt.Errorf("workspace not found")
	}
	return e.scheduleLocked(time.Now(), id), nil
}

type job struct {
	key        Key
	probe      config.WorkspaceProbe
	generation uint64
	ctx        context.Context
}

func (e *Engine) take() (job, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	c := e.config()
	e.synchronizeLocked(c)
	if e.closed || e.root.Err() != nil {
		return job{}, false
	}
	for k, running := range e.pending {
		if running || e.active[k] {
			continue
		}
		e.pending[k] = true
		e.active[k] = true
		e.signalLocked()
		return job{k, e.current.Workspaces[k.Workspace].Checks[k.Probe], e.generation, e.generationContext}, true
	}
	return job{}, false
}

func (e *Engine) worker(ctx context.Context) {
	defer e.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-e.wake:
		}
		for {
			j, ok := e.take()
			if !ok {
				break
			}
			r := execute(j.ctx, j.probe)
			e.mu.Lock()
			c := e.config()
			e.synchronizeLocked(c)
			delete(e.active, j.key)
			e.signalLocked()
			if !e.closed && e.generation == j.generation && j.ctx.Err() == nil {
				e.results[j.key] = r
				delete(e.pending, j.key)
			}
			e.mu.Unlock()
		}
	}
}

func execute(ctx context.Context, p config.WorkspaceProbe) ProbeResult {
	ctx, cancel := context.WithTimeout(ctx, p.Check.Timeout.Value())
	defer cancel()
	h := health.Check(ctx, p.Check.HealthCheck(), config.App{Cwd: p.Cwd, EnvFile: p.EnvFile}, runner.Runtime{}, nil)
	r := ProbeResult{CheckedAt: h.Time, OK: h.OK, Latency: h.Latency}
	if h.OK {
		return r
	}
	if ctx.Err() == context.DeadlineExceeded {
		r.Message = "Check timed out"
		return r
	}
	switch p.Check.Type {
	case "http":
		r.Message = "HTTP request failed"
		if strings.HasPrefix(h.Message, "HTTP ") {
			if code, err := strconv.Atoi(strings.TrimPrefix(h.Message, "HTTP ")); err == nil && code >= 100 && code <= 599 {
				r.Message = fmt.Sprintf("HTTP returned %d", code)
			}
		}
	case "tcp":
		r.Message = "TCP connection failed"
	case "command":
		r.Message = "Command check failed"
	default:
		r.Message = "Check failed"
	}
	return r
}

func (e *Engine) Close() {
	e.mu.Lock()
	e.closed = true
	if e.cancel != nil {
		e.cancel()
	}
	if e.generationCancel != nil {
		e.generationCancel()
	}
	e.mu.Unlock()
	e.wg.Wait()
}
