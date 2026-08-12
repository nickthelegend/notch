---
name: signoz-agent-triage
description: Root-cause a coding agent from its OWN OpenTelemetry traces in SigNoz. Given an agent name (and optionally a Notch project), pull that agent's recent gen_ai / notch spans, find the most recent failure, surface the upstream baton handoff that led into it, and suggest a concrete fix. Use whenever the user asks "why did agent X fail", "triage the fleet", "what went wrong with <agent>", "root-cause this agent", or wants agent-native (self-reading) observability rather than a human staring at a dashboard.
---

# SigNoz Agent Triage

Agent-native observability: an agent reads its **own** traces back out of SigNoz
and explains its last failure. This is the skill behind Notch's per-agent
**⚠ Triage** button (`src/observability/triage.ts`).

## Inputs

- `agent_name` (required) — e.g. `claude-code`, `opencode`, `codex`.
- `project_id` (optional) — the Notch project; defaults to the running one.

## How to run

**Easiest — through a running Notch daemon** (it does the query, the local-log
fallback, and the LLM phrasing for you):

```bash
curl -s "http://127.0.0.1:7421/api/projects/<project_id>/triage/<agent_name>" \
  -H "authorization: Bearer $NOTCH_ADMIN_TOKEN" | jq .triage
# → { rootCause, suggestedFix, evidence[], spanCount, errorCount, source, from }
```

**Directly against SigNoz's ClickHouse** (when Notch isn't up). This is the same
query the daemon runs — the agent's turns plus the handoffs it is part of:

```sql
SELECT toUnixTimestamp64Milli(timestamp) AS ts, name,
       round(duration_nano / 1e6) AS ms, status_code, status_message,
       attributes_number['gen_ai.usage.input_tokens']  AS tin,
       attributes_number['gen_ai.usage.output_tokens'] AS tout
FROM signoz_traces.distributed_signoz_index_v3
WHERE `resource_string_service$$name` = 'notch'
  AND (attributes_string['gen_ai.agent.id']    = '<agent_name>'
       OR attributes_string['notch.handoff.to']   = '<agent_name>'
       OR attributes_string['notch.handoff.from'] = '<agent_name>')
ORDER BY timestamp DESC
LIMIT 40;
```

Run it via `curl "http://localhost:8123/?default_format=JSONEachRow" --data-binary "<sql>"`,
or through the SigNoz MCP (`signoz_execute_builder_query`). For dashboard-panel
SQL use the `signoz-writing-clickhouse-queries` skill.

## Root-cause procedure

1. Pull the agent's last ~40 spans (turns, handoffs, routes, errors).
2. Find the error spans: `status_code = 2`, or span name `notch.error` /
   `notch.route.failed`.
3. Take the **most recent** error and read its `status_message`.
4. Find the **upstream** handoff — the `notch.baton.handoff` whose target is this
   agent (`… -> <agent>`) — so blame points at where the bad state came from.
5. Classify a fix from the message:
   | Message pattern | Fix |
   |---|---|
   | timeout / timed out / deadline | raise the tool/turn timeout or check the upstream service, then re-hand the baton |
   | permission / 401 / 403 / not signed in | re-auth the agent's CLI or refresh its API key |
   | json / malformed / parse / bad request | validate the briefing/JSON before passing the baton |
   | rate / 429 / quota | back off, or route the turn to a fallback agent |
   | exited / crash / killed | restart the agent process and re-hand the baton |
   | model … not supported | switch the agent's model in `.loom/config.json` |
6. If there are **no** error spans, report the agent as healthy (turn count,
   slowest turn) — do not invent a failure.

## Output

2–3 sentences: the root cause (the specific span/turn, the message, and the
upstream handoff), then one concrete fix. Keep it terse and operational — this
gets read at 2am when the fleet is stuck.

## Notes

- GenAI semantic conventions: turns are `gen_ai.agent.turn` with
  `gen_ai.usage.input_tokens` / `output_tokens` / `cost_usd`; handoffs are
  `notch.baton.handoff` with `notch.handoff.from` / `.to`.
- Every Notch span carries `service.name = notch`, `notch.project`, `notch.chat`.
- Inspired by the [SigNoz agent skills](https://github.com/SigNoz/agent-skills).
