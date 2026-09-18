# Docker Compose

Docker is optional. LocalDesk runs Compose v2-compatible commands through the `docker compose` CLI. The System page checks whether the executable and daemon are available. Docker errors include command output so a stopped daemon, invalid project, or missing image is distinguishable.

```yaml
apps:
  infrastructure:
    name: Infrastructure
    type: docker-compose
    cwd: ~/Development/infrastructure
    docker:
      compose_file: compose.yml
      project_name: local-infrastructure
      profiles: [development]
      env_files: [.env.compose]
      args: []
      stop_mode: stop
    health:
      type: docker
      interval: 5s
      initial_delay: 5s
      failure_threshold: 3
    stop:
      timeout: 15s
```

Start uses `up -d`. Stop uses `stop --timeout N` by default and preserves containers/networks. Opt-in `stop_mode: down` removes the Compose runtime and network, without automatically removing volumes. Restart performs stop then up, which works with either stop mode. Force kill uses `docker compose kill` for an owned project. No Docker socket is exposed to the browser.

`compose_file`, project name, profile flags and env-file flags are passed as argument arrays. `docker.args` are extra **global Compose arguments**, before the subcommand. Compose env files and app `env_file` have different purposes: Compose consumes the former, while LocalDesk constructs the command's environment using the latter.

Status reads `docker compose ps --all --format json`, supporting both JSON arrays and one JSON object per line. The detail panel lists container name, service, state, and health. Docker health succeeds when all reported containers are running and none is starting/unhealthy. Containers without a HEALTHCHECK count as healthy when running. Profiles containing successful one-shot containers may prefer a specific HTTP/TCP/command check.

Compose logs run through a detached log supervisor using `logs --follow --no-color --timestamps --tail 200`, entering the same rotating log store and viewer as process logs. A controller restart reattaches to the existing log supervisor.

A Compose project already running when first detected is external. LocalDesk will not stop it automatically. Use Docker directly, or configure an explicit custom runner if adopting externally managed infrastructure is intentional. Projects started by LocalDesk retain ownership in SQLite across controller restarts.

Run `make docker-test` for a real disposable Compose integration check. It uses a unique `localdesk-test-*` project, pulls `busybox:1.37` if needed, and removes only that test project afterward.
