# Releases

Stable releases promote `dev` through a pull request into `main`. Stable tags use `vX.Y.Z` and must point to a commit already included in `origin/main`. Beta tags use `vX.Y.Z-beta.N`, with `N >= 1`, and must be included in `origin/dev`. Tags are immutable release identities; do not move a published tag to another commit.

## Prepare the release

1. Fetch `origin/main`, `origin/dev`, and tags. Compare every change since the previous stable release, including any uncommitted work that needs to ship.
2. Choose an unused version and prepare a PR description plus user-facing release notes. Cover features, fixes, security changes, upgrade instructions, compatibility limits, and verification results. GitHub's generated notes are a starting point, not the complete changelog.
3. Run frontend tests and a production build, Go race tests and vet, Python checks, vulnerability audits, and isolated process/connected-host integration checks. Cross-compile all four supported platforms. Run available Docker checks and record any unavailable checks. Browser verification can be performed by the maintainer; existing CI also runs the browser suite.
4. Commit the intended source, tests, documentation, and release-workflow changes to `dev`. Do not commit generated binaries or frontend output.
5. Push `dev` and open the release PR with base `main` and head `dev`. Check CI at the PR's current head and satisfy the required approving review. Fix failures before merging.

When releasing with an agent, confirm separately before committing, creating the PR, merging, tagging, and publishing. Preparing drafts and running read-only checks do not publish anything.

## Merge and tag

Prefer a merge commit for the permanent `dev` to `main` release PR so the development history remains connected to the release branch. Keep both branches after merging.

After the merge is approved and complete, fetch again, record the merged `main` commit, and verify its CI. Create an annotated tag at that exact commit, then validate and push only that tag:

```sh
git tag -a vX.Y.Z MERGED_MAIN_SHA -m "Stakl vX.Y.Z"
bash scripts/release-policy.sh vX.Y.Z MERGED_MAIN_SHA
git push origin refs/tags/vX.Y.Z
```

The tag workflow builds the tagged commit using the patched Go version in `go.mod`, tests on macOS and Linux, and produces four archives:

- `stakl-darwin-arm64.tar.gz`
- `stakl-darwin-amd64.tar.gz`
- `stakl-linux-arm64.tar.gz`
- `stakl-linux-amd64.tar.gz`

The release also contains `checksums.txt` and `install.sh`. CI verifies the installer against its build output.

## Review and publish

A stable tag creates a **draft** GitHub release after CI passes. It does not become the latest public release until explicitly published. Beta tags retain automatic prerelease publication and do not become the default installer version.

Before publishing a stable release:

1. Verify tag CI is green at the tagged commit and the release is still a draft.
2. Confirm all six assets are present. Download the four archives and verify them against `checksums.txt`. Check the executable's embedded version on available platforms.
3. Replace the generated notes with the prepared detailed changelog. Review the version, comparison link, upgrade instructions, and limitations.
4. After publication is approved, publish the existing draft as the latest stable release. For example:

```sh
gh release edit vX.Y.Z --repo bhujelaayushgc/stakl \
  --title "Stakl vX.Y.Z" --notes-file /path/to/release-notes.md \
  --draft=false --prerelease=false --latest
```

Verify the public release page, latest-release metadata, installer, checksums, and version again. Use a temporary installation directory for the installer smoke test so it does not replace the maintainer's Stakl installation or touch live workspaces.

Finally, fetch `main` into `dev` with a fast-forward when possible and push the synchronized development branch after confirmation. Do not force-push or delete either permanent branch.

## Upgrade and recovery

The installer replaces only the executable and does not start Stakl or modify its workspace. Stop the controller cleanly before replacing a binary that is in use, then start the new controller with the same configuration.

Back up the configuration, state database, and any TLS private material before upgrading. `stakl backup` provides a consistent database snapshot; primary TLS files and `peer-access.json` require separate backups. Keep backups private because they contain credentials and service configuration.

If an upgrade has problems, select the previous release with `STAKL_VERSION`. An older binary may reject newly added configuration fields or app types, so retain the pre-upgrade configuration and state backup. Do not reset state or delete workloads as a release rollback step.
