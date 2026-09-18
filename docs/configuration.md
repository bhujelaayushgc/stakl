# Configuration reference

`version: 1` is required. Unknown fields, duplicate YAML keys, duplicate app names, invalid checks/durations/ports, unknown runners/groups/dependencies, and dependency cycles are rejected. Error messages include YAML line information or a field path. Validation is side-effect free: it does not execute commands.

Paths resolve relative to the configuration directory, except Compose env files, app env files, and PID files, which resolve relative to the app's working directory. `~/` expands the current home directory. Environment interpolation in YAML is intentionally not performed: literal values stay literal. `$VARIABLE` expansion belongs in an explicitly enabled shell command.

## Global configuration

```yaml
version: 1
server:
  host: 127.0.0.1
  port: 49152
  open_browser: true
  # Required if host is not loopback. Use at least 32 random characters.
  # token: ...

defaults:
  stop_timeout: 10s
  dependency_timeout: 60s
  log_retention_days: 14  # fallback if logging.retention_days is absent

logging:
  max_size_mb: 25
  max_files: 5
  retention_days: 14

terminal:
  command: wezterm  # executable name/path; omit for Terminal or x-terminal-emulator
notifications: false

global_actions:
  exclude: [postgres]

groups:
  development:
    name: Development
    order: 10
profiles:
  workspace:
    name: Workspace
    apps: [api, worker]
    autostart: false
apps: {}
```

Groups only organize the dashboard. Profile memberships cross group boundaries. Global exclusions omit direct selection for Start All, Stop All, and Restart Running; a dependency of an included app may still be started to satisfy that app. Stopping never implicitly stops dependencies outside the selected set.

All durations use Go syntax (`250ms`, `5s`, `2m`, `1h30m`). Negative durations are rejected. Zero values select the documented default where applicable.

## App fields

| Field | Meaning / default |
| --- | --- |
| map key | Stable ID: letters, digits, `_`, `-`; used by CLI and persistence |
| `name` | Display name, defaults to ID; must be unique |
| `description` | Short row description |
| `group` | Optional existing group ID |
| `type` | `process` (default), `shell`, `docker-compose`, `custom` |
| `cwd` | Existing working directory; defaults to config directory |
| `start` | Required command for non-Compose apps |
| `stop` | Signal, timeout, and optional custom command |
| `restart_command` | Custom runner restart command; otherwise stop + start |
| `status` | Custom runner command: exit 0 means running |
| `logs` | Custom runner log-follow command |
| `env` | Explicit environment map; overlays env files |
| `env_file` | Ordered list of KEY=value files, relative to cwd |
| `inherit_env` | Whether to inherit controller environment; default true |
| `depends_on` | List of IDs or map of ID to condition |
| `autostart` | Boolean or `{enabled: true, delay: 5s}` |
| `health` | Optional periodic health check |
| `detect` | Optional external-availability check |
| `ports` | List of `{name, port}`; warns/refuses duplicate start if occupied |
| `links` | Named absolute HTTP(S) URLs |
| `restart` | Bounded restart policy |
| `notifications` | Per-app override of global desktop notifications |
| `lifecycle.stop_on_localdesk_exit` | Stop workload on controller shutdown; default false |
| `tags`, `icon`, `favorite`, `notes` | Optional metadata; type determines default UI icon |

Browser favorites can override initial `favorite` values locally. `icon` accepts terminal, box, server, activity, layers, code, folder, or heart; unknown/omitted values use the runner type icon. New configuration takes effect for the next launch. Active workloads keep the launch-time cwd, environment, stop settings and runner identity, so a config edit cannot retarget a stop action.

## Commands and environment

```yaml
start:
  command: python3
  args: [server.py, --port, '8000']
  shell: false
stop:
  signal: TERM
  timeout: 10s
  # command: ./tool stop   # custom runner only
  # shell: false
restart_command:
  command: ./tool restart
status:
  command: ./tool status
logs:
  command: ./tool logs --follow

env_file: [.env, .env.local]
env:
  PORT: '8000'
  MODE: development
inherit_env: true
```

Env files accept comments, blank lines, optional `export`, and quoted single-line values. They do not execute shell syntax, interpolate other variables, or support multiline values. Later files override earlier files, then `env` overrides both. All environment values are redacted in effective-config API responses. Raw YAML is available only after explicitly revealing the editor, and logs can naturally contain secrets printed by your programs.

`process` prefers direct execution. `shell` affects the start command; health/status commands are controlled independently. Command checks are explicitly shell commands. Normal custom apps without `status` are supervised foreground processes; custom apps with `status` are treated as daemonizing command-managed services and require `stop.command`.

## Checks

```yaml
health:
  type: http
  url: http://127.0.0.1:8000/health
  interval: 5s
  timeout: 2s
  initial_delay: 3s
  failure_threshold: 3
  success_threshold: 1
```

Health types:

| Type | Fields | Success |
| --- | --- | --- |
| `http` | `url` | HTTP 200-399; redirects are not followed |
| `tcp` | `host` (127.0.0.1), `port` | Connection succeeds |
| `process` | optional `name` | Owned PID alive; with name, `pgrep -x` matches |
| `command` | `command` | Shell command exits zero before timeout |
| `docker` | none | All Compose containers running and none unhealthy/starting |
| `pidfile` | `path` | File contains a live PID; primarily useful for detection |

Detection accepts the same check shapes, with `port` as an alias for `tcp`. Process-name detection requires `name`. PID files establish availability only, never ownership. Example:

```yaml
detect: {type: tcp, host: 127.0.0.1, port: 8000}
# detect: {type: http, url: 'http://127.0.0.1:8000/health'}
# detect: {type: process, name: my-tool}
# detect: {type: pidfile, path: run/server.pid}
# detect: {type: command, command: './tool status'}
```

An unhealthy process remains running. Initial delay skips checks during warmup. Consecutive failure/success thresholds change health classification; thresholds reset on the opposite result. Lifecycle and health changes push through SSE. Detection runs periodically with the app monitor; a configured health interval controls monitoring cadence, otherwise approximately 5 seconds.

## Dependencies

```yaml
depends_on: [postgres, redis]
# Equivalent to running conditions.

# Or:
depends_on:
  postgres: {condition: running}
  redis: {condition: healthy}
```

A healthy condition requires the dependency to define a health check. Startup is topologically ordered and waits up to `defaults.dependency_timeout`. A failed dependency blocks its dependents with an actionable result; independent branches still run. Profile stop uses reverse dependency order for the explicitly selected apps. Shared dependencies are not stopped implicitly.

## Restart and lifecycle

```yaml
restart:
  policy: on-failure
  max_attempts: 5
  delay: 3s
  backoff: exponential
lifecycle:
  stop_on_localdesk_exit: false
```

`never` is the default. `always` includes clean unexpected exits. `on-failure` includes nonzero exits and unexpected disappearance of owned command-managed services. Backoff is fixed unless set to exponential, capped at five minutes. A manual start resets attempts; explicit stop cancels retries. See [process management](process-management.md).

## Reload and editing

`localdesk config validate` validates without a controller. The running controller checks the YAML file for changes every second, validates the whole document, and atomically switches the active configuration only on success. Invalid changes remain on disk for correction; the dashboard continues with the last valid configuration and displays the error.

App changes do not restart workloads. Stop an app before removing it from the config. Server host, port or token changes need a controller restart. Autostart is evaluated on controller startup, not on every config reload.

The dashboard's optional editor validates before writing, checks a source revision to reject stale saves, makes a timestamped `.bak` copy, atomically saves, then reloads. A syntactically valid config that changes server settings or removes active apps can save successfully but fail live reload; correct it or restart as instructed. Backup files contain the complete previous config, so protect them like the original.

## Files and reset

`localdesk backup` writes a private ZIP containing config and a consistent SQLite snapshot. It does not copy projects or log files. Preserve the complete state directory if migrating active launch records on the same machine; a database backup alone does not confer process ownership.

`localdesk reset-state --yes` takes the controller lock and refuses to reset active or unverified launches. It removes only known database/instance files. Configuration, logs, launch records, and project directories remain intact.
