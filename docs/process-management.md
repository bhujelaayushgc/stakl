# Process management

## Launch contract

Use `process` for a foreground executable. `start.command` is split using shell quoting rules, without variable expansion, globbing, substitution, or shell operators. `args` adds literal arguments. Use `shell` or `start.shell: true` for pipelines, redirection, `source`, and `&&`; the configured `$SHELL` (otherwise `/bin/sh`) runs with `-c` and inherits the controller's environment unless disabled.

```yaml
apps:
  worker:
    type: process
    cwd: /absolute/path/to/project
    start:
      command: python3
      args: [worker.py, --queue, local]
    stop:
      signal: TERM
      timeout: 10s
```

The working directory is resolved relative to the configuration directory. `~/` expands to the current home directory. Executable paths may be relative to the working directory. Commands are trusted configuration, never constructed from app names or browser input.

## Ownership

The controller starts a detached copy of its own executable as a private supervisor. The supervisor starts the workload in its own process group, captures its streams, and exposes an authenticated Unix socket in a private temporary directory. Launch records are written atomically before spawn. Launch tokens and resolved environment values are stored with mode 0600 inside a private `launches` directory.

On controller restart, launch records are reconciled against authenticated supervisor responses. This includes the crash window between creating the supervisor and recording runtime state. PID, PGID, timestamps, exit status, ownership and launch ID are persisted. PID alone never authorizes a kill. Launch records also retain the kernel boot-session ID. A verified change of boot session retires stale launches without signaling any PID, allowing autostart after a machine reboot; a missing supervisor within the same boot remains unverified.

An unresponsive/missing supervisor without a final exit record produces **unknown**. Stakl blocks duplicate starts and refuses to kill that process. Inspect the workload manually; do not remove launch records simply to bypass ownership checks. A verified final exit record permits a fresh launch.

## Stopping

A verified supervisor sends the configured signal to the workload's entire process group. Accepted signals: TERM, INT, QUIT, HUP, KILL (optional SIG prefix). After `stop.timeout` it escalates to KILL. Force kill bypasses the graceful signal, but still requires ownership.

The supervisor uses `waitid(..., WNOWAIT)` to observe the leader's exit without reaping it. Remaining group members are killed before the leader is reaped, so an unrelated reused PID cannot become the target of cleanup. Natural parent exit also triggers group cleanup, preventing ordinary child processes from being orphaned.

Programs can deliberately call `setsid`/`setpgid` to escape their group. Do not use that behavior with a normal process runner. Configure a `custom` runner with explicit start, status, and stop commands for daemonizing tools.

## Controller shutdown

Controller exit leaves apps and log supervisors running by default. Per-app `lifecycle.stop_on_stakl_exit: true` opts into shutdown cleanup. It does not create an OS service. A machine restart stops everything; Stakl autostart runs next time the controller launches.

Keep the binary accessible at its launch path until started supervisors have booted. Once running they do not depend on the controller process. On Linux/macOS, closing a terminal does not terminate a supervisor's separate session.

## Detection and state

Detection can use HTTP, TCP, an exact process-name pattern (`pgrep -x`), a PID file, or a command's zero exit code. Detection proves availability, not ownership. A detected process is shown as **Running externally**. Normal external processes cannot be stopped or force-killed; a custom runner's explicit stop command is the escape hatch.

States are stopped, starting, running, healthy, unhealthy, stopping, failed, external, and unknown. Health does not turn a live process into a stopped one. The UI keeps external ownership visible even when health fails; its separate health field/history captures that result.

## Restarts

```yaml
restart:
  policy: on-failure  # never | on-failure | always
  max_attempts: 5
  delay: 3s
  backoff: exponential  # fixed (default) or exponential, capped at 5m
```

Attempts are bounded across a launch/retry sequence and persisted across controller restart. Manual Start resets the retry budget. Explicit Stop cancels pending retries, including `always`. Health failure alone does not restart an app. Restart means stop then start, except custom apps with `restart_command`. A dependency required healthy is waited on before its dependent starts; a running dependency is left alone.

## Logs and retention

JSONL records contain time, app, launch, stream, sequence, and text. Lines above 64 KiB are split to keep memory bounded. Unterminated output is flushed at exit. The supervisor retains `max_files` rotated files plus a current file. The controller periodically removes old logs and caps total retained bytes per app near `(max_files + 1) * max_size_mb`, protecting active current files. Retention of stopped-app files is enforced while the controller runs. Multiple live logging streams can require more than one protected current file.

History is capped at 50,000 events and 100,000 health samples globally, as well as the retention period. Completed launch metadata is pruned with retention; active/unverified launch records are preserved.
