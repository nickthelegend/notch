# Observability — Notch → HydraDB

Notch records its agent activity as **spans and log lines in the same graph the
events, the baton and the brain already live in**. Every turn, tool call, baton
handoff, route step and memory fold becomes a span; every agent message, tool
call, edit, decision and error becomes a log line correlated to the span it
happened inside; and the metric series the dashboard draws are derived from
those spans on read. You get the whole fleet in one place: latency, cost, token
usage, error rates, the critical path across agents — and, from a slow span, the
log lines saying what the agent was actually doing while it was slow.

The span *shape* still follows the OpenTelemetry [GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). What changed
is the destination: there is no collector, no OTLP egress and no second
database.

## Why one store

The old design shipped OTLP to a separate telemetry stack and read it back over
SQL. That worked, and it cost three things this design does not pay:

- **Nothing can be out of sync.** A span sits one hop from the event that
  produced it and the memory that turn learned. There is no window in which the
  dashboard and the event log disagree because one of them has not ingested yet.
- **Nothing degrades.** The Logs view used to have to say "the query store isn't
  answering" as a first-class state, because the telemetry store could be down
  while the daemon was up. Now "the store is down" and "the daemon is down" are
  the same condition, reported once.
- **Nothing to provision.** No collector endpoint, no ingestion key, no second
  set of containers to bring up before a demo.

## How it works

Notch's daemon is already a stream of `LoomEvent`s. The observability layer
(`src/observability/index.ts`) folds the notable ones into spans and log
records; `TelemetryStore` (`src/hydra/telemetry.ts`) batches them into HydraDB.

| Concern | Module |
|---|---|
| Event → span / metric mapping (pure) | `src/observability/index.ts` |
| Event → log record (pure) | `src/observability/logs.ts` |
| Metric datapoint shapes (pure) | `src/observability/metrics.ts` |
| Batched writes and reads | `src/hydra/telemetry.ts` |
| Span / metric read-back for the Observatory | `src/observability/insights.ts` |
| Log read-back | `src/observability/logs-query.ts` |
| Per-agent root-cause | `src/observability/triage.ts` |

Writes are batched — 64 rows or 400 ms, whichever comes first — and chained, so
a burst of events is a handful of round trips rather than one per event. A write
that fails is **requeued and logged**, never dropped silently: telemetry must
not break a turn, and it must not lie about having been written either.

In the graph:

```
(:Project)-[:HAS_SPAN]->(:Span {trace, span, ts, name, ms, code, msg,
                                agent, ade, model, tin, tout, cost, hfrom, hto})
(:Project)-[:HAS_LOG]-> (:LogLine {ts, level, agent, body, trace, kind})
```

Both hang off the project by an edge rather than a property, because a property
scan is a full scan of every project's rows — 2.27s versus 0.010s for the same
answer on a 74k-row graph.

Event → span mapping:

| LoomEvent | Span | Key attributes |
|---|---|---|
| `run_complete` | `gen_ai.agent.turn` | `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cost_usd`, duration |
| `tool_call` | `gen_ai.tool.call` | `gen_ai.tool.name` |
| `handoff` | `notch.baton.handoff` | `notch.handoff.from`, `notch.handoff.to` |
| `route_*` | `notch.route.<phase>` | `notch.route.id` |
| `memory_add/update/forget` | `notch.memory.<op>` | `notch.memory.kind`, `notch.memory.scope` |
| `error` | `notch.error` (status code 2) | message |

One trace per agent turn: minted when a turn starts, reused by every span in
that turn, retired when it ends — so the waterfall shows a real span tree per
turn instead of one orphan per event. A turn ends on `run_complete` **or**
`error`; an adapter that dies never reaches completion, and treating only the
happy path as an ending would leave the trace open forever.

### Metrics

Metrics are **derived from the turn spans on read** rather than stored
separately, so a chart and the span list behind it cannot disagree.

| Metric | Unit | What it charts |
|---|---|---|
| `notch.turns` | `1` | Turns that reached completion |
| `notch.cost.usd` | `USD` | Money an adapter *reported* spending on a turn |
| `gen_ai.client.token.usage` | `1` | Tokens a turn consumed (input + output) |
| `gen_ai.client.operation.duration` | `ms` | Turn duration — charted as an average, not a sum |

These four names are the default set the Observatory's metric explorer queries
when a caller names none (`NOTCH_METRIC_NAMES` in
`src/observability/insights.ts` — a constant in the code, not a knob). Asking
for a name outside that set returns nothing rather than an invented series.

Nothing emits a zero to keep a chart's line alive — a flat zero and "nothing
happened" look identical on a graph and only one of them is true. The same rule
governs cost: an adapter that reports tokens but no cost produces token points
and no cost point, never a cost point of `0`.

### Logs

Every agent message, tool call, file edit, decision, route step, budget pause
and error becomes one log line. When the event happened inside a turn it carries
that turn's trace id, so the Trace Waterfall can show the lines that belong to
it. Severity is mapped without inflation: an agent speaking is INFO, a failed
turn is ERROR, something a human must look at but that isn't a failure (blocked
on input, over budget, a suggested handoff) is WARN, adapter lifecycle chatter
is DEBUG. Nothing is FATAL.

A log line carries a trace id but **no span id**: a line is emitted by an event,
and only some events produce a span. An invented span id would render as a link
to nothing.

## Self-heal reads the same data

The watcher counts an agent's error spans (`code = 2`) and its fencing
violations over a 10-minute window with a `strong` read, and pauses an agent at
3 errors **or 1 fenced write** — a stale writer is by definition an agent that
has lost track of whether it may act. A paused agent is refused the baton, and
the pause lifts itself once the errors stop. Thresholds are constants in
`src/daemon/server.ts` (`HEAL_THRESHOLDS`), not per-install tuning: this decides
whether an agent is taken out of rotation, and a rule you cannot recite is a rule
nobody can trust.

## Turn it off

```bash
export NOTCH_TELEMETRY_DISABLED=1
```

That is the whole switch, and it is there because the test suite needs one —
writing a span per event would triple every test's round trips to prove nothing
about the test. It is not a degradation path: with it unset, telemetry always
lands, because the store it lands in is the one the daemon already cannot run
without.

## Configuration

Telemetry has no endpoint of its own — it writes to the project's graph, so it
is configured by the same variables as everything else.

| Variable | Default | What it does |
|---|---|---|
| `HYDRA_URL` | `http://127.0.0.1:8443` | The node. |
| `HYDRA_TOKEN` | `local-development-token-32-bytes` | Bearer token. |
| `HYDRA_GRAPH` / `HYDRA_NAMESPACE` / `HYDRA_CELL` | `default` / `default` / `cell-0` | Which graph and cell. |
| `HYDRA_TIMEOUT_MS` | `30000` | Per-request budget. |
| `NOTCH_TELEMETRY_DISABLED` | — | `1` stops spans and logs being recorded. |
| `NOTCH_HEAL_DISABLED` | — | `1` stops the self-heal watcher. |
| `NOTCH_HEAL_WATCH_MS` | `60000` | How often the watcher evaluates every project. |
| `NOTCH_HEAL_RECHECK_MS` | `60000` | How long a paused agent waits before being re-checked. |
| `NOTCH_HEAL_MAX_RETRIES` | `3` | Re-checks before a pause is left for a human. |

These three are not telemetry — they steer the LLM-backed read-back features,
and exist so those paths can be made deterministic:

| Variable | Default | What it does |
|---|---|---|
| `NOTCH_TRIAGE_NO_LLM` | — | `1` makes triage skip the model entirely and return the deterministic heuristic. `src/observability/triage.ts` |
| `NOTCH_DECISION_MODEL` | `claude-haiku-4-5-20251001` | The model used to extract decisions from a turn's output. `src/observability/decisions.ts` |
| `NOTCH_DECISIONS_NO_CLI` | — | `1` stops decision extraction from shelling out to a signed-in CLI when there's no `ANTHROPIC_API_KEY`; it falls through to the regex extractor. `src/observability/decisions.ts` |

The classification and evidence behind triage are deterministic either way; only
the prose is model-written.

## Verify it's flowing

Run a turn, then ask the graph directly:

```bash
curl -s "$HYDRA_URL/v1/graphs/default/query" \
  -H "authorization: Bearer $HYDRA_TOKEN" -H 'content-type: application/json' \
  -d '{"cell_id":"cell-0","consistency":"strong","page_size":512,
       "query":"MATCH (p:Project)-[:HAS_SPAN]->(s:Span) WHERE s.name = $n RETURN s.ts AS ts, s.agent AS agent, s.ms AS ms, s.cost AS cost ORDER BY ts DESC LIMIT 20",
       "parameters":{"n":"gen_ai.agent.turn"}}' | jq '.rows'
```

Follow `next_cursor` (carrying `query_id`) if it comes back non-null — see the
`hydra-cypher-queries` skill for why that is not optional.

Or from the UI: the Observatory's **Metrics**, **Logs** and **Provenance** tabs
all print where their data came from, and the Provenance tab shows the live
HydraDB strip — node, cell, storage sequence and the write it just round-tripped.

## Test it

The fold, the store and the read-back are covered end to end against a real
node:

```bash
npm test -- observability          # unit: the event → span/metric/log mappers
npm test -- observability-signals  # the log-record and metric-op mapping rules
npm test -- observability-export   # integration: real turns → spans in HydraDB
npm test -- insights-signals       # log and metric read-back, real rows
npm test -- triage                 # root-cause from real spans
npm test -- self-heal              # error spans and fenced writes → quarantine
```
