# Observability — Notch → SigNoz

Notch ships its agent activity to [SigNoz](https://signoz.io) as **all three
OpenTelemetry signals — traces, metrics and logs**. Every turn, tool call, baton
handoff, route step, and memory fold your agents produce becomes a span; the
same events are folded into counters and histograms; and every agent message,
tool call, edit, decision and error is also emitted as a log record correlated
to the span it happened inside. You get the whole fleet in one place: latency,
cost, token usage, error rates, the critical path across agents — and, from a
slow span, the log lines saying what the agent was actually doing while it was
slow.

## How it works

Notch's daemon is already a stream of `LoomEvent`s. The observability layer
(`src/observability/`) folds the notable ones into each signal and exports them
over **OTLP/HTTP (JSON)** — no OpenTelemetry SDK dependency, just `fetch`.
Egress is best-effort: if no collector is reachable the POST fails silently and
never touches the agent loop.

| Signal | Endpoint | Module |
|---|---|---|
| Traces | `/v1/traces` | `src/observability/signoz.ts` |
| Metrics | `/v1/metrics` | `src/observability/metrics.ts` |
| Logs | `/v1/logs` | `src/observability/logs.ts` |

All three carry the same `service.name`, `service.namespace = notch` resource
block — SigNoz keys a service off `service.name`, and a mismatch is what makes a
trace and its own logs look like two different apps.

Event → span mapping (using the OpenTelemetry [GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where they
apply):

| LoomEvent | Span | Key attributes |
|---|---|---|
| `run_complete` | `gen_ai.agent.turn` | `gen_ai.agent.id`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cost_usd`, duration |
| `tool_call` | `gen_ai.tool.call` | `gen_ai.tool.name` |
| `handoff` | `notch.baton.handoff` | `notch.handoff.from`, `notch.handoff.to` |
| `route_*` | `notch.route.<phase>` | `notch.route.id` |
| `memory_add/update/forget` | `notch.memory.<op>` | `notch.memory.kind`, `notch.memory.scope` |
| `error` | `notch.error` (ERROR status) | message |

Every span carries `service.name = notch`, plus `notch.project` and
`notch.chat` so you can slice by project and conversation.

### Metrics emitted

Six, all delta temporality — the daemon restarts whenever you edit a config or
upgrade the CLI, which is the case cumulative handles worst.

| Metric | Unit | What it counts |
|---|---|---|
| `gen_ai.client.token.usage` | `{token}` | Tokens an agent turn consumed, split by `gen_ai.token.type` (`input`/`output`) |
| `gen_ai.client.operation.duration` | `s` | Turn duration (histogram, as the convention specifies) |
| `notch.turns` | `{turn}` | Turns that reached completion, by outcome |
| `notch.cost.usd` | `USD` | Money an adapter *reported* spending on a turn |
| `notch.agents.active` | `{agent}` | Agents currently executing a turn |
| `notch.handoffs` | `{handoff}` | Baton handoffs between agents |

These same six names are the default set the Observatory's metric explorer
queries when a caller names none (`NOTCH_METRIC_NAMES` in
`src/observability/insights.ts` — a constant in the code, not a knob).

`gen_ai.client.token.usage` deviates from the convention on purpose: it is a
monotonic sum rather than a histogram, because Notch reports exactly one
input/output pair per turn and the question anyone asks is "how many tokens did
this agent burn today", which a sum answers exactly.

Nothing emits a zero to keep a chart's line alive — a flat zero and "nothing
happened" look identical on a graph and only one of them is true.

### Logs emitted

Every agent message, tool call, file edit, decision, route step, budget pause
and error becomes one OTLP log record. When the event happened inside a turn it
carries that turn's `traceId`/`spanId`, so SigNoz's trace view gets a working
"related logs" tab. Severity is mapped without inflation: an agent speaking is
INFO, a failed turn is ERROR, something a human must look at but that isn't a
failure (blocked on input, over budget, a suggested handoff) is WARN, adapter
lifecycle chatter is DEBUG. Nothing is FATAL.

## Point it at your SigNoz

Self-hosted (the default) needs nothing — Notch exports to
`http://localhost:4318` out of the box. To target another collector or SigNoz
Cloud, set environment variables before starting the daemon:

```bash
# self-hosted collector on another host
export NOTCH_OTEL_ENDPOINT="http://otel-collector:4318"

# SigNoz Cloud
export NOTCH_OTEL_ENDPOINT="https://ingest.<region>.signoz.cloud:443"
export SIGNOZ_INGESTION_KEY="<your-ingestion-key>"

# optional: rename the service in SigNoz
export NOTCH_SERVICE_NAME="notch"
```

`OTEL_EXPORTER_OTLP_ENDPOINT` and `SIGNOZ_ENDPOINT` are also honored.
`SIGNOZ_ACCESS_TOKEN` works in place of `SIGNOZ_INGESTION_KEY`; either becomes
the `signoz-access-token` header.

## Turn it off

Consent is not per-signal — any of these kills all three:

```bash
export DO_NOT_TRACK=1               # or
export NOTCH_TELEMETRY_DISABLED=1   # or
export NOTCH_OTEL=0
```

## Every environment variable

Resolved in `resolveTelemetryConfig` (`src/observability/signoz.ts`) unless
noted.

| Variable | Default | What it does |
|---|---|---|
| `NOTCH_OTEL_ENDPOINT` | `http://localhost:4318` | Collector base URL. `OTEL_EXPORTER_OTLP_ENDPOINT` then `SIGNOZ_ENDPOINT` are the fallbacks, in that order. |
| `NOTCH_SERVICE_NAME` | `notch` | `service.name` on all three signals. |
| `SIGNOZ_INGESTION_KEY` / `SIGNOZ_ACCESS_TOKEN` | — | Sent as `signoz-access-token`. Needed for SigNoz Cloud. |
| `DO_NOT_TRACK` | — | Any truthy value disables **all** telemetry. |
| `NOTCH_TELEMETRY_DISABLED` | — | Same, Notch-specific. |
| `NOTCH_OTEL` | — | `0` disables all telemetry. |
| `NOTCH_OTEL_METRICS` | on | `0` turns off the metrics exporter only; traces and logs keep going. |
| `NOTCH_OTEL_LOGS` | on | `0` turns off the logs exporter only. Volume control — Notch ships every agent message as a log record, which is the point, and also a lot of bytes. |

These four are not telemetry export — they steer the LLM-backed read-back
features, and exist so those paths can be made deterministic:

| Variable | Default | What it does |
|---|---|---|
| `NOTCH_TRIAGE_NO_LLM` | — | `1` makes triage skip the model entirely and return the deterministic heuristic. `src/observability/triage.ts` |
| `NOTCH_DECISION_MODEL` | `claude-haiku-4-5-20251001` | The model used to extract decisions from a turn's output. `src/observability/decisions.ts` |
| `NOTCH_DECISIONS_NO_CLI` | — | `1` stops decision extraction from shelling out to a signed-in CLI when there's no `ANTHROPIC_API_KEY`; it falls through to the regex extractor. `src/observability/decisions.ts` |

The classification and evidence behind triage are deterministic either way; only
the prose is model-written.

## Verify it's flowing

Run a turn, then open SigNoz → **Services** and look for `notch`, or query
traces directly:

```sql
SELECT name, count()
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = 'notch' AND timestamp > now() - INTERVAL 15 MINUTE
GROUP BY name;
```

## Dashboard

A ready-made SigNoz dashboard ships at [`docs/signoz-dashboard.json`](./signoz-dashboard.json).
Import it via **SigNoz → Dashboards → New dashboard → Import JSON**. It reads
the `notch` service's spans and gives you the fleet at a glance.

If your SigNoz version rejects the import (the dashboard schema drifts between
releases), the panels are trivial to rebuild by hand in the Query Builder — data
source **Traces**, filtered to `serviceName = notch`:

| Panel | Type | Filter (add to `serviceName = notch`) | Aggregate | Group by |
|---|---|---|---|---|
| Agent turns / min | Time series | `name = gen_ai.agent.turn` | Count | `gen_ai.agent.id` |
| LLM cost (USD) | Time series | — | Sum of `gen_ai.usage.cost_usd` | — |
| Tokens in / out | Time series | — | Sum of `gen_ai.usage.input_tokens`, `…output_tokens` | — |
| Turn latency p95 | Time series | `name = gen_ai.agent.turn` | p95 of `durationNano` | — |
| Baton handoffs | Value | `name = notch.baton.handoff` | Count | — |
| Errors / min | Time series | `hasError = true` | Count | — |
| By agent | Table | `name = gen_ai.agent.turn` | Count + Sum(cost) | `gen_ai.agent.id` |

## Test it

The exporter and the event→span mapping are covered end to end:

```bash
npm test -- observability          # unit: config, mapper, OTLP payload shape
npm test -- observability-export   # integration: a stand-in OTLP collector
                                   # receives real spans from daemon turns
```
