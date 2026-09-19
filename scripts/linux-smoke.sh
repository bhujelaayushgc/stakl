#!/bin/sh
# Run inside a disposable Linux container with /binaries mounted read-only.
set -eu
mkdir -p /tmp/stakl-smoke
cat > /tmp/stakl-smoke/config.yml <<'YAML'
version: 1
server: {port: 49152, open_browser: false}
apps:
  worker:
    type: shell
    cwd: /tmp/stakl-smoke
    start: {command: 'echo linux-ready; sleep 120'}
    health: {type: process, interval: 200ms}
    stop: {timeout: 1s}
YAML
export STAKL_CONFIG=/tmp/stakl-smoke/config.yml
binary=/binaries/stakl-linux-arm64
"$binary" --no-browser >/tmp/stakl-smoke/controller.log 2>&1 &
controller=$!
trap '"$binary" stop worker >/dev/null 2>&1 || true; kill "$controller" 2>/dev/null || true' EXIT
for i in $(seq 1 50); do [ -f /tmp/stakl-smoke/instance.json ] && break; sleep .1; done
"$binary" start worker
for i in $(seq 1 50); do state=$("$binary" status); echo "$state" | grep -q healthy && break; sleep .1; done
echo "$state" | grep -q healthy
workload=$(echo "$state" | awk '$1=="worker" {print $3}')
"$binary" logs worker | grep linux-ready
kill -TERM "$controller"
wait "$controller"
kill -0 "$workload"
"$binary" --no-browser >/tmp/stakl-smoke/controller.log 2>&1 &
controller=$!
for i in $(seq 1 50); do [ -f /tmp/stakl-smoke/instance.json ] && break; sleep .1; done
recovered=$("$binary" status | awk '$1=="worker" {print $3}')
[ "$workload" = "$recovered" ]
"$binary" stop worker
if kill -0 "$workload" 2>/dev/null; then echo 'workload survived stop'; exit 1; fi
echo 'PASS: Linux launch, health, logs, survival, ownership recovery, and group stop'
