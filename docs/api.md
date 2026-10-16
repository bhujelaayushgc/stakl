# Internal API

All routes require `Authorization: Bearer <instance token>` or the authenticated browser cookie. Mutation requests additionally require `X-Stakl: 1`. Browser origins and Host are checked. The private instance descriptor supplies the CLI address/token. Tokens must not be committed to source control.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/apps` | Config (environment redacted), effective launch config, runtime, containers, ports, completed observation and latest health evidence |
| GET | `/api/apps/:id` | One application |
| POST | `/api/apps/:id/start`, `/stop`, `/restart`, `/kill` | Per-app result map; errors are actionable strings |
| POST | `/api/apps/:id/directory`, `/terminal` | Platform opener |
| GET | `/api/apps/:id/logs` | Recent JSON log records |
| GET | `/api/apps/:id/logs?follow=true` | SSE log stream; supports Last-Event-ID timestamps |
| GET | `/api/apps/:id/logs?download=true` | Plain-text download of last 10,000 retained lines |
| GET | `/api/apps/:id/health` | Last 100 health results |
| GET | `/api/apps/:id/launches` | Last 100 persisted launch records |
| GET | `/api/apps/:id/history` | Last 200 app events |
| GET | `/api/profiles` | Profile definitions |
| POST | `/api/profiles/:id/start`, `/stop`, `/restart` | Dependency-aware profile operations |
| POST | `/api/actions/start`, `/restart` | Start all / restart running, honoring root exclusions |
| POST | `/api/actions/stop?confirm=true` | Confirmed Stop All |
| GET | `/api/events` | SSE lifecycle/config/health notifications |
| GET | `/api/history` | Last 200 lifecycle events |
| GET | `/api/config` | Path, groups, profiles, safe workspace membership metadata, logging, active validation error |
| GET | `/api/config?raw=true` | Explicitly reveal raw YAML plus source revision |
| POST | `/api/config/validate` | `{yaml: "..."}`; no writes |
| POST | `/api/config/save` | `{yaml: "...", revision: "..."}`; validate, compare revision, backup, save, reload |
| POST | `/api/config/reload` | Reload from disk |
| POST | `/api/discover` | `{path: "~/Development"}`; suggestions only |
| GET | `/api/system/status` | Controller/runtime/storage diagnostics |
| GET | `/api/system/ports` | Local TCP listeners and UDP bindings visible to the current user, with process/PID, address, scan time and warnings; requires `lsof` |
| GET | `/api/system/docker` | Optional Docker daemon check |
| GET | `/api/system/logs` | Last 256 KiB of controller diagnostics |

Operations return a map such as `{"postgres":"ok","api":"dependency postgres did not become healthy"}`. Partial profile failure is not represented as a single success boolean. The CLI turns any failed result into a nonzero exit. Unknown routes and IDs return errors, never shell commands constructed from route text.

SSE events contain `type`, optional `app`, `message`, and `time`. Clients refresh authoritative app data after events and on reconnect. Slow event subscribers drop notifications rather than blocking supervision. Logs are replayed from files and capped per request; a very noisy process can produce more lines than a view's tail budget between updates. The retained log files remain the full record until rotation.

## Project workspaces

These routes require the local administrator session. Peer Read and Control tokens cannot read workspace definitions, schedule their checks, or invoke workspace actions. Connected-host actions use the administrator's existing peer registration and grants.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/api/workspaces` | Workspace readiness, every member's evidence and sanitized check results |
| GET | `/api/workspaces/:id` | One workspace; missing IDs return 404 |
| GET | `/api/workspaces/impact?controller=local&app=postgres` | Known required/optional uses in this controller's definitions; accepts a stable controller identity for remote services |
| POST | `/api/workspaces/:id/check` | Empty body or `{}`; 202 schedules configured probes, coalescing pending work. Request-supplied settings are rejected |
| POST | `/api/workspaces/:id/start` | Start eligible stopped members; report a result for every member, including skipped and already-running services |
| POST | `/api/workspaces/:id/members/:alias/start` | Start one eligible member through its defining controller |
| POST | `/api/workspaces/:id/members/:alias/stop` | Stop one eligible member; shared services require `confirm_shared: true` |

GET requests read cached evidence. Checks run on the workspace controller with four workers, never on the browser or an arbitrary peer. Check responses omit commands, targets, environment files and output. Results expire and begin unknown after controller restart or successful configuration reload. Workspace definitions use the existing revision-protected config APIs. Deleting a definition leaves its services intact.

Member `actions: {start, stop, reason}` describes lifecycle eligibility independently of readiness checks. Views include an opaque `revision`; send it in action requests, for example `{"revision":"<view revision>"}` or `{"revision":"<view revision>","confirm_shared":true}`, to reject stale visible definitions with 409. The dashboard always sends this precondition. Empty bodies and `{}` deliberately operate on the current definition. Arbitrary targets, commands and other execution settings are rejected. Shared-stop confirmation covers known workspace references on this controller, not actual users or private workspaces on another controller.

Action responses contain `{workspace, action, results:[{alias,controller,app,name,action,status,message}]}`. Status is `started`, `stopped`, `already_running`, `skipped`, `failed`, or `outcome_unknown`; diagnostics omit command output and raw upstream errors. A failure does not roll back successful starts. Overlapping actions on the same workspace return 409. Existing app dependencies are honored by their controller and may include apps outside the workspace; workspace membership adds no cross-controller dependency ordering. Config changes stop remaining dispatches, and remote registrations are checked against their stable controller identity. Network loss can leave partial results: inspect current state before deciding whether to retry an uncertain action. Workspace Start schedules configured checks after dispatch, while readiness continues to depend on fresh observations. There is no workspace-wide Stop endpoint.

App views include additive `observed_at` and optional `health_observation: {time, ok}` fields. Recovered runtime metadata alone does not establish freshness. Older peers without these fields remain usable in Applications; their workspace requirements remain unknown. Workspace members expose `observation_fresh` independently of failing project checks so individual service controls can respect freshness without treating a failed probe as lost ownership.

## Connected hosts

Hub administration uses the normal local session and `X-Stakl: 1` mutation header:

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/api/hosts` | Sanitized local and registered host descriptions |
| GET | `/api/hosts/apps` | Array of `{host, groups, apps}` cached envelopes |
| POST | `/api/hosts` | `{name, url, token, ca_pem?}`; authenticated handshake before saving |
| POST | `/api/hosts/:host/update` | Explicit changes to registration fields; omitted credentials/trust retained |
| POST | `/api/hosts/:host/reconnect` | Immediate identity and snapshot check |
| POST | `/api/hosts/:host/remove` | Forget connection; workloads remain running |
| GET | `/api/hosts/:host/apps/:app` | `{host, data}` redacted app view |
| GET | `/api/hosts/:host/apps/:app/health`, `/history`, `/logs` | `{host, data}` retained results |
| GET | `/api/hosts/:host/apps/:app/logs?follow=true` | Raw SSE, preserving event IDs and `Last-Event-ID` |
| GET | `/api/hosts/:host/apps/:app/logs?download=true` | Raw text download |
| POST | `/api/hosts/:host/apps/:app/start`, `/stop`, `/restart` | `{host, data}` where data is the target manager's per-app outcome map |
| GET | `/api/peer-tokens` | Issued grant metadata, no token values |
| POST | `/api/peer-tokens` | `{name, access: "read" or "control"}`; metadata and one-time token |
| POST | `/api/peer-tokens/:id/revoke` | Revoke grant and close its streams |

`local` is the local routing ID. Registered routing IDs are separate from persistent controller IDs. Host descriptions include `id`, `controller_id`, `name`, `url`, `access`, `state`, `stale`, `last_seen`, and sanitized `error`. No successful observation is represented by the zero timestamp. Ordinary forwarding errors contain `{error, state?, outcome_unknown}`. A lost mutation response may mean the action ran; do not automatically retry. A failure after SSE headers emits `connection-error` when possible and closes the stream. Streams/downloads identify the host in `X-Stakl-Host-ID`.

Scoped bearer grants authenticate only `/api/peer/v1/info`, `/snapshot`, `/apps/:app`, app health/history/logs, and (control only) app start/stop/restart. They cannot administer the peer. Lifecycle requests require `X-Stakl-Peer-ID` matching the peer's persistent controller ID. Snapshot and action responses carry peer identity; protocol version is `1`. Snapshots contain only the peer's local apps. Peer tokens require HTTPS or loopback transport.
