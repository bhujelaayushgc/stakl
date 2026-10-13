package config

import (
	"strings"
	"testing"
	"time"
)

func TestWorkspaceDefaultsAndSharedUnresolvedReferences(t *testing.T) {
	c, err := Parse([]byte(`version: 1
apps: {}
workspaces:
  a:
    name: A
    services:
      db: {controller: local, app: shared-db}
    checks:
      query:
        service: db
        check: {type: command, command: 'exit 0'}
  b:
    name: B
    services:
      db: {controller: local, app: shared-db, required: false}
`), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := c.Workspaces["a"]
	if !a.Services["db"].Required || a.Services["db"].Condition != "running" || c.Workspaces["b"].Services["db"].Required {
		t.Fatalf("wrong defaults: %+v", c.Workspaces)
	}
	p := a.Checks["query"]
	if p.Check.Interval.Value() != 30*time.Second || p.Check.Timeout.Value() != 2*time.Second || p.Cwd == "" {
		t.Fatalf("wrong probe defaults: %+v", p)
	}
}

func TestWorkspaceRejectsAmbiguousOrIgnoredConfiguration(t *testing.T) {
	tests := []struct{ name, workspace, field string }{
		{"blank name", "name: ' '\nservices: {db: {controller: local, app: db}}", "name"},
		{"no services", "name: A\nservices: {}", "services"},
		{"invalid controller", "name: A\nservices: {db: {controller: remote, app: db}}", "controller"},
		{"invalid app", "name: A\nservices: {db: {controller: local, app: '../db'}}", "app"},
		{"invalid condition", "name: A\nservices: {db: {controller: local, app: db, condition: ready}}", "condition"},
		{"duplicate", "name: A\nservices: {db: {controller: local, app: db}, other: {controller: local, app: db}}", "duplicate"},
		{"missing association", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: other, check: {type: tcp, port: 5432}}}", "service"},
		{"unsupported zero", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: db, check: {type: tcp, port: 5432, initial_delay: 0s}}}", "initial_delay"},
		{"irrelevant empty", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: db, check: {type: tcp, port: 5432, command: ''}}}", "command"},
		{"unsupported type", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: db, check: {type: process}}}", "type"},
		{"zero timeout", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: db, check: {type: tcp, port: 5432, timeout: 0s}}}", "timeout"},
		{"short interval", "name: A\nservices: {db: {controller: local, app: db}}\nchecks: {probe: {service: db, check: {type: tcp, port: 5432, interval: 1s}}}", "interval"},
		{"unknown member field", "name: A\nservices: {db: {controller: local, app: db, typo: true}}", "typo"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := "version: 1\napps: {}\nworkspaces:\n  a:\n    " + strings.ReplaceAll(tt.workspace, "\n", "\n    ") + "\n"
			_, err := Parse([]byte(src), t.TempDir())
			if err == nil || !strings.Contains(err.Error(), tt.field) {
				t.Fatalf("wanted %s error, got %v", tt.field, err)
			}
		})
	}
}
