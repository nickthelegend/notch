# Observability — Notch → SigNoz

Notch ships its agent activity to [SigNoz](https://signoz.io) as OpenTelemetry
traces. Every turn, tool call, baton handoff, route step, and memory fold your
agents produce becomes a span, so you can see the whole fleet in one place:
latency, cost, token usage, error rates, and the critical path across agents.

## How it works

Notch's daemon is already a stream of `LoomEvent`s. The observability layer
(`src/observability/`) folds the notable ones into spans and exports them over
**OTLP/HTTP (JSON)** — no OpenTelemetry SDK dependency, just `fetch`. Egress is
best-effort: if no collector is reachable the POST fails silently and never
touches the agent loop.

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

## Turn it off

```bash
export DO_NOT_TRACK=1            # or
export NOTCH_TELEMETRY_DISABLED=1   # or
export NOTCH_OTEL=0
```

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
