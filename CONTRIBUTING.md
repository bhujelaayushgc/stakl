# Contributing

Thanks for improving Stakl. Keep changes focused, preserve the process-ownership safety model, and include a regression check for non-trivial behavior.

## Setup

Use Go 1.26 or newer and Node.js 22 or newer.

```sh
make build test lint
make integration
```

Run `make browser-test` for dashboard changes and `make docker-test` for Compose changes. These targets use isolated temporary workspaces and require Chromium or Docker respectively.

## Pull requests

- Explain the user-visible problem and the chosen fix.
- Update documentation when behavior or configuration changes.
- Do not commit generated `bin/`, `dist/`, or `web/dist/` output.
- Keep unrelated formatting and refactors out of the change.

By contributing, you agree that your contribution is licensed under the MIT License.
