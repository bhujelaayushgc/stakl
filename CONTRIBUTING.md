# Contributing

Thanks for improving Stakl. Keep changes focused, preserve the process-ownership safety model, and include a regression check for non-trivial behavior.

## Setup

Use Go 1.26.9 or newer and a Node.js version supported by the [build requirements](README.md#build-and-run). CI reads the Go version from `go.mod` so tests and release binaries use the same patched toolchain.

```sh
make build test lint
make integration
```

Run `make browser-test` for dashboard changes and `make docker-test` for Compose changes. These targets use isolated temporary workspaces and require Chromium or Docker respectively.

## Refresh UI screenshots

The README uses screenshots of real disposable processes from the browser suite. After a UI change, run this from the repository root:

```sh
make browser-test
cp web/test-results/showcase-*/showcase-dashboard-light.png docs/images/dashboard.png
cp web/test-results/showcase-*/showcase-dashboard-dark.png docs/images/dashboard-dark.png
cp web/test-results/showcase-*/showcase-logs.png docs/images/logs.png
cp web/test-results/showcase-*/showcase-mobile.png docs/images/mobile.png
cp web/test-results/showcase-*/showcase-hosts.png docs/images/hosts.png
cp web/test-results/showcase-*/showcase-app-form.png docs/images/app-form.png
```

Review all images before committing. Desktop Applications captures omit empty space below the rows; logs and mobile captures show the full page. Use the isolated test workspace so personal paths, configuration, and credentials do not appear in repository media.

## Pull requests

Open feature and maintenance pull requests against `dev`. Maintainers promote `dev` to `main` through release pull requests. Dependabot version updates also target `dev`; security updates target the default branch, `main`.

GitHub Actions workflows use full commit SHAs with version comments. Keep these pins when updating Actions; Dependabot maintains the pinned references.

- Explain the user-visible problem and the chosen fix.
- Update documentation when behavior or configuration changes.
- Do not commit generated `bin/`, `dist/`, or `web/dist/` output.
- Keep unrelated formatting and refactors out of the change.

See [the release process](docs/releases.md) for stable releases, beta tags, release notes, and artifact verification.

By contributing, you agree that your contribution is licensed under the MIT License.

## Community and security

Follow the [code of conduct](CODE_OF_CONDUCT.md) in all project spaces. Report abuse through [GitHub's private form](https://github.com/contact/report-abuse), and report security vulnerabilities using the separate process in [SECURITY.md](SECURITY.md).
