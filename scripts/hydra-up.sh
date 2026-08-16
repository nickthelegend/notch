#!/usr/bin/env bash
# Bring a local HydraDB node up and prove it works before saying it works.
#
# The whole product is on this node now: the event log, the baton and the brain
# all live there, and none of them fall back to a local file. So the failure
# mode this script exists to prevent is the one the README warns about — "a
# listening port is not proof; a round-tripped write is". It starts the node,
# waits for readiness, then writes and reads a vertex before printing OK.
#
# One command, no hidden state: it prints what it is doing and round-trips a
# real write before it claims the node is up.
set -euo pipefail

NAME="${HYDRA_CONTAINER:-hydradb}"
IMAGE="${HYDRA_IMAGE:-ghcr.io/hydra-db/hydradb:latest}"
# A named Docker volume, not a host bind mount.
#
# The README's recipe bind-mounts a host directory and runs the container as
# `--user $(id -u):$(id -g)` to make it writable. That works on Linux and fails
# on macOS: the image expects uid 10001 to own its store, and Docker Desktop's
# filesystem does not carry through the ownership the flag implies. The node
# starts, logs `Os { code: 13, kind: PermissionDenied }`, and exits — which
# reads like a config error and is a filesystem one. A named volume sidesteps
# it entirely and is what a working install on this machine actually uses.
VOLUME="${HYDRA_VOLUME:-notch-hydradb-data}"
TOKEN="${HYDRA_TOKEN:-local-development-token-32-bytes}"
BOLT_PORT="${HYDRA_BOLT_PORT:-7687}"
HTTP_PORT="${HYDRA_HTTP_PORT:-8443}"
ADMIN_PORT="${HYDRA_ADMIN_PORT:-9090}"

say() { printf "  %s\n" "$*"; }

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker isn't running — start Docker Desktop first."; exit 1; }

# `--fresh` starts over on an empty store.
#
# Worth having a first-class flag rather than a wiki recipe, for two reasons.
# The graph is shared by every project that has ever opened it, and a dev node
# that has run the test suite for a few weeks carries tens of thousands of
# events from temp projects that no longer exist — enough to make the suite
# itself slow. And HydraDB's `local` object-store backend cannot resume an
# existing store, so a node restarted onto an old volume never comes healthy;
# a fresh volume is the only reset there is.
#
# It deletes the volume, which deletes every project's log, baton and brain on
# this node. That is what "fresh" means, so it says so and asks.
FRESH=0
[ "${1:-}" = "--fresh" ] && FRESH=1
if [ "$FRESH" = "1" ]; then
  say "--fresh: this deletes volume '${VOLUME}' — every project's log, baton and brain on this node."
  if [ -t 0 ] && [ "${HYDRA_FRESH_YES:-}" != "1" ]; then
    printf "  type 'wipe' to confirm: "
    read -r reply
    [ "$reply" = "wipe" ] || { echo "  cancelled"; exit 1; }
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  say "volume removed — starting clean"
fi

probe() {
  curl -sS "http://127.0.0.1:${HTTP_PORT}/v1/graphs/default/query" \
    -H "Authorization: Bearer ${TOKEN}" -H 'X-Graph-Namespace: default' \
    -H 'Content-Type: application/json' \
    --data '{"cell_id":"cell-0","query":"MATCH (n:NotchSmoke) RETURN count(*) AS n"}' -m 5 2>/dev/null
}

if [ "$FRESH" != "1" ] && [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; then
  say "container '${NAME}' is already running"
elif [ "$FRESH" != "1" ] && probe | grep -q '"columns"'; then
  # Somebody else's container — or a source build — is already serving this
  # port and answering queries. Starting ours would fail on the port bind with
  # a docker error that says nothing about why, so say the useful thing instead.
  OWNER="$(docker ps --format '{{.Names}}\t{{.Ports}}' | grep ":${HTTP_PORT}->" | cut -f1 | head -1)"
  say "a HydraDB node is already answering on :${HTTP_PORT}${OWNER:+ (container '${OWNER}')}"
  say "using it as-is — set HYDRA_HTTP_PORT to run a second one alongside"
else
  docker volume create "$VOLUME" >/dev/null
  docker rm -f "$NAME" >/dev/null 2>&1 || true

  # LOCAL_PATH must point at a directory that already exists, so seed the
  # volume's layout and the auth token before the node needs them. A fresh
  # named volume is root-owned, and the image runs as 10001 — so seed as root
  # and hand the tree over, once, here.
  docker run --rm --user 0 -v "$VOLUME:/data" --entrypoint sh "$IMAGE" -c \
    "mkdir -p /data/store /data/cache && printf '%s\n' '$TOKEN' > /data/auth-token && chown -R 10001:10001 /data" >/dev/null

  say "starting ${NAME} from ${IMAGE}…"
  docker run -d --name "$NAME" \
    -p "${BOLT_PORT}:7687" -p "${HTTP_PORT}:8443" -p "${ADMIN_PORT}:9090" \
    -v "$VOLUME:/data" \
    -e CLOUD_PROVIDER=local \
    -e LOCAL_PATH=/data/store \
    -e GRAPH_NAMESPACE=default \
    -e GRAPH_ID=default \
    -e GRAPH_CELL_ID=cell-0 \
    -e GRAPH_CELLS=cell-0 \
    -e GRAPH_NODE_ID=node-0 \
    -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
    -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
    -e GRAPH_DATA_CACHE_DIR=/data/cache \
    -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
    -e GRAPH_ALLOW_PLAINTEXT=true \
    -e RUST_MIN_STACK=33554432 \
    -e GRAPH_MAX_QUERY_RUNTIME_MS="${HYDRA_MAX_QUERY_MS:-60000}" \
    -e GRAPH_MAX_QUERY_SCAN_EDGES="${HYDRA_MAX_SCAN_EDGES:-50000000}" \
    -e GRAPH_MAX_CURSOR_BUFFER_BYTES="${HYDRA_CURSOR_BUFFER:-536870912}" \
    "$IMAGE" >/dev/null
fi

say "waiting for readiness on :${ADMIN_PORT}…"
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${ADMIN_PORT}/readyz" -m 2 >/dev/null 2>&1; then break; fi
  sleep 1
done

# A round-tripped write, not a listening port. RUST_MIN_STACK being unset is the
# classic failure here: the node answers /readyz and then aborts on the first
# query, which looks like a network problem and is not one.
say "round-tripping a write…"
q() {
  curl -sS "http://127.0.0.1:${HTTP_PORT}/v1/graphs/default/query" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'X-Graph-Namespace: default' \
    -H 'Content-Type: application/json' \
    --data "$1" -m 20
}
q '{"cell_id":"cell-0","query":"UNWIND $rows AS row MERGE (n {id: row.id}) SET n:NotchSmoke, n.at = row.at","parameters":{"rows":[{"id":1,"at":1}]}}' >/dev/null
READ=$(q '{"cell_id":"cell-0","query":"MATCH (n:NotchSmoke {id: 1}) RETURN n.at AS at","consistency":"strong"}')

if printf '%s' "$READ" | grep -q '"at"'; then
  echo
  say "HydraDB is up and round-tripping."
  say "  Bolt   127.0.0.1:${BOLT_PORT}"
  say "  HTTP   127.0.0.1:${HTTP_PORT}   (Notch talks to this one)"
  say "  Admin  127.0.0.1:${ADMIN_PORT}/metrics"
  say "  Data   docker volume ${VOLUME}   (wipe with: docker rm -f ${NAME} && docker volume rm ${VOLUME})"
  echo
  say "point Notch at it with:  export HYDRA_URL=http://127.0.0.1:${HTTP_PORT}"
  say "check from the CLI with: loom graph"
else
  echo "the node is listening but a read came back wrong:" >&2
  echo "$READ" >&2
  echo "logs:  docker logs ${NAME} --tail 50" >&2
  exit 1
fi
