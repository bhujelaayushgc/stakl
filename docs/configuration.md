# Configuration reference

`version: 1` is required. Unknown fields, duplicate YAML keys, duplicate app names, invalid checks/durations/ports, unknown runners/groups/dependencies, and dependency cycles are rejected. Error messages include YAML line information or a field path. Validation is side-effect free: it does not execute commands.

Paths resolve relative to the configuration directory, except Compose env files, app env files, and PID files, which resolve relative to the app's working directory. `~/` expands the current home directory. Environment interpolation in YAML is intentionally not performed: literal values stay literal. `$VARIABLE` expansion belongs in an explicitly enabled shell command.

## Add and edit apps in the dashboard

On **Applications**, choose **Add app** to configure a local service through a form. Select Process for an executable with separate arguments, Shell for shell syntax, Docker Compose for a Compose file, or Custom for a service controlled by your own commands. Enter a display name, working directory, and start command or Compose file. The app ID is generated from the name; you can change it before adding the app.

To discover projects instead, choose **Discover apps**, scan a directory, and select **Review & add**. The same form opens with the detected settings filled in. Review the command before saving; discovery identifies project files, not necessarily the correct entry point.

The **Group** selector lets you choose an existing group, leave the app ungrouped, or **Create group...**. A new group and its app assignment are saved together. Canceling the editor saves neither.

Expand the sections below the common settings for command arguments and shutdown, Compose options, environment variables/files, health and detection checks, dependencies, autostart/restart behavior, links, ports, tags, and notifications. Each argument has its own row, so an argument containing spaces stays one argument. Blank optional settings and **Default** choices use the configuration defaults. Durations accept Go syntax such as `500ms`, `5s`, and `1m`. Environment values are visible while editing and stored in the local configuration file.

For an existing local app, open its details, select **Configuration**, and choose **Edit app**. Use the same form to change settings or move the app to another group. Existing IDs stay fixed to preserve dependencies, profiles, and history. Edit connected-host apps on their own controller.

The **Form** and **YAML** buttons switch between controls and the YAML for this app. Invalid YAML must be corrected before returning to the form or saving. Apps using anchors, aliases, or merges are directed to the full **Configuration** editor so their source relationships stay intact.

Saving validates the complete configuration, creates a backup, and reloads it. It does not start or restart a service. Updated command and environment settings take effect on the next start or restart; a running service keeps its current process settings. Navigation and Cancel ask before discarding an edited draft. If the file changed since the editor opened, saving retains your draft and offers **Reload configuration**; accepting reload discards the draft and loads the current file.

## Global configuration

```yaml
version: 1
server:
  host: 127.0.0.1
  port: 49152
  open_browser: true
  # Required if host is not loopback. Use at least 32 random characters.
  # token: ...
  # Set both to enable native HTTPS; paths are relative to this config directory.
  # tls_cert_file: tls-cert.pem
  # tls_key_file: tls-key.pem

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

## HTTPS and headless peers

### Enable access from the dashboard

Each machine runs its own Stakl controller and dashboard. To let another dashboard connect here:

1. Start Stakl normally and open **Hosts > Access from other machines**.
2. Select this machine's LAN or VPN IP address and a free peer port (49153 by default), then select **Enable access**. Stakl generates a self-signed certificate and opens a separate HTTPS endpoint for scoped peer connections. The local dashboard, CLI, and services keep running.
3. Under **Local peer access**, issue a named **Read** or **Control** grant. Read includes service details, status, health, history, and logs. Control adds per-app start, stop, and restart. Copy the token immediately; it is shown once.
4. On the connecting machine's dashboard, use **Hosts > Add host**. Enter a display name, the copied HTTPS endpoint, the grant token, and the public certificate in **Trusted CA PEM**. These details are available together in the grant dialog when the peer endpoint is running.

The endpoint is this machine's reachable address and peer port, for example `https://192.168.1.20:49153`. The two machines must have network connectivity, and the selected port must be allowed by your firewall. Stakl does not change firewall or router settings. Use a LAN or VPN address; the setup excludes loopback, wildcard, multicast, and link-local addresses.

This setup does not require editing YAML or creating an administration token. The additional endpoint serves only scoped peer operations, not the dashboard, configuration editor, or grant administration. Certificates are verified by the connecting Stakl controller; you do not need to install this certificate in your browser.

Settings and generated certificate/private-key material are saved in mode-0600 `peer-access.json` beside `instance.json` and restored on controller startup. Keep this file private and back it up separately; `stakl backup` does not include it. Do not copy it to provision another host. Only the public certificate is shown in Hosts. The certificate lasts one year. If it expires or a new address is not covered by its SANs, disable the endpoint and explicitly select **Replace saved certificate** when enabling again, then update the saved certificate trust on connecting dashboards. Stakl never silently replaces an existing certificate.

**Disable access** closes this peer endpoint and its active connections without stopping services or deleting grants. Re-enabling reuses a valid saved certificate. Disable before changing the address or port. If the endpoint cannot start after a restart, Hosts shows the error while the local dashboard remains available.

If you separately configured network HTTPS on the primary listener, disabling this additional endpoint leaves that route of access available. Revoke a grant to withdraw its permissions on every listener. Connections are one-way; connecting both directions requires issuing a grant and adding a host on each machine.

### Manually configure the primary HTTPS listener

Create a certificate without starting a controller:

```sh
stakl --config /path/to/config.yml tls init --host peer.example
```

Use the DNS name or IP address that other machines will connect to. This creates `tls-cert.pem` and `tls-key.pem` beside the configuration with private file permissions. The self-signed ECDSA certificate lasts one year and includes `localhost`, `127.0.0.1`, `::1`, and the supplied host as SANs. Existing files, including partial pairs, are preserved.

Configure the pair and a strong full administration token for remote binding:

```yaml
server:
  host: 0.0.0.0
  port: 49152
  open_browser: false
  token: REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS
  tls_cert_file: tls-cert.pem
  tls_key_file: tls-key.pem
```

Start with `stakl --config /path/to/config.yml --no-browser`. Local CLI commands automatically trust the configured public certificate and verify its SAN. Custom DNS-only certificates also work on IP or wildcard listeners: the CLI verifies a certificate DNS identity while keeping the connection pinned to the configured listener IP, without resolving or routing administration traffic to that DNS name. Server binding, token, and TLS setting changes require a controller restart; replacing certificate files also requires restarting to load them.

Issue a scoped credential from the running controller:

```sh
stakl peer tokens create --name Laptop                  # read access by default
stakl peer tokens create --name Laptop --access control # per-app start/stop/restart
stakl peer tokens list
stakl peer tokens revoke GRANT_ID
```

Creation prints metadata and the token once. Lists contain only metadata. Transfer the **public `tls-cert.pem`** to the connecting machine as its trusted PEM, together with the scoped token and `https://peer.example:49152` endpoint. Certificate chains and DNS/IP SANs must verify; there is no insecure TLS option. A headless peer does not require its certificate to be installed in the hub browser. `stakl open` opens the local HTTPS dashboard; the generated certificate includes its local IP SAN, and using that self-signed certificate in a browser requires trusting the public certificate there. For a custom DNS-only certificate, browser access instead needs a certificate-covered hostname that maps to the listener. The local CLI's separate TLS identity does not change browser certificate verification.

Keep `tls-key.pem` on the peer and back it up separately; `stakl backup` does not include TLS files. State database backups retain controller identity and peer credentials. Do not copy a state database to create a second independent controller.

### Connecting from a dashboard

1. On the peer, enable access in **Hosts > Access from other machines** as above. Alternatively configure native HTTPS manually, or keep its HTTP listener on loopback and establish the tunnel below.
2. In the peer dashboard's **Hosts > Local peer access**, issue a named grant. Read includes details, history, health, and logs. Control adds only per-app start, stop, and restart. Alternatively use the `peer tokens` CLI commands above with the peer's `--config` path.
3. Copy the one-time token. In the hub dashboard, open **Hosts > Add host**. Enter a display name, the endpoint (for example `https://peer.example:49152`), the peer token, and the public certificate PEM if needed. Connection requires a successful identity handshake.
4. Select the host or **All hosts** in Applications. Open a row to inspect that host's tabs. Remote configuration is redacted and read-only. A remote `localhost` link is labeled with its host instead of opening on your computer; remote ports are observations, not browser reachability checks.

For an SSH tunnel, leave the peer listening at `127.0.0.1:49152` and run this on the machine running the hub:

```sh
ssh -N -L 127.0.0.1:49160:127.0.0.1:49152 user@peer.example
```

Register `http://127.0.0.1:49160` on the hub using a scoped peer token. Keep the tunnel running yourself. HTTP is accepted only for verified loopback destinations; direct LAN HTTP is rejected. Stakl does not create or manage tunnels.

Use **Edit** to rename a connection or explicitly replace its endpoint, token, or certificate trust. Saved tokens are never returned to the browser. Leaving the token blank retains it. Select certificate replacement with an empty PEM to return to system certificate roots. **Reconnect** immediately verifies the peer again. **Remove** forgets the connection and cached snapshot without stopping services or revoking the peer grant. Revoke that grant on the issuing peer when access is no longer wanted; active log streams close, but an already accepted action can still finish.

Connection states distinguish unavailable, unauthorized, incompatible protocol, and changed controller identity. Cached rows are marked stale and cannot be controlled. The controller connection indicator describes browser-to-hub connectivity separately. If an action reports **Outcome unknown**, inspect refreshed state and history before deciding whether to act again. Stakl never automatically retries a lifecycle action.

Keep the state directory and its backups private. The mode-0600 database contains recoverable outbound connection credentials, hashed issued tokens, and the persistent controller identity. Backups preserve these; TLS private keys need separate backup. Copying this database to another independent host duplicates its identity and is not a way to provision a new peer.

## App fields

| Field | Meaning / default |
| --- | --- |
| map key | Stable ID: letters, digits, `_`, `-`; used by CLI and persistence |
| `name` | Display name, defaults to ID; must be unique |
| `description` | Short row description |
| `group` | Optional existing group ID |
| `type` | `process` (default), `shell`, `docker-compose`, `custom`, `external` (observation only) |
| `cwd` | Existing working directory; defaults to config directory |
| `start` | Required for process, shell, and custom apps; unavailable for observation-only apps |
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
| `detect` | External-availability check; required for observation-only apps |
| `ports` | List of `{name, port}`; warns/refuses duplicate start if occupied |
| `links` | Named absolute HTTP(S) URLs |
| `restart` | Bounded restart policy |
| `notifications` | Per-app override of global desktop notifications |
| `lifecycle.stop_on_stakl_exit` | Stop workload on controller shutdown; default false |
| `tags`, `icon`, `favorite`, `notes` | Optional metadata; type determines default UI icon |

Browser favorites can override initial `favorite` values locally. `icon` accepts terminal, box, server, activity, layers, code, folder, or heart; unknown/omitted values use the runner type icon. New configuration takes effect for the next launch. Active workloads keep the launch-time cwd, environment, stop settings and runner identity, so a config edit cannot retarget a stop action.

## Gradual adoption of existing services

Use **Observation only** to bring an existing service into the dashboard while keeping its current process manager.

1. Open **Ports** and select **Observe** beside an unassociated TCP listener. Stakl fills in a TCP detection target and port; wildcard addresses become a local loopback target.
2. Review the name and detection address. Select a group or create one in the same form. Add health checks, links, notes, or dependencies as needed.
3. Select **Add app**. Stakl periodically checks availability and displays **Running externally** when detected. Saving never launches or takes ownership of the service.

For Compose projects, scan their directory through **Discover apps** and select **Observe existing**. Review the Compose file and set **Project name** to the existing name shown by `docker compose ls`. Discovery finds configuration files; it does not establish whether their containers are running. Stakl uses read-only `docker compose ps` inspection and can show containers and published ports. Docker inspection failures produce unknown state.

You can also use **Add app**, choose **Observation only**, and configure detection manually. UDP listeners need an explicit process-name, PID-file, or command check; a TCP probe cannot verify a UDP service. Process checks require a name, including health checks for observation-only entries. Use non-mutating commands for checks.

```yaml
apps:
  existing-api:
    name: Existing API
    type: external
    group: development
    detect: {type: tcp, host: 127.0.0.1, port: 8000}
    health: {type: http, url: 'http://127.0.0.1:8000/health'}
    links: {API: 'http://127.0.0.1:8000'}
```

Detection proves that the configured endpoint or check is available. It does not verify that a listener still belongs to the originally discovered process; a replacement service on the same port can satisfy the check. Discovered PIDs are never persisted as ownership credentials. If detection fails, the entry displays **Stopped**, meaning not detected by its check.

Observation-only entries cannot configure launch/control commands, autostart, automatic restarts, or shutdown cleanup. Start, stop, restart, and force-kill requests are refused by the backend. Global and profile operations skip direct control of these entries; managed apps can still depend on their `running` or `healthy` condition. An unavailable observed dependency blocks its dependents without starting the external service. Logs remain with the existing service manager.

Observation settings can be edited or removed while the external service keeps running. To move into managed operation, explicitly change the app type and configure its supported runner; arrange the handoff from the existing manager yourself. A Stakl-owned workload must be stopped before changing to observation-only mode. Connected dashboards can view observations through the existing host connection; discovery and configuration editing happen on the service's own host.

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

Env files accept comments, blank lines, optional `export`, and quoted single-line values. Variable names cannot be empty or contain whitespace, `=`, or null bytes. Values cannot contain null bytes. Env files do not execute shell syntax, interpolate other variables, or support multiline values. Later files override earlier files, then `env` overrides both. All environment values are redacted in effective-config API responses. Raw YAML is available only after explicitly revealing the editor, and logs can naturally contain secrets printed by your programs.

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
  stop_on_stakl_exit: false
```

`never` is the default. `always` includes clean unexpected exits. `on-failure` includes nonzero exits and unexpected disappearance of owned command-managed services. Backoff is fixed unless set to exponential, capped at five minutes. A manual start resets attempts; explicit stop cancels retries. See [process management](process-management.md).

## Reload and editing

`stakl config validate` validates without a controller. The running controller checks the YAML file for changes every second, validates the whole document, and atomically switches the active configuration only on success. Invalid changes remain on disk for correction; the dashboard continues with the last valid configuration and displays the error.

App changes do not restart workloads. Stop an app before removing it from the config. Server host, port or token changes need a controller restart. Autostart is evaluated on controller startup, not on every config reload.

The dashboard's optional editor validates before writing, checks a source revision to reject stale saves, makes a timestamped `.bak` copy, atomically saves, then reloads. If live reload rejects a server-setting change or removal of an active app, the editor restores the previous file and reports the error. Backup files contain the complete previous config, so protect them like the original.

## Files and reset

`stakl backup` writes a private ZIP containing config and a consistent SQLite snapshot. It does not copy projects or log files. Preserve the complete state directory if migrating active launch records on the same machine; a database backup alone does not confer process ownership.

`stakl reset-state --yes` takes the controller lock and refuses to reset active or unverified launches. It removes only known database/instance files. Configuration, logs, launch records, and project directories remain intact.
