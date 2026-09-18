# Examples

Replace directories and ports with your own. These snippets belong under `apps:`. They do not install OS services.

## Node / Vite

```yaml
vite:
  name: Web frontend
  type: process
  cwd: ~/Development/web
  start: {command: npm run dev, args: [--, --host, 127.0.0.1]}
  ports: [{name: Web, port: 5173}]
  health: {type: http, url: 'http://127.0.0.1:5173'}
  links: {app: 'http://127.0.0.1:5173'}
```

## Rails

```yaml
rails:
  name: Rails API
  type: process
  cwd: ~/Development/api
  start: {command: bundle exec rails server}
  env: {RAILS_ENV: development, PORT: '3000'}
  env_file: [.env.local]
  health: {type: http, url: 'http://127.0.0.1:3000/up', initial_delay: 5s}
  depends_on:
    postgres: {condition: running}
```

## Python / uv

```yaml
python-api:
  name: Python API
  type: process
  cwd: ~/Development/python-api
  start: {command: uv run python server.py}
  health: {type: tcp, host: 127.0.0.1, port: 8000}
```

For activation logic, use `type: shell` and `start.command: 'source .venv/bin/activate && python server.py'`. Ensure your selected `$SHELL` supports `source` (portable `/bin/sh` uses `.`).

## Go

```yaml
go-api:
  type: process
  cwd: ~/Development/go-api
  start: {command: go run .}
  stop: {signal: INT, timeout: 5s}
  ports: [{name: HTTP, port: 8080}]
```

## Docker Compose

```yaml
infra:
  type: docker-compose
  cwd: ~/Development/infra
  docker: {compose_file: compose.yml, project_name: local-infra}
  health: {type: docker}
```

## MCP HTTP server

```yaml
mcp:
  name: MCP memory
  type: process
  cwd: ~/Development/memory
  start: {command: npm start}
  health: {type: tcp, host: 127.0.0.1, port: 8110}
  detect: {type: tcp, host: 127.0.0.1, port: 8110}
  autostart: {delay: 3s}
```

Stdio-only MCP servers normally belong to the client that owns their stdin. Use a persistent HTTP/SSE transport when managing them independently with LocalDesk; there is no interactive stdin terminal in the dashboard.

## External PostgreSQL

```yaml
postgres:
  name: PostgreSQL (external)
  type: custom
  cwd: ~
  start: {command: 'pg_isready -h 127.0.0.1 -p 5432'}
  detect: {type: tcp, host: 127.0.0.1, port: 5432}
  health: {type: tcp, host: 127.0.0.1, port: 5432}
  ports: [{name: PostgreSQL, port: 5432}]
```

No stop command is supplied, so external PostgreSQL stays protected. The start command merely checks availability; it does not install or start PostgreSQL.

## Profile with dependencies

```yaml
profiles:
  full-stack:
    name: Full stack
    apps: [postgres, rails, vite]
apps:
  # Include the definitions above, then configure Rails:
  rails:
    cwd: ~/Development/api
    start: {command: bundle exec rails server}
    depends_on:
      postgres: {condition: healthy}
```

PostgreSQL needs its health definition for `condition: healthy`. Profile Start reports each app's result. Profile Stop stops only explicitly selected apps, in reverse dependency order; it does not stop extra shared dependencies. External processes remain protected and produce an explicit refusal in the result.

## Custom daemonizing tool

```yaml
custom-tool:
  type: custom
  cwd: ~/Development/tool
  start: {command: ./tool start}
  stop: {command: ./tool stop, timeout: 10s}
  status: {command: ./tool status}
  restart_command: {command: ./tool restart}
  logs: {command: ./tool logs --follow}
```

Status returns zero if running and nonzero if stopped. Start/stop/status commands should terminate promptly; `logs` can remain running. Custom stop/restart commands are trusted and can operate on external tools, so make their own targeting precise.
