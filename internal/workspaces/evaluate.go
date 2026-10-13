// Package workspaces evaluates project requirements using controller-owned
// service observations. It never starts, stops or acquires ownership of apps.
package workspaces

import (
	"sort"
	"time"

	"github.com/bhujelaayushgc/stakl/internal/config"
	"github.com/bhujelaayushgc/stakl/internal/hosts"
	"github.com/bhujelaayushgc/stakl/internal/manager"
)

type Key struct{ Workspace, Probe string }
type ProbeResult struct {
	CheckedAt time.Time
	OK        bool
	Latency   float64
	Message   string
}
type Probe struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Service   string    `json:"service"`
	Type      string    `json:"type"`
	Origin    string    `json:"origin"`
	State     string    `json:"state"`
	Reason    string    `json:"reason"`
	CheckedAt time.Time `json:"checked_at"`
	Latency   float64   `json:"latency"`
	Interval  string    `json:"interval"`
}
type Use struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Service  string `json:"service"`
	Required bool   `json:"required"`
}
type Member struct {
	Alias            string             `json:"alias"`
	Controller       string             `json:"controller"`
	App              string             `json:"app"`
	Name             string             `json:"name"`
	Condition        string             `json:"condition"`
	Required         bool               `json:"required"`
	State            string             `json:"state"`
	Reason           string             `json:"reason"`
	RuntimeState     string             `json:"runtime_state"`
	ObservedAt       time.Time          `json:"observed_at"`
	ObservationFresh bool               `json:"observation_fresh"`
	Host             *hosts.Description `json:"host,omitempty"`
	Controllable     bool               `json:"controllable"`
	Uses             []Use              `json:"uses"`
	Checks           []Probe            `json:"checks"`
}
type View struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	State          string   `json:"state"`
	Origin         string   `json:"origin"`
	Members        []Member `json:"members"`
	RequiredIssues int      `json:"required_issues"`
	OptionalIssues int      `json:"optional_issues"`
}

func localID(envelopes []hosts.Envelope) string {
	for _, e := range envelopes {
		if e.Host.ID == "local" {
			return e.Host.ControllerID
		}
	}
	return "local"
}
func canonical(controller, local string) string {
	if controller == "local" {
		return local
	}
	return controller
}

// Impact includes only definitions on this controller, not another host's
// private workspaces or undiscovered relationships.
func Impact(c *config.Config, envelopes []hosts.Envelope, controller, app string) []Use {
	out := []Use{}
	local := localID(envelopes)
	controller = canonical(controller, local)
	for _, id := range sortedKeys(c.Workspaces) {
		w := c.Workspaces[id]
		for _, alias := range sortedKeys(w.Services) {
			s := w.Services[alias]
			if canonical(s.Controller, local) == controller && s.App == app {
				out = append(out, Use{id, w.Name, alias, s.Required})
			}
		}
	}
	return out
}

func fresh(t, now time.Time, ttl time.Duration) bool {
	return !t.IsZero() && !t.After(now.Add(5*time.Second)) && now.Sub(t) <= ttl
}
func observationTTL(a config.App) time.Duration {
	interval := a.Health.Interval.Value()
	if interval == 0 {
		interval = a.Detect.Interval.Value()
	}
	if interval == 0 {
		interval = 5 * time.Second
	}
	return max(15*time.Second, 2*interval)
}
func resolve(envelopes []hosts.Envelope, controller string) *hosts.Envelope {
	var found *hosts.Envelope
	for i := range envelopes {
		e := &envelopes[i]
		if e.Host.ControllerID != controller {
			continue
		}
		if found == nil || (e.Host.State == hosts.StateOnline && !e.Host.Stale) {
			found = e
		}
	}
	return found
}

func memberObservation(m *Member, app manager.AppView, now time.Time) {
	m.Name, m.RuntimeState, m.ObservedAt = app.Config.Name, app.Runtime.State, app.ObservedAt
	ttl := observationTTL(app.EffectiveConfig)
	if !fresh(app.ObservedAt, now, ttl) {
		m.Reason = "Service observation is missing, stale or has an invalid clock; update older peers if needed"
		return
	}
	m.ObservationFresh = true
	switch app.Runtime.State {
	case "starting", "stopping", "unknown", "":
		m.ObservationFresh = false
		m.Reason = "Service state is transitional or unknown"
		return
	case "running", "healthy", "unhealthy", "external":
	default:
		m.State, m.Reason = "blocked", "Service is not running"
		return
	}
	m.Controllable = m.Host != nil && m.Host.Access == "control" && app.EffectiveConfig.Type != "external" && (app.Runtime.Owned || app.EffectiveConfig.Type == "docker-compose" || app.EffectiveConfig.Type == "custom")
	if m.Condition == "healthy" {
		if app.EffectiveConfig.Health.Type == "" {
			m.Reason = "Service has no configured health check"
			return
		}
		h := app.HealthObservation
		if h == nil || !fresh(h.Time, now, ttl) {
			m.Reason = "Service health has not been checked recently"
			return
		}
		if !h.OK {
			m.State, m.Reason = "blocked", "Service health check failed"
			return
		}
	}
	m.State, m.Reason = "ready", "Service requirement passed"
}

func Evaluate(c *config.Config, envelopes []hosts.Envelope, results map[Key]ProbeResult, now time.Time) []View {
	out := []View{}
	local := localID(envelopes)
	for _, id := range sortedKeys(c.Workspaces) {
		w := c.Workspaces[id]
		v := View{ID: id, Name: w.Name, Description: w.Description, State: "ready", Origin: "local", Members: []Member{}}
		counts := map[string]int{}
		for _, s := range w.Services {
			counts[canonical(s.Controller, local)+":"+s.App]++
		}
		for _, alias := range sortedKeys(w.Services) {
			s := w.Services[alias]
			controller := canonical(s.Controller, local)
			m := Member{Alias: alias, Controller: s.Controller, App: s.App, Name: s.App, Condition: s.Condition, Required: s.Required, State: "unknown", Reason: "Controller is not registered", Uses: Impact(c, envelopes, s.Controller, s.App), Checks: []Probe{}}
			e := resolve(envelopes, controller)
			if e != nil {
				host := e.Host
				m.Host = &host
				if e.Host.State != hosts.StateOnline || e.Host.Stale {
					m.Reason = "Controller is unavailable or its snapshot is stale"
				} else {
					m.Reason = "Service is missing from this controller"
					for _, a := range e.Apps {
						if a.Config.ID == s.App {
							memberObservation(&m, a, now)
							break
						}
					}
				}
			}
			if counts[controller+":"+s.App] > 1 {
				m.ObservationFresh = false
				m.State, m.Reason, m.Controllable = "unknown", "Duplicate references resolve to the same service", false
			}
			for _, probeID := range sortedKeys(w.Checks) {
				p := w.Checks[probeID]
				if p.Service != alias {
					continue
				}
				r, ok := results[Key{id, probeID}]
				interval := p.Check.Interval.Value()
				if interval == 0 {
					interval = 30 * time.Second
				}
				check := Probe{ID: probeID, Name: p.Name, Service: alias, Type: p.Check.Type, Origin: "local", State: "unknown", Reason: "Check has not completed recently", CheckedAt: r.CheckedAt, Latency: r.Latency, Interval: interval.String()}
				if ok && fresh(r.CheckedAt, now, 2*interval) {
					if r.OK {
						check.State, check.Reason = "ready", "Check passed"
					} else {
						check.State, check.Reason = "blocked", r.Message
					}
				}
				m.Checks = append(m.Checks, check)
				// Unavailable observations remain authoritative. Failed checks may still
				// block an otherwise unknown requirement; successful ones cannot lift it.
				if check.State == "blocked" && m.State != "blocked" {
					m.State, m.Reason = "blocked", check.Reason
				}
				if check.State == "unknown" && m.State == "ready" {
					m.State, m.Reason = "unknown", check.Reason
				}
			}
			if m.State != "ready" {
				if m.Required {
					v.RequiredIssues++
				} else {
					v.OptionalIssues++
				}
			}
			v.Members = append(v.Members, m)
		}
		for _, m := range v.Members {
			if m.Required && m.State == "blocked" {
				v.State = "blocked"
				break
			}
			if m.Required && m.State == "unknown" {
				v.State = "unknown"
			}
		}
		if v.State == "ready" && v.OptionalIssues > 0 {
			v.State = "degraded"
		}
		out = append(out, v)
	}
	return out
}
func sortedKeys[T any](m map[string]T) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
