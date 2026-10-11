#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Release policy: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail 'expected a release tag and commit'
tag=$1
number='(0|[1-9][0-9]*)'

if [[ "$tag" =~ ^v${number}\.${number}\.${number}$ ]]; then
  source_branch=main
  prerelease=false
elif [[ "$tag" =~ ^v${number}\.${number}\.${number}-beta\.[1-9][0-9]*$ ]]; then
  source_branch=dev
  prerelease=true
else
  fail "invalid release tag '$tag'; use vX.Y.Z or vX.Y.Z-beta.N (N >= 1)"
fi

commit=$(git rev-parse --verify --end-of-options "${2}^{commit}" 2>/dev/null) \
  || fail "cannot resolve release commit '$2'"
source_ref="refs/remotes/origin/$source_branch"
git show-ref --verify --quiet "$source_ref" \
  || fail "origin/$source_branch is missing; fetch full branch history"
git merge-base --is-ancestor "$commit" "$source_ref" \
  || fail "release commit must be included in origin/$source_branch"

printf 'source_branch=%s\nprerelease=%s\n' "$source_branch" "$prerelease"
