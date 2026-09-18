package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mattn/go-shellwords"
	"gopkg.in/yaml.v3"
)

type Duration time.Duration

func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	v, e := time.ParseDuration(n.Value)
	if e != nil {
		return e
	}
	if v < 0 {
		return fmt.Errorf("duration cannot be negative")
	}
	*d = Duration(v)
	return nil
}
func (d *Duration) UnmarshalJSON(b []byte) error {
	var value string
	if e := json.Unmarshal(b, &value); e != nil {
		return e
	}
	v, e := time.ParseDuration(value)
	if e != nil {
		return e
	}
	*d = Duration(v)
	return nil
}
func (d Duration) MarshalYAML() (any, error) { return time.Duration(d).String(), nil }
func (d Duration) MarshalJSON() ([]byte, error) {
	return []byte(fmt.Sprintf("%q", time.Duration(d).String())), nil
}
func (d Duration) Value() time.Duration { return time.Duration(d) }

type Command struct {
	Command string   `yaml:"command" json:"command"`
	Args    []string `yaml:"args,omitempty" json:"args,omitempty"`
	Shell   bool     `yaml:"shell,omitempty" json:"shell,omitempty"`
}
type Check struct {
	Type             string   `yaml:"type" json:"type"`
	URL              string   `yaml:"url,omitempty" json:"url,omitempty"`
	Host             string   `yaml:"host,omitempty" json:"host,omitempty"`
	Port             int      `yaml:"port,omitempty" json:"port,omitempty"`
	Name             string   `yaml:"name,omitempty" json:"name,omitempty"`
	Path             string   `yaml:"path,omitempty" json:"path,omitempty"`
	Command          string   `yaml:"command,omitempty" json:"command,omitempty"`
	Interval         Duration `yaml:"interval,omitempty" json:"interval"`
	Timeout          Duration `yaml:"timeout,omitempty" json:"timeout"`
	InitialDelay     Duration `yaml:"initial_delay,omitempty" json:"initial_delay"`
	FailureThreshold int      `yaml:"failure_threshold,omitempty" json:"failure_threshold"`
	SuccessThreshold int      `yaml:"success_threshold,omitempty" json:"success_threshold"`
}
type Dependency struct {
	Condition string `yaml:"condition" json:"condition"`
}
type Dependencies map[string]Dependency

func (d *Dependencies) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.SequenceNode {
		var ids []string
		if e := n.Decode(&ids); e != nil {
			return e
		}
		*d = Dependencies{}
		for _, id := range ids {
			(*d)[id] = Dependency{"running"}
		}
		return nil
	}
	type plain Dependencies
	return strictNode(n, (*plain)(d))
}

type AutoStart struct {
	Enabled bool     `yaml:"enabled" json:"enabled"`
	Delay   Duration `yaml:"delay" json:"delay"`
}

func (a *AutoStart) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		return n.Decode(&a.Enabled)
	}
	a.Enabled = true
	type plain AutoStart
	return strictNode(n, (*plain)(a))
}

type Stop struct {
	Command string   `yaml:"command,omitempty" json:"command,omitempty"`
	Shell   bool     `yaml:"shell,omitempty" json:"shell,omitempty"`
	Signal  string   `yaml:"signal,omitempty" json:"signal"`
	Timeout Duration `yaml:"timeout,omitempty" json:"timeout"`
}
type Docker struct {
	ComposeFile string   `yaml:"compose_file,omitempty" json:"compose_file"`
	ProjectName string   `yaml:"project_name,omitempty" json:"project_name"`
	Profiles    []string `yaml:"profiles,omitempty" json:"profiles"`
	EnvFiles    []string `yaml:"env_files,omitempty" json:"env_files"`
	Args        []string `yaml:"args,omitempty" json:"args"`
	StopMode    string   `yaml:"stop_mode,omitempty" json:"stop_mode"`
}
type Restart struct {
	Policy      string   `yaml:"policy,omitempty" json:"policy"`
	MaxAttempts int      `yaml:"max_attempts,omitempty" json:"max_attempts"`
	Delay       Duration `yaml:"delay,omitempty" json:"delay"`
	Backoff     string   `yaml:"backoff,omitempty" json:"backoff"`
}
type Port struct {
	Name string `yaml:"name" json:"name"`
	Port int    `yaml:"port" json:"port"`
}
type App struct {
	ID             string            `yaml:"-" json:"id"`
	Name           string            `yaml:"name" json:"name"`
	Description    string            `yaml:"description,omitempty" json:"description"`
	Group          string            `yaml:"group,omitempty" json:"group"`
	Type           string            `yaml:"type" json:"type"`
	Cwd            string            `yaml:"cwd" json:"cwd"`
	Start          Command           `yaml:"start" json:"start"`
	Stop           Stop              `yaml:"stop,omitempty" json:"stop"`
	RestartCommand Command           `yaml:"restart_command,omitempty" json:"restart_command"`
	Status         Command           `yaml:"status,omitempty" json:"status"`
	Logs           Command           `yaml:"logs,omitempty" json:"logs"`
	Docker         Docker            `yaml:"docker,omitempty" json:"docker"`
	Health         Check             `yaml:"health,omitempty" json:"health"`
	Detect         Check             `yaml:"detect,omitempty" json:"detect"`
	DependsOn      Dependencies      `yaml:"depends_on,omitempty" json:"depends_on"`
	Autostart      AutoStart         `yaml:"autostart,omitempty" json:"autostart"`
	Env            map[string]string `yaml:"env,omitempty" json:"env"`
	EnvFile        []string          `yaml:"env_file,omitempty" json:"env_file"`
	InheritEnv     *bool             `yaml:"inherit_env,omitempty" json:"inherit_env"`
	Links          map[string]string `yaml:"links,omitempty" json:"links"`
	Ports          []Port            `yaml:"ports,omitempty" json:"ports"`
	Tags           []string          `yaml:"tags,omitempty" json:"tags"`
	Icon           string            `yaml:"icon,omitempty" json:"icon"`
	Favorite       bool              `yaml:"favorite,omitempty" json:"favorite"`
	Notes          string            `yaml:"notes,omitempty" json:"notes"`
	Restart        Restart           `yaml:"restart,omitempty" json:"restart"`
	Notifications  *bool             `yaml:"notifications,omitempty" json:"notifications"`
	Lifecycle      struct {
		StopOnExit bool `yaml:"stop_on_localdesk_exit" json:"stop_on_localdesk_exit"`
	} `yaml:"lifecycle,omitempty" json:"lifecycle"`
}
type Group struct {
	Name  string `yaml:"name" json:"name"`
	Order int    `yaml:"order" json:"order"`
}
type Profile struct {
	Name      string    `yaml:"name" json:"name"`
	Apps      []string  `yaml:"apps" json:"apps"`
	Autostart AutoStart `yaml:"autostart,omitempty" json:"autostart"`
}
type Logging struct {
	MaxSizeMB     int `yaml:"max_size_mb" json:"max_size_mb"`
	MaxFiles      int `yaml:"max_files" json:"max_files"`
	RetentionDays int `yaml:"retention_days" json:"retention_days"`
}
type Config struct {
	Version int `yaml:"version" json:"version"`
	Server  struct {
		Host        string `yaml:"host" json:"host"`
		Port        int    `yaml:"port" json:"port"`
		OpenBrowser *bool  `yaml:"open_browser" json:"open_browser"`
		Token       string `yaml:"token,omitempty" json:"-"`
	} `yaml:"server" json:"server"`
	Defaults struct {
		StopTimeout       Duration `yaml:"stop_timeout" json:"stop_timeout"`
		LogRetentionDays  int      `yaml:"log_retention_days" json:"log_retention_days"`
		DependencyTimeout Duration `yaml:"dependency_timeout" json:"dependency_timeout"`
	} `yaml:"defaults" json:"defaults"`
	Logging  Logging `yaml:"logging" json:"logging"`
	Terminal struct {
		Command string `yaml:"command" json:"command"`
	} `yaml:"terminal" json:"terminal"`
	Notifications bool               `yaml:"notifications" json:"notifications"`
	Groups        map[string]Group   `yaml:"groups" json:"groups"`
	Profiles      map[string]Profile `yaml:"profiles" json:"profiles"`
	Apps          map[string]App     `yaml:"apps" json:"apps"`
	GlobalActions struct {
		Exclude []string `yaml:"exclude" json:"exclude"`
	} `yaml:"global_actions" json:"global_actions"`
}

func strictNode(n *yaml.Node, value any) error {
	b, e := yaml.Marshal(n)
	if e != nil {
		return e
	}
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	return d.Decode(value)
}
func Path() string {
	if p := os.Getenv("LOCALDESK_CONFIG"); p != "" {
		return Expand(p, "")
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".localdesk", "config.yml")
}
func Expand(p, base string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		h, _ := os.UserHomeDir()
		p = filepath.Join(h, strings.TrimPrefix(strings.TrimPrefix(p, "~"), "/"))
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(base, p)
	}
	a, _ := filepath.Abs(p)
	return a
}
func Load(path string) (*Config, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	return Parse(b, filepath.Dir(path))
}
func Parse(b []byte, base string) (*Config, error) {
	var c Config
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	if e := d.Decode(&c); e != nil {
		return nil, fmt.Errorf("configuration: %w", e)
	}
	var extra yaml.Node
	if err := d.Decode(&extra); err != io.EOF {
		if err != nil {
			return nil, fmt.Errorf("configuration: %w", err)
		}
		return nil, fmt.Errorf("configuration must contain one YAML document")
	}
	if c.Version != 1 {
		return nil, fmt.Errorf("version must be 1")
	}
	if c.Server.Host == "" {
		c.Server.Host = "127.0.0.1"
	}
	if c.Server.Port == 0 {
		c.Server.Port = 49152
	}
	if c.Server.Port < 1 || c.Server.Port > 65535 {
		return nil, fmt.Errorf("server.port must be between 1 and 65535")
	}
	ip := net.ParseIP(c.Server.Host)
	if ip == nil {
		return nil, fmt.Errorf("server.host must be an IP address")
	}
	if !ip.IsLoopback() && len(c.Server.Token) < 32 {
		return nil, fmt.Errorf("server.token must contain at least 32 characters when binding beyond localhost")
	}
	if c.Defaults.StopTimeout == 0 {
		c.Defaults.StopTimeout = Duration(10 * time.Second)
	}
	if c.Defaults.DependencyTimeout == 0 {
		c.Defaults.DependencyTimeout = Duration(60 * time.Second)
	}
	if c.Logging.MaxSizeMB == 0 {
		c.Logging.MaxSizeMB = 25
	}
	if c.Logging.MaxFiles == 0 {
		c.Logging.MaxFiles = 5
	}
	if c.Logging.RetentionDays == 0 {
		c.Logging.RetentionDays = c.Defaults.LogRetentionDays
	}
	if c.Logging.RetentionDays == 0 {
		c.Logging.RetentionDays = 14
	}
	if c.Logging.MaxSizeMB < 1 || c.Logging.MaxFiles < 1 || c.Logging.RetentionDays < 1 {
		return nil, fmt.Errorf("logging values must be positive")
	}
	if c.Apps == nil {
		c.Apps = map[string]App{}
	}
	if c.Groups == nil {
		c.Groups = map[string]Group{}
	}
	if c.Profiles == nil {
		c.Profiles = map[string]Profile{}
	}
	names := map[string]bool{}
	for id, a := range c.Apps {
		prefix := "apps." + id
		if !ValidID(id) {
			return nil, fmt.Errorf("%s: use letters, digits, underscores or hyphens for IDs", prefix)
		}
		a.ID = id
		if a.Name == "" {
			a.Name = id
		}
		if names[a.Name] {
			return nil, fmt.Errorf("%s.name duplicates %q", prefix, a.Name)
		}
		names[a.Name] = true
		if a.Type == "" {
			a.Type = "process"
		}
		switch a.Type {
		case "process", "shell", "docker-compose", "custom":
		default:
			return nil, fmt.Errorf("%s.type: unknown runner %q", prefix, a.Type)
		}
		if a.Group != "" {
			if _, ok := c.Groups[a.Group]; !ok {
				return nil, fmt.Errorf("%s.group: unknown group %q", prefix, a.Group)
			}
		}
		a.Cwd = Expand(a.Cwd, base)
		if s, e := os.Stat(a.Cwd); e != nil || !s.IsDir() {
			return nil, fmt.Errorf("%s.cwd: directory does not exist: %s", prefix, a.Cwd)
		}
		if a.Type == "shell" {
			a.Start.Shell = true
		}
		if a.Type != "custom" && (a.Stop.Command != "" || a.Status.Command != "" || a.RestartCommand.Command != "" || a.Logs.Command != "") {
			return nil, fmt.Errorf("%s: stop/status/restart/log commands require type custom", prefix)
		}
		if a.Type != "docker-compose" && a.Start.Command == "" {
			return nil, fmt.Errorf("%s.start.command is required", prefix)
		}
		if a.Type == "custom" && a.Stop.Command == "" && a.Status.Command != "" {
			return nil, fmt.Errorf("%s.stop.command is required for custom status-managed apps", prefix)
		}
		if a.Stop.Timeout == 0 {
			a.Stop.Timeout = c.Defaults.StopTimeout
		}
		if a.Stop.Signal == "" {
			a.Stop.Signal = "TERM"
		}
		switch strings.TrimPrefix(a.Stop.Signal, "SIG") {
		case "TERM", "INT", "QUIT", "HUP", "KILL":
		default:
			return nil, fmt.Errorf("%s.stop.signal is invalid", prefix)
		}
		if a.Restart.Policy == "" {
			a.Restart.Policy = "never"
		}
		switch a.Restart.Policy {
		case "never", "always", "on-failure":
		default:
			return nil, fmt.Errorf("%s.restart.policy is invalid", prefix)
		}
		if a.Restart.MaxAttempts == 0 {
			a.Restart.MaxAttempts = 5
		}
		if a.Restart.MaxAttempts < 0 {
			return nil, fmt.Errorf("%s.restart.max_attempts must be positive", prefix)
		}
		if a.Restart.Delay == 0 {
			a.Restart.Delay = Duration(3 * time.Second)
		}
		if a.Restart.Backoff != "" && a.Restart.Backoff != "fixed" && a.Restart.Backoff != "exponential" {
			return nil, fmt.Errorf("%s.restart.backoff must be fixed or exponential", prefix)
		}
		if a.Docker.StopMode == "" {
			a.Docker.StopMode = "stop"
		}
		if a.Docker.StopMode != "stop" && a.Docker.StopMode != "down" {
			return nil, fmt.Errorf("%s.docker.stop_mode must be stop or down", prefix)
		}
		if a.Type == "docker-compose" {
			if a.Docker.ProjectName == "" {
				a.Docker.ProjectName = id
			}
			if a.Docker.ComposeFile == "" {
				a.Docker.ComposeFile = "compose.yml"
			}
			if _, e := os.Stat(Expand(a.Docker.ComposeFile, a.Cwd)); e != nil {
				return nil, fmt.Errorf("%s.docker.compose_file: %w", prefix, e)
			}
		}
		for _, cmd := range []Command{a.Start, a.RestartCommand, a.Status, a.Logs, {Command: a.Stop.Command, Shell: a.Stop.Shell}} {
			if cmd.Shell && len(cmd.Args) > 0 {
				return nil, fmt.Errorf("%s: shell commands cannot also specify args; place arguments in command", prefix)
			}
			if !cmd.Shell && cmd.Command != "" {
				if _, e := shellwords.Parse(cmd.Command); e != nil {
					return nil, fmt.Errorf("%s.command: %w", prefix, e)
				}
			}
		}
		for _, p := range a.EnvFile {
			if _, e := os.Stat(Expand(p, a.Cwd)); e != nil {
				return nil, fmt.Errorf("%s.env_file: %w", prefix, e)
			}
		}
		for _, p := range a.Ports {
			if p.Port < 1 || p.Port > 65535 {
				return nil, fmt.Errorf("%s.ports: invalid port", prefix)
			}
		}
		for _, u := range a.Links {
			v, e := url.Parse(u)
			if e != nil || v.Host == "" || (v.Scheme != "http" && v.Scheme != "https") {
				return nil, fmt.Errorf("%s.links: only absolute HTTP(S) URLs are allowed", prefix)
			}
		}
		if e := check(&a.Health, prefix+".health", a.Cwd); e != nil {
			return nil, e
		}
		if e := check(&a.Detect, prefix+".detect", a.Cwd); e != nil {
			return nil, e
		}
		c.Apps[id] = a
	}
	for id, a := range c.Apps {
		for dep, d := range a.DependsOn {
			if _, ok := c.Apps[dep]; !ok {
				return nil, fmt.Errorf("apps.%s.depends_on: missing app %q", id, dep)
			}
			if d.Condition != "" && d.Condition != "running" && d.Condition != "healthy" {
				return nil, fmt.Errorf("apps.%s.depends_on.%s.condition is invalid", id, dep)
			}
			if d.Condition == "healthy" && c.Apps[dep].Health.Type == "" {
				return nil, fmt.Errorf("apps.%s.depends_on.%s requires a health check", id, dep)
			}
		}
	}
	if _, e := c.Order(c.IDs()); e != nil {
		return nil, e
	}
	for id, p := range c.Profiles {
		if !ValidID(id) {
			return nil, fmt.Errorf("invalid profile ID %q", id)
		}
		for _, a := range p.Apps {
			if _, ok := c.Apps[a]; !ok {
				return nil, fmt.Errorf("profiles.%s.apps: missing app %q", id, a)
			}
		}
		if p.Name == "" {
			p.Name = id
			c.Profiles[id] = p
		}
	}
	for _, id := range c.GlobalActions.Exclude {
		if _, ok := c.Apps[id]; !ok {
			return nil, fmt.Errorf("global_actions.exclude: missing app %q", id)
		}
	}
	return &c, nil
}
func check(c *Check, prefix, cwd string) error {
	if c.Type == "" {
		return nil
	}
	if c.Type == "port" {
		c.Type = "tcp"
	}
	switch c.Type {
	case "http":
		u, e := url.Parse(c.URL)
		if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
			return fmt.Errorf("%s.url must be an HTTP(S) URL", prefix)
		}
	case "tcp":
		if c.Port < 1 || c.Port > 65535 {
			return fmt.Errorf("%s.port must be between 1 and 65535", prefix)
		}
		if c.Host == "" {
			c.Host = "127.0.0.1"
		}
	case "command":
		if c.Command == "" {
			return fmt.Errorf("%s.command is required", prefix)
		}
	case "process":
	case "pidfile":
		if c.Path == "" {
			return fmt.Errorf("%s.path is required", prefix)
		}
		c.Path = Expand(c.Path, cwd)
	case "docker":
	default:
		return fmt.Errorf("%s.type is invalid", prefix)
	}
	if strings.HasSuffix(prefix, "detect") && c.Type == "process" && c.Name == "" {
		return fmt.Errorf("%s.name is required", prefix)
	}
	if c.Interval == 0 {
		c.Interval = Duration(5 * time.Second)
	}
	if c.Timeout == 0 {
		c.Timeout = Duration(2 * time.Second)
	}
	if c.FailureThreshold == 0 {
		c.FailureThreshold = 3
	}
	if c.SuccessThreshold == 0 {
		c.SuccessThreshold = 1
	}
	if c.FailureThreshold < 1 || c.SuccessThreshold < 1 {
		return fmt.Errorf("%s thresholds must be positive", prefix)
	}
	return nil
}
func ValidID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
func (c *Config) IDs() []string {
	ids := []string{}
	for id := range c.Apps {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
func (c *Config) Order(ids []string) ([]string, error) {
	out := []string{}
	seen := map[string]int{}
	var visit func(string) error
	visit = func(id string) error {
		if seen[id] == 1 {
			return fmt.Errorf("dependency cycle includes %s", id)
		}
		if seen[id] == 2 {
			return nil
		}
		a, ok := c.Apps[id]
		if !ok {
			return fmt.Errorf("unknown app %q", id)
		}
		seen[id] = 1
		deps := []string{}
		for d := range a.DependsOn {
			deps = append(deps, d)
		}
		sort.Strings(deps)
		for _, d := range deps {
			if e := visit(d); e != nil {
				return e
			}
		}
		seen[id] = 2
		out = append(out, id)
		return nil
	}
	for _, id := range ids {
		if e := visit(id); e != nil {
			return nil, e
		}
	}
	return out, nil
}

const Sample = `# LocalDesk configuration. Add apps here or use Discover in the dashboard.
# Full schema: docs/configuration.md. Paths are relative to this file unless absolute.
version: 1
server:
  host: 127.0.0.1
  port: 49152
  open_browser: true
logging:
  max_size_mb: 25
  max_files: 5
  retention_days: 14
groups:
  development:
    name: Development
    order: 10
profiles: {}
apps: {}
`

func Init(path string) error {
	if _, e := os.Stat(path); e == nil {
		return nil
	}
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	_, e = f.WriteString(Sample)
	return e
}
func Redacted(a App) App {
	a.Env = clone(a.Env)
	for k := range a.Env {
		a.Env[k] = "[redacted]"
	}
	return a
}
func clone(m map[string]string) map[string]string {
	n := map[string]string{}
	for k, v := range m {
		n[k] = v
	}
	return n
}
