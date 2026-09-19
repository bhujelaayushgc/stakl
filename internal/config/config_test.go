package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseAndDependencies(t *testing.T) {
	dir := t.TempDir()
	text := fmt.Sprintf(`version: 1
apps:
  db:
    cwd: %s
    start: {command: "sleep 30"}
    health: {type: tcp, port: 5432}
  api:
    cwd: %s
    start: {command: "sleep 30"}
    depends_on:
      db: {condition: healthy}
    autostart: {delay: 2s}
`, dir, dir)
	c, e := Parse([]byte(text), dir)
	if e != nil {
		t.Fatal(e)
	}
	order, e := c.Order([]string{"api"})
	if e != nil || strings.Join(order, ",") != "db,api" {
		t.Fatalf("order %v: %v", order, e)
	}
	if !c.Apps["api"].Autostart.Enabled || c.Apps["api"].Autostart.Delay.Value() != 2*time.Second {
		t.Fatal("autostart defaults")
	}
	if c.Apps["db"].Stop.Timeout.Value() != 10*time.Second {
		t.Fatal("timeout default")
	}
}
func TestValidationErrors(t *testing.T) {
	dir := t.TempDir()
	base := "version: 1\napps:\n  a:\n    start: {command: sleep}\n"
	cases := map[string]string{"unknown field": base + "    typo: yes\n", "unknown type": base + "    type: kubernetes\n", "duration": base + "    stop: {timeout: eventually}\n", "cycle": base + "    depends_on: [a]\n", "missing dependency": base + "    depends_on: [missing]\n", "invalid check": base + "    health: {type: tcp, port: invalid}\n", "bad port": base + "    health: {type: tcp, port: 99999}\n", "missing cwd": base + "    cwd: /does-not-exist-stakl\n", "duplicate id": base + "  a:\n    start: {command: sleep}\n", "invalid env": base + "    env: {'BAD=NAME': value}\n", "unsafe link": base + "    links: {app: 'javascript:alert(1)'}\n", "remote no auth": "version: 1\nserver: {host: 0.0.0.0}\n"}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			if _, e := Parse([]byte(text), dir); e == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestInitRejectsDirectory(t *testing.T) {
	if e := Init(t.TempDir()); e == nil {
		t.Fatal("accepted a directory as the configuration file")
	}
}
func TestListDependenciesAndRedaction(t *testing.T) {
	c, e := Parse([]byte("version: 1\napps:\n  a:\n    start: {command: sleep}\n    env: {SECRET: hidden}\n  b:\n    start: {command: sleep}\n    depends_on: [a]\n"), t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if c.Apps["b"].DependsOn["a"].Condition != "running" {
		t.Fatal("list dependencies")
	}
	a := Redacted(c.Apps["a"])
	if a.Env["SECRET"] != "[redacted]" || c.Apps["a"].Env["SECRET"] != "hidden" {
		t.Fatal("redaction mutated configuration")
	}
}

func TestLaunchConfigJSONRoundTrip(t *testing.T) {
	c, e := Parse([]byte("version: 1\napps:\n  a:\n    start: {command: sleep}\n    stop: {timeout: 250ms}\n"), t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	b, e := json.Marshal(c.Apps["a"])
	if e != nil {
		t.Fatal(e)
	}
	var a App
	if e = json.Unmarshal(b, &a); e != nil {
		t.Fatal(e)
	}
	if a.Stop.Timeout.Value() != 250*time.Millisecond {
		t.Fatal(a.Stop)
	}
}

func TestHomePathAndStrictNestedFields(t *testing.T) {
	home, e := os.UserHomeDir()
	if e != nil {
		t.Fatal(e)
	}
	if Expand("~", t.TempDir()) != home {
		t.Fatal("bare home expansion")
	}
	for _, text := range []string{
		"version: 1\n---\nversion: 1\n",
		"version: 1\napps:\n  a:\n    start: {command: sleep}\n    autostart: {typo: true}\n",
		"version: 1\napps:\n  a:\n    type: shell\n    start: {command: echo, args: [ignored]}\n",
	} {
		if _, e := Parse([]byte(text), t.TempDir()); e == nil {
			t.Fatal("accepted conflicting or unknown definition", text)
		}
	}
}
