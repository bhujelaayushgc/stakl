# Internal API

All routes require `Authorization: Bearer <instance token>` or the authenticated browser cookie. Mutation requests additionally require `X-Stakl: 1`. Browser origins and Host are checked. The private instance descriptor supplies the CLI address/token. Tokens must not be committed to source control.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/apps` | Config (environment redacted), effective launch config, runtime, containers, ports |
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
| GET | `/api/config` | Path, groups, profiles, logging, active validation error |
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
