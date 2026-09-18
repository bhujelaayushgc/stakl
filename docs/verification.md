# Verification

Verified locally for version 0.1.0:

- `make build test lint`: standalone embedded build, Go race tests, Go vet/format, TypeScript checks, and frontend state tests.
- `python3 scripts/integration.py`: real foreground process/group launch and stop; descendant cleanup; stdout/stderr; dependency health gating; profiles; external service protection; CLI; SSE connection; live config reload; invalid config retention; SQLite/history/launch persistence; graceful controller restart and forced controller crash; recovery after a missing runtime commit; autostart deduplication; single instance; opt-in stop-on-exit; bounded restart exhaustion; custom start/stop/restart/log commands; health recovery; backup/reset.
- `python3 scripts/docker-integration.py`: real uniquely named busybox Compose project; start, health, container status, live logs, restart, stop, force kill, and cleanup.
- `cd web && npm run test:e2e`: real processes driven through Chromium; desktop and mobile navigation; profile operations; streaming log controls; command palette; YAML validation/save; system information; no horizontal overflow at 390px. Captures light/dark dashboard, logs, and mobile screenshots.
- Linux arm64 binary run inside a disposable Linux container: process launch, health, logs, controller shutdown survival, ownership recovery, and group stop (`scripts/linux-smoke.sh`).
- All four macOS/Linux arm64/amd64 binaries cross-compiled successfully. macOS arm64 and Linux arm64 received runtime checks; the other architectures received compilation checks.
- Previous-machine-boot recovery uses mismatched boot-ID fixtures. The user's computer was not rebooted.
- npm reported no known dependency vulnerabilities at installation time.

The suites create temporary state directories, use ephemeral or isolated ports, and clean up only their own processes/projects. Docker and browser tests are explicit targets because they need Docker or a downloaded test browser. Desktop notifications and native Finder/terminal opening are platform integrations, not covered by automated UI tests.
