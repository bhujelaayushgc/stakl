# Contributing

Thanks for improving Stakl. Keep changes focused, preserve the process-ownership safety model, and include a regression check for non-trivial behavior.

## Setup

Use Go 1.26 or newer and Node.js 22 or newer.

```sh
make build test lint
make integration
```

Run `make browser-test` for dashboard changes and `make docker-test` for Compose changes. These targets use isolated temporary workspaces and require Chromium or Docker respectively.

## Refresh UI screenshots

The README uses screenshots of real disposable processes from the browser suite. After a UI change, run this from the repository root:

```sh
make browser-test
cp web/test-results/*/desktop-light.png docs/images/dashboard.png
cp web/test-results/*/desktop-dark.png docs/images/dashboard-dark.png
cp web/test-results/*/logs.png docs/images/logs.png
cp web/test-results/*/mobile-overview.png docs/images/mobile.png
```

Review all four images before committing. Desktop Applications captures omit empty space below the rows; logs and mobile captures show the full page. Use the isolated test workspace so personal paths, configuration, and credentials do not appear in repository media.

## Pull requests

- Explain the user-visible problem and the chosen fix.
- Update documentation when behavior or configuration changes.
- Do not commit generated `bin/`, `dist/`, or `web/dist/` output.
- Keep unrelated formatting and refactors out of the change.

By contributing, you agree that your contribution is licensed under the MIT License.
