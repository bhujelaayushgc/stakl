package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

type Workspace struct {
	Name        string                      `yaml:"name" json:"name"`
	Description string                      `yaml:"description,omitempty" json:"description"`
	Services    map[string]WorkspaceService `yaml:"services" json:"services"`
	Checks      map[string]WorkspaceProbe   `yaml:"checks,omitempty" json:"-"`
}

type WorkspaceService struct {
	Controller string `yaml:"controller" json:"controller"`
	App        string `yaml:"app" json:"app"`
	Condition  string `yaml:"condition,omitempty" json:"condition"`
	Required   bool   `yaml:"required,omitempty" json:"required"`
}

func (s *WorkspaceService) UnmarshalYAML(n *yaml.Node) error {
	s.Condition, s.Required = "running", true
	type plain WorkspaceService
	return strictNode(n, (*plain)(s))
}

// Probe settings are configuration-only. API views deliberately omit targets,
// command text and environment files.
type WorkspaceProbe struct {
	Name    string         `yaml:"name,omitempty" json:"-"`
	Service string         `yaml:"service" json:"-"`
	Cwd     string         `yaml:"cwd,omitempty" json:"-"`
	EnvFile []string       `yaml:"env_file,omitempty" json:"-"`
	Check   WorkspaceCheck `yaml:"check" json:"-"`
}

type WorkspaceCheck struct {
	Type     string   `yaml:"type"`
	URL      string   `yaml:"url,omitempty"`
	Host     string   `yaml:"host,omitempty"`
	Port     int      `yaml:"port,omitempty"`
	Command  string   `yaml:"command,omitempty"`
	Interval Duration `yaml:"interval,omitempty"`
	Timeout  Duration `yaml:"timeout,omitempty"`
}

func (c *WorkspaceCheck) UnmarshalYAML(n *yaml.Node) error {
	c.Interval, c.Timeout = Duration(30*time.Second), Duration(2*time.Second)
	type plain WorkspaceCheck
	if err := strictNode(n, (*plain)(c)); err != nil {
		return err
	}
	allowed := map[string]bool{"type": true, "interval": true, "timeout": true}
	switch c.Type {
	case "http":
		allowed["url"] = true
	case "tcp":
		allowed["host"], allowed["port"] = true, true
	case "command":
		allowed["command"] = true
	default:
		return fmt.Errorf("workspace check.type must be http, tcp or command")
	}
	// Inspect presence, so irrelevant empty/zero fields cannot silently pass.
	for i := 0; i+1 < len(n.Content); i += 2 {
		if !allowed[n.Content[i].Value] {
			return fmt.Errorf("workspace check.%s is unsupported for %s", n.Content[i].Value, c.Type)
		}
	}
	return nil
}

func (c WorkspaceCheck) HealthCheck() Check {
	return Check{Type: c.Type, URL: c.URL, Host: c.Host, Port: c.Port, Command: c.Command, Interval: c.Interval, Timeout: c.Timeout}
}

var controllerIdentity = regexp.MustCompile(`^[0-9a-f]{32}$`)

func ValidController(s string) bool { return s == "local" || controllerIdentity.MatchString(s) }

func (c *Config) validateWorkspaces(base string) error {
	for id, w := range c.Workspaces {
		prefix := "workspaces." + id
		if !ValidID(id) {
			return fmt.Errorf("%s: invalid workspace ID", prefix)
		}
		if strings.TrimSpace(w.Name) == "" {
			return fmt.Errorf("%s.name is required", prefix)
		}
		if len(w.Services) == 0 {
			return fmt.Errorf("%s.services requires at least one service", prefix)
		}
		refs := map[string]bool{}
		for alias, s := range w.Services {
			p := prefix + ".services." + alias
			if !ValidID(alias) {
				return fmt.Errorf("%s: invalid service alias", p)
			}
			if !ValidController(s.Controller) {
				return fmt.Errorf("%s.controller must be local or a lowercase controller identity", p)
			}
			if !ValidID(s.App) {
				return fmt.Errorf("%s.app is invalid", p)
			}
			if s.Condition != "running" && s.Condition != "healthy" {
				return fmt.Errorf("%s.condition must be running or healthy", p)
			}
			ref := s.Controller + ":" + s.App
			if refs[ref] {
				return fmt.Errorf("%s: duplicate service reference", p)
			}
			refs[ref] = true
		}
		for probeID, p := range w.Checks {
			path := prefix + ".checks." + probeID
			if !ValidID(probeID) {
				return fmt.Errorf("%s: invalid check ID", path)
			}
			if _, ok := w.Services[p.Service]; !ok {
				return fmt.Errorf("%s.service does not identify a member", path)
			}
			if p.Check.Interval.Value() < 5*time.Second {
				return fmt.Errorf("%s.check.interval must be at least 5s", path)
			}
			if p.Check.Timeout.Value() <= 0 || p.Check.Timeout.Value() > 30*time.Second {
				return fmt.Errorf("%s.check.timeout must be greater than zero and at most 30s", path)
			}
			if p.Cwd == "" {
				p.Cwd = base
			}
			p.Cwd = Expand(p.Cwd, base)
			st, err := os.Stat(p.Cwd)
			if err != nil || !st.IsDir() {
				return fmt.Errorf("%s.cwd must be an existing directory", path)
			}
			for _, f := range p.EnvFile {
				st, err := os.Stat(Expand(f, p.Cwd))
				if err != nil || st.IsDir() {
					return fmt.Errorf("%s.env_file must identify existing files", path)
				}
			}
			check := p.Check.HealthCheck()
			if err := checkWorkspaceTarget(&check, path+".check", p.Cwd); err != nil {
				return err
			}
			p.Check.Host = check.Host
			if p.Name == "" {
				p.Name = probeID
			}
			w.Checks[probeID] = p
		}
		c.Workspaces[id] = w
	}
	return nil
}

func checkWorkspaceTarget(c *Check, prefix, cwd string) error {
	switch c.Type {
	case "http", "tcp", "command":
	default:
		return fmt.Errorf("%s.type is required", prefix)
	}
	return check(c, prefix, cwd)
}
