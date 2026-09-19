#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin .dev
if [ ! -d web/node_modules ]; then (cd web && npm ci --legacy-peer-deps); fi
(cd web && npm run build)
go build -o bin/stakl ./cmd/stakl
if [ ! -f .dev/config.yml ]; then bin/stakl --config "$PWD/.dev/config.yml" init; fi
bin/stakl --config "$PWD/.dev/config.yml" --no-browser &
backend_pid=$!
trap 'kill "$backend_pid" 2>/dev/null || true' EXIT INT TERM
for i in {1..50}; do [ -f .dev/instance.json ] && break; sleep .1; done
export STAKL_DEV_TOKEN STAKL_DEV_URL
STAKL_DEV_TOKEN=$(node -p 'JSON.parse(require("fs").readFileSync(".dev/instance.json","utf8")).token')
STAKL_DEV_URL=$(node -p 'JSON.parse(require("fs").readFileSync(".dev/instance.json","utf8")).url')
cd web
npm run dev
