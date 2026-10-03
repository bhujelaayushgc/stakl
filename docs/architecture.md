# Architecture

Stakl is one executable with three entry modes: browser/API controller, CLI client, and private detached launch supervisor. A runner registry provides process/shell, Docker Compose and custom runners. The manager owns dependency ordering, transitions, health, restart policies, profiles and events. YAML owns configuration; SQLite owns runtime snapshots, health samples and lifecycle history. Rotated JSONL files own logs.

## Ownership and lifecycle

Each process launch starts a detached copy of Stakl in private supervisor mode. The supervisor starts the workload in a separate Unix process group and owns its stdout/stderr. It serves a private authenticated Unix socket, using a cryptographically random launch token stored in a mode-0600 launch file. The controller records the launch ID. On restart it must authenticate to that supervisor before claiming ownership. It never signals a persisted PID. A kernel boot-session ID distinguishes machine reboots from controller restarts and safely retires previous-boot launches before autostart. TERM (or configured signal) goes to the entire live workload group, followed by KILL after timeout. A completed parent triggers child-group cleanup. The supervisor persists final exit information. Controller shutdown leaves supervisors alive unless configured otherwise. Unix-specific mechanics live in platform files; Windows requires a job-object implementation before support can be enabled.

Docker and custom daemonizing commands use runner status/detection, with explicit stop logic. A detected external normal process is never killed. A lost supervisor becomes unknown/external and blocks duplicate starts until explicitly resolved by an operator.

## Model and operations

App config includes runner, commands, cwd, environment, health/detection, dependencies, restart/lifecycle policy, links and metadata. Runtime tracks status, ownership, launch, PID/group, timestamps, last exit, errors, health and retries. Profile operations return per-app outcomes. A serialized operation gate prevents conflicting lifecycle operations while independent health monitoring and SSE continue. This intentionally favors predictable local control over parallel bulk throughput.

## API and UI

REST under /api exposes apps, profiles, config validation/save/reload, discovery, system state and history. SSE /api/events sends invalidations; app log SSE streams persisted JSONL with replay. Mutation requests require an authenticated local session and same-origin checks. A private instance descriptor enables CLI discovery; an OS lock ensures a single controller per state directory. Remote binding requires a configured bearer token.

The UI is an operating surface: a neutral navigation rail, a utility bar for controller connection and theme, profile rows above a grouped application ledger, and inline counts, search, filters, and favorites. Applications, Ports, Activity, Configuration, and System are separate destinations; discovery opens from Applications. A focused detail pane provides Overview, Logs, Health, History, and Configuration tabs. Destination URLs preserve the view, filters, selected application, and detail tab across reloads and browser navigation. On mobile, navigation becomes a drawer and detail panes fill the screen. The command palette exposes the same real API actions. See [current screenshots](../README.md#dashboard) and [the UI design system](ui-design-system.md).

## Connected controllers

Each host runs the same controller and retains its local manager, ownership checks, configuration, dependencies, health checks, and detached supervisors. The browser talks only to its hub. `internal/hosts` owns connection validation, fixed-path authenticated peer requests, cached snapshots, and cancellation. The peer protocol is one hop; connected peers are never recursively aggregated.

SQLite stores a persistent random controller ID, registered endpoints/credentials/trust, and hashed issued grants. Hub credentials remain recoverable for outbound authentication and are never included in descriptions. Read grants expose redacted observations and logs; control adds per-app start/stop/restart. TLS checks certificate chains and SANs. Only loopback HTTP is accepted, redirects and inherited proxies are disabled, and forwarding cannot select arbitrary upstream paths. Each mutation verifies identity before forwarding and includes the expected ID for a second check at the target manager boundary.

The hub polls snapshots every five seconds with at most four concurrent requests, a five-second deadline, a 16 MiB limit, and failure backoff capped at thirty seconds. Stale snapshots retain historical state but never authorize actions. Mutations have a two-minute deadline and are never retried. Stream reads have a forty-five-second idle timeout and cancel on disconnect, removal, revocation, or controller shutdown. Losing the hub or peer controller leaves independently supervised workloads running.

The dashboard keeps browser-to-hub and peer connectivity separate. Row, favorite, and pending-operation identity combines controller ID and app ID. Existing URLs stay local; `host=all` or a registered routing ID selects scope, and `app_host` selects a detail target within All hosts. Obsolete reads and streams are canceled on selection changes. Local Profiles, Ports, Activity, Configuration, System, and Discovery retain local semantics.
