package health

import (
	"context"
	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/runner"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestHTTPAndTCP(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bad" {
			w.WriteHeader(503)
		}
	}))
	defer srv.Close()
	for _, tc := range []struct {
		path string
		ok   bool
	}{{"/", true}, {"/bad", false}} {
		h := Check(context.Background(), config.Check{Type: "http", URL: srv.URL + tc.path}, config.App{}, runner.Runtime{}, nil)
		if h.OK != tc.ok {
			t.Fatalf("%s: %+v", tc.path, h)
		}
	}
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	p, _ := strconv.Atoi(port)
	h := Check(context.Background(), config.Check{Type: "tcp", Host: host, Port: p}, config.App{}, runner.Runtime{}, nil)
	if !h.OK {
		t.Fatal(h)
	}
}
func TestHealthTimeoutAndDocker(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(100 * time.Millisecond) }))
	defer srv.Close()
	h := Check(context.Background(), config.Check{Type: "http", URL: srv.URL, Timeout: config.Duration(10 * time.Millisecond)}, config.App{}, runner.Runtime{}, nil)
	if h.OK {
		t.Fatal("timeout should fail")
	}
	h = Check(context.Background(), config.Check{Type: "docker"}, config.App{}, runner.Runtime{}, []runner.Container{{Name: "db", State: "running", Health: "unhealthy"}})
	if h.OK {
		t.Fatal("unhealthy Docker container")
	}
}
