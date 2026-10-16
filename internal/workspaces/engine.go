package workspaces

import (
	"context"
	"crypto/rand"
	"fmt"
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
	instance          string
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
	return &Engine{config: source, snapshots: snapshots, wake: make(chan struct{}, 1), instance: rand.Text()}
}
func (e *Engine) Views() []View {
	e.mu.Lock()
	c := e.config()
	e.synchronizeLocked(c)
	results := make(map[Key]ProbeResult, len(e.results))
	for k, v := range e.results {
		results[k] = v
	}
	revision := fmt.Sprintf("%s:%d", e.instance, e.generation)
	e.mu.Unlock()
	views := Evaluate(c, e.snapshots(), results, time.Now().UTC())
	for i := range views {
		views[i].Revision = revision
	}
	return views
}
func (e *Engine) Impact(controller, app string) []Use {
	return Impact(e.config(), e.snapshots(), controller, app)
}
