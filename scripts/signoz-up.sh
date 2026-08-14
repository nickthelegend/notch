#!/usr/bin/env bash
# Bring the local SigNoz stack up and tell Notch where to find it.
#
# Notch degrades honestly when SigNoz is down — /insights/spans reports
# `from: "local-log"`, trace ids come back empty and the UI says so — so it is
# easy to run for days on the local event log without noticing that no span has
# reached ClickHouse. This script exists to make the difference explicit and
# repeatable.
#
# The containers are the ones this machine already has (SigNoz's .devenv stack:
# zookeeper + clickhouse + the otel collector), plus a signoz/signoz UI attached
# to the same network. Start order matters: ClickHouse needs its keeper, and the
# collector silently buffers-then-drops if ClickHouse isn't accepting when it
# starts, which looks exactly like "ingestion is broken".
set -euo pipefail

UI_PORT="${SIGNOZ_UI_PORT:-8085}"
CH_URL="${NOTCH_CLICKHOUSE_URL:-http://localhost:8123}"
NET="${SIGNOZ_NETWORK:-signoz-devenv}"

say() { printf "  %s\n" "$*"; }

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker isn't running — start Docker Desktop first."; exit 1; }

say "starting zookeeper…"
docker start zookeeper >/dev/null 2>&1 || say "  (no zookeeper container; skipping)"
sleep 5

say "starting clickhouse…"
docker start clickhouse >/dev/null 2>&1 || say "  (no clickhouse container; skipping)"
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$CH_URL/ping" || true)" = "200" ] && break
  sleep 3
done
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$CH_URL/ping" || true)" = "200" ] \
  || { echo "ClickHouse never came up at $CH_URL"; exit 1; }
say "clickhouse is accepting queries"

# Restarted rather than started: a collector that booted while ClickHouse was
# down keeps failing its exporter until it is bounced.
say "restarting the otel collector…"
docker restart signoz-otel-collector-dev >/dev/null 2>&1 || say "  (no collector container; skipping)"

if ! docker ps --format '{{.Names}}' | grep -q '^signoz-ui$'; then
  say "starting the SigNoz UI on :$UI_PORT…"
  docker rm -f signoz-ui >/dev/null 2>&1 || true
  docker volume create signoz-ui-data >/dev/null 2>&1 || true
  docker run -d --name signoz-ui --network "$NET" -p "$UI_PORT:8080" \
    -v signoz-ui-data:/var/lib/signoz \
    -e SIGNOZ_TELEMETRYSTORE_PROVIDER=clickhouse \
    -e SIGNOZ_TELEMETRYSTORE_CLICKHOUSE_DSN=tcp://clickhouse:9000 \
    -e SIGNOZ_SQLSTORE_PROVIDER=sqlite \
    -e SIGNOZ_SQLSTORE_SQLITE_PATH=/var/lib/signoz/signoz.db \
    -e SIGNOZ_TOKENIZER_JWT_SECRET="${SIGNOZ_JWT_SECRET:-notch-local-dev-secret}" \
    signoz/signoz:latest >/dev/null
fi

SPANS=$(curl -s -m 10 "$CH_URL" --data-binary \
  "SELECT count() FROM signoz_traces.distributed_signoz_index_v3" 2>/dev/null || echo "?")
echo
say "SigNoz is up."
say "  spans currently in ClickHouse: $SPANS"
say "  UI:         http://localhost:$UI_PORT"
say "  ClickHouse: $CH_URL"
echo
say "Start the daemon so its deep links point at that UI:"
say "  NOTCH_SIGNOZ_URL=http://localhost:$UI_PORT loom up"
echo
say "Confirm Notch is reading SigNoz and not the local log — this must say 'signoz':"
say "  curl -s localhost:7420/api/projects/<id>/insights/spans | jq .from"
