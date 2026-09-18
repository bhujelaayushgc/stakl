package health

import (
	"context"
	"fmt"
	"localdesk/internal/config"
	"localdesk/internal/runner"
	"localdesk/internal/storage"
	"localdesk/internal/supervisor"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func Check(ctx context.Context, c config.Check, a config.App, r runner.Runtime, containers []runner.Container) storage.Health {
	start := time.Now()
	timeout := c.Timeout.Value()
	if timeout == 0 {
		timeout = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var err error
	switch c.Type {
	case "http":
		req, e := http.NewRequestWithContext(ctx, "GET", c.URL, nil)
		if e != nil {
			err = e
			break
		}
		client := http.Client{Timeout: timeout, CheckRedirect: func(r *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
		resp, e := client.Do(req)
		err = e
		if e == nil {
			resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 400 {
				err = fmt.Errorf("HTTP %d", resp.StatusCode)
			}
		}
	case "tcp":
		conn, e := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
		err = e
		if e == nil {
			conn.Close()
		}
	case "process":
		if c.Name != "" {
			_, err = runner.Run(ctx, a, config.Command{Command: "pgrep", Args: []string{"-x", c.Name}})
		} else if !r.Owned || !supervisor.PIDAlive(r.PID) {
			err = fmt.Errorf("owned process is not alive")
		}
	case "pidfile":
		b, e := os.ReadFile(c.Path)
		err = e
		if e == nil {
			pid, e := strconv.Atoi(strings.TrimSpace(string(b)))
			if e != nil || !supervisor.PIDAlive(pid) {
				err = fmt.Errorf("PID file does not identify a live process")
			}
		}
	case "command":
		_, err = runner.Run(ctx, a, config.Command{Command: c.Command, Shell: true})
	case "docker":
		if len(containers) == 0 {
			err = fmt.Errorf("no Compose containers found")
		}
		for _, c := range containers {
			if c.State != "running" || c.Health == "unhealthy" || c.Health == "starting" {
				err = fmt.Errorf("%s: %s %s", c.Name, c.State, c.Health)
				break
			}
		}
	default:
		err = fmt.Errorf("no health check configured")
	}
	h := storage.Health{Time: time.Now().UTC(), OK: err == nil, Latency: float64(time.Since(start).Microseconds()) / 1000}
	if err != nil {
		h.Message = err.Error()
	}
	return h
}
