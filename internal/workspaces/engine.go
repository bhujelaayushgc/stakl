package workspaces

import (
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
)

// Engine reads immutable configuration generations and cached host snapshots.
type Engine struct {
	config    func() *config.Config
	snapshots func() []hosts.Envelope
}

func New(source func() *config.Config, snapshots func() []hosts.Envelope) *Engine {
	return &Engine{config: source, snapshots: snapshots}
}
func (e *Engine) Views() []View { return Evaluate(e.config(), e.snapshots(), nil, time.Now().UTC()) }
func (e *Engine) Impact(controller, app string) []Use {
	return Impact(e.config(), e.snapshots(), controller, app)
}
