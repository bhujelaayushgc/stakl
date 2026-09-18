# Architecture

LocalDesk is one executable with three entry modes: browser/API controller, CLI client, and private detached launch supervisor. A runner registry provides process/shell, Docker Compose and custom runners. The manager owns dependency ordering, transitions, health, restart policies, profiles and events. YAML owns configuration; SQLite owns runtime snapshots, health samples and lifecycle history. Rotated JSONL files own logs.

## Ownership and lifecycle

Each process launch starts a detached copy of LocalDesk in private supervisor mode. The supervisor starts the workload in a separate Unix process group and owns its stdout/stderr. It serves a private authenticated Unix socket, using a cryptographically random launch token stored in a mode-0600 launch file. The controller records the launch ID. On restart it must authenticate to that supervisor before claiming ownership. It never signals a persisted PID. A kernel boot-session ID distinguishes machine reboots from controller restarts and safely retires previous-boot launches before autostart. TERM (or configured signal) goes to the entire live workload group, followed by KILL after timeout. A completed parent triggers child-group cleanup. The supervisor persists final exit information. Controller shutdown leaves supervisors alive unless configured otherwise. Unix-specific mechanics live in platform files; Windows requires a job-object implementation before support can be enabled.

Docker and custom daemonizing commands use runner status/detection, with explicit stop logic. A detected external normal process is never killed. A lost supervisor becomes unknown/external and blocks duplicate starts until explicitly resolved by an operator.

## Model and operations

App config includes runner, commands, cwd, environment, health/detection, dependencies, restart/lifecycle policy, links and metadata. Runtime tracks status, ownership, launch, PID/group, timestamps, last exit, errors, health and retries. Profile operations return per-app outcomes. A serialized operation gate prevents conflicting lifecycle operations while independent health monitoring and SSE continue. This intentionally favors predictable local control over parallel bulk throughput.

## API and UI

REST under /api exposes apps, profiles, config validation/save/reload, discovery, system state and history. SSE /api/events sends invalidations; app log SSE streams persisted JSONL with replay. Mutation requests require an authenticated local session and same-origin checks. A private instance descriptor enables CLI discovery; an OS lock ensures a single controller per state directory. Remote binding requires a configured bearer token.

The UI is an operating surface: narrow navigation, compact summary, profile strip, grouped application rows, searchable/filterable app list and a focused detail panel with overview, logs, configuration, health and history. Configuration and system pages are separate. The command palette exposes the same real API actions.
