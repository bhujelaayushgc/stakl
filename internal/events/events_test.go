package events

import (
	"testing"
	"time"
)

func TestFanoutAndSlowSubscriber(t *testing.T) {
	b := New()
	a, unsub := b.Subscribe()
	_, slow := b.Subscribe()
	defer slow()
	e := Event{Type: "app.started", App: "app", Time: time.Now()}
	b.Publish(e)
	if got := <-a; got.Type != e.Type {
		t.Fatal(got)
	}
	for i := 0; i < 1000; i++ {
		b.Publish(e)
	}
	unsub()
	if b.Count() != 1 {
		t.Fatal("unsubscribe")
	}
}
