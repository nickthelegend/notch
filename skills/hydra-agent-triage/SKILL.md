---
name: hydra-agent-triage
description: Root-cause a coding agent from its OWN spans in HydraDB. Given an agent name (and optionally a Notch project), pull that agent's recent gen_ai / notch spans out of the graph, find the most recent failure, walk back to the baton handoff that led into it, and suggest a concrete fix. Use whenever the user asks "why did agent X fail", "triage the fleet", "what went wrong with <agent>", "root-cause this agent", or wants agent-native (self-reading) observability rather than a human staring at a dashboard.
---

# Hydra Agent Triage

Agent-native observability: an agent reads its **own** spans back out of HydraDB
and explains its last failure. This is the skill behind Notch's per-agent
**⚠ Triage** button (`src/observability/triage.ts`).

The spans live in the same graph as the events that produced them, the baton
claims, and the memory the turn learned — so blame is a traversal, not a join
across two systems.

## Inputs

- `agent_name` (required) — e.g. `claude-code`, `opencode`, `codex`.
- `project_id` (optional) — the Notch project; defaults to the running one.

## How to run

**Easiest — through a running Notch daemon** (it does the query, the
event-log fallback for turns that predate telemetry, and the phrasing):

```bash
curl -s "http://127.0.0.1:7421/api/projects/<project_id>/triage/<agent_name>" \
  -H "authorization: Bearer $NOTCH_ADMIN_TOKEN" | jq .triage
# → { rootCause, suggestedFix, evidence[], spanCount, errorCount, from }
```

`from` says where the evidence came from: `hydradb` when spans answered,
`local-log` when the window predates telemetry, `none` when there is nothing to
read. Never present a `none` triage as a diagnosis.

**Directly against HydraDB** (when the daemon isn't up). Same query the daemon
runs — the agent's spans plus the handoffs it is part of. Find the project node
first: `p.pid` is the absolute path of the project's `.loom` directory.

```bash
curl -s "$HYDRA_URL/v1/graphs/default/query" \
  -H "authorization: Bearer $HYDRA_TOKEN" -H 'content-type: application/json' \
  -d '{
    "cell_id": "cell-0",
    "consistency": "strong",
    "page_size": 512,
    "query": "MATCH (p:Project {pid: $pid})-[:HAS_SPAN]->(s:Span) WHERE s.agent = $agent RETURN s.ts AS ts, s.name AS name, s.ms AS ms, s.code AS code, s.msg AS msg, s.trace AS trace, s.model AS model, s.tin AS tin, s.tout AS tout, s.cost AS cost, s.hfrom AS hfrom, s.hto AS hto ORDER BY ts DESC LIMIT 40",
    "parameters": {"pid": "/abs/path/to/project/.loom", "agent": "<agent_name>"}
  }' | jq '.rows'
```

Two things about that request that are not optional:

- **Follow the cursor.** A response carries `next_cursor`; re-POST with
  `"cursor": <n>` **and** the `query_id` from the first response until it is
  null. A single page silently truncates — 3000 rows in, 1024 out.
- **`consistency: "strong"`** re-verifies against object storage before
  pinning. Use it when the answer decides whether to pause an agent; `causal`
  (the default) is right for a dashboard.

## Root-cause procedure

1. Pull the agent's last ~40 spans (turns, handoffs, routes, errors).
2. Find the error spans: `code = 2`, or span name `notch.error` /
   `notch.route.failed`.
3. Take the **most recent** error and read its `msg`.
4. Find the **upstream** handoff — the `notch.baton.handoff` span whose `hto` is
   this agent — so blame points at where the bad state came from. One hop
   further, `(:Handoff)-[:FROM]->(:Agent)` and the memory units linked by
   `PROJECTED_AT` say what that agent was actually briefed with.
5. Classify a fix from the message:
   | Message pattern | Fix |
   |---|---|
   | timeout / timed out / deadline | raise the tool/turn timeout or check the upstream service, then re-hand the baton |
   | permission / 401 / 403 / not signed in | re-auth the agent's CLI or refresh its API key |
   | json / malformed / parse / bad request | validate the briefing/JSON before passing the baton |
   | rate / 429 / quota | back off, or route the turn to a fallback agent |
   | exited / crash / killed | restart the agent process and re-hand the baton |
   | model … not supported | switch the agent's model in `.loom/config.json` |
   | not the cell writer / stale epoch | the agent was **fenced** — it acted on a tenure it had lost. Re-elect before retrying; do not simply re-run the write. |
6. If there are **no** error spans, report the agent as healthy (turn count,
   slowest turn) — do not invent a failure.

## Output

2–3 sentences: the root cause (the specific span/turn, the message, and the
upstream handoff), then one concrete fix. Keep it terse and operational — this
gets read at 2am when the fleet is stuck.

## Notes

- GenAI semantic conventions: turns are `gen_ai.agent.turn` with
  `gen_ai.usage.input_tokens` / `output_tokens` / `cost_usd`, stored on the node
  as `tin` / `tout` / `cost`; handoffs are `notch.baton.handoff` with
  `hfrom` / `hto`.
- A span is one hop from its project (`(:Project)-[:HAS_SPAN]->(:Span)`), and
  that hop is why triage is fast: scoping by property instead is a full scan of
  every span in the graph — 2.27s versus 0.010s for the same answer.
- Fencing violations are their own nodes: `(:Project)-[:HAS_FENCING]->(:FencingViolation)-[:BY]->(:Agent)`.
  A single one is enough for Notch's self-heal to pause an agent, because a
  stale writer is by definition an agent that has lost track of whether it may
  act.
- For writing your own queries against this graph, use the
  `hydra-cypher-queries` skill — HydraDB implements a subset of OpenCypher and
  the gaps are not guessable.
