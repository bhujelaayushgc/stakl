package events

import (
	"sync"
	"time"
)

type Event struct {
	Type    string    `json:"type"`
	App     string    `json:"app,omitempty"`
	Message string    `json:"message,omitempty"`
	Time    time.Time `json:"time"`
}
type Bus struct {
	mu   sync.Mutex
	subs map[chan Event]bool
}

func New() *Bus { return &Bus{subs: map[chan Event]bool{}} }
func (b *Bus) Subscribe() (chan Event, func()) {
	c := make(chan Event, 64)
	b.mu.Lock()
	b.subs[c] = true
	b.mu.Unlock()
	return c, func() { b.mu.Lock(); delete(b.subs, c); b.mu.Unlock() }
}
func (b *Bus) Publish(e Event) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for c := range b.subs {
		select {
		case c <- e:
		default:
		}
	}
}
func (b *Bus) Count() int { b.mu.Lock(); defer b.mu.Unlock(); return len(b.subs) }
