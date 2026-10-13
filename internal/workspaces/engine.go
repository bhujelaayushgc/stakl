package workspaces

import (
	"context"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"sync"
	"time"
)

// Engine reads immutable configuration generations and cached host snapshots.
type Engine struct {
	config            func() *config.Config
	snapshots         func() []hosts.Envelope
	mu                sync.Mutex
	wg                sync.WaitGroup
	current           *config.Config
	generation        uint64
	root              context.Context
	cancel            context.CancelFunc
	generationContext context.Context
	generationCancel  context.CancelFunc
	results           map[Key]ProbeResult
	pending           map[Key]bool
	active            map[Key]bool
	wake              chan struct{}
	started, closed   bool
}

func New(source func() *config.Config, snapshots func() []hosts.Envelope) *Engine {
	return &Engine{config: source, snapshots: snapshots, wake: make(chan struct{}, 1)}
}
func (e *Engine) Views() []View {
	e.mu.Lock()
	c := e.config()
	e.synchronizeLocked(c)
	results := make(map[Key]ProbeResult, len(e.results))
	for k, v := range e.results {
		results[k] = v
	}
	e.mu.Unlock()
	return Evaluate(c, e.snapshots(), results, time.Now().UTC())
}
func (e *Engine) Impact(controller, app string) []Use {
	return Impact(e.config(), e.snapshots(), controller, app)
}
