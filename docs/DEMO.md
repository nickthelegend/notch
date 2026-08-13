# Notch — 2-minute demo script

The one line: **Notch turns a fleet of coding agents into one observable, self-healing
system, using SigNoz both as the sink *and* the source of truth.**

**Before you hit record:** `notch up`, SigNoz running (`localhost:8080`), the `loom` project
open with the `ship` route (`planner=claude-code · builder=codex(gpt-5.5) · reviewer=opencode`).
Have a terminal ready for the two `curl`s in Beat 4.

---

### Beat 0 — the hook (0:00–0:15)

> "Everyone's running fleets of coding agents now. Nobody can *see* them. This is Notch —
> one baton, one brain, and every agent's every turn traced to SigNoz."

Open the **Observatory → Canvas**. The brain hub, agents around it, the baton on one of them.
Point at the vitals strip: **spend, turns, tokens — all real.**

### Beat 1 — a real multi-agent route (0:15–0:45)

Switch to **Graph**, then run the `ship` route (or show it having just run).

> "planner → builder → reviewer — three *different* real CLIs: Claude Code, Codex, OpenCode.
> Watch the baton pass."

Switch to **Metrics**. Point at the per-agent fleet: **each real model, real tokens, real cost.**

> "This isn't a mock. Every one of these is a `gen_ai.agent.turn` span already in SigNoz."

### Beat 2 — the read-back: Health + Triage (0:45–1:15)

Still on **Metrics** — point at the **Health badges** (green/amber/red).

> "This score is computed from each agent's *own spans* — error rate, latency, token bloat."

Click **⚠ Triage** on an agent that failed.

> "This is the money shot. The agent reads its **own** traces back out of SigNoz and
> root-causes itself." *(Point at the `FROM SIGNOZ` badge, the root cause, the upstream handoff,
> the fix.)* "That logic is now a **PR to SigNoz's own agent-skills repo — #76.**"

### Beat 3 — cost + replay (1:15–1:30)

**Burn** tab: the cost sparkline + 24h projection + per-agent budgets.
**Replay** tab: scrub a turn, open the **Trace Waterfall**, click **View full trace in SigNoz ↗**
so SigNoz opens in a new tab — proving the loop is real, not a screenshot.

### Beat 4 — self-healing, live (1:30–2:00)

This is the closer. In the terminal, fire a SigNoz-shaped alert for the baton holder:

```bash
curl -s -XPOST localhost:7421/api/webhooks/signoz -H 'content-type: application/json' \
  -d '{"alerts":[{"status":"firing","labels":{"alertname":"AgentErrorRateHigh","notch.project":"loom","gen_ai.agent.id":"opencode"}}]}'
```

> "A SigNoz alert fires. Notch quarantines the agent and **fails the baton over** — automatically."

Show the **Timeline**: the violet `⚡ SigNoz alert → baton forced off opencode` line. Then resolve it:

```bash
curl -s -XPOST localhost:7421/api/webhooks/signoz -H 'content-type: application/json' \
  -d '{"alerts":[{"status":"resolved","labels":{"alertname":"AgentErrorRateHigh","notch.project":"loom","gen_ai.agent.id":"opencode"}}]}'
```

> "It recovers — and the baton comes **back**. Metric breach → intervention → recovery → retry."

Green `✓ SigNoz recovery · baton retried on opencode` line appears.

> "That's Notch: a fleet you can watch, that watches *itself* — with SigNoz on both ends."

---

### If asked "where does SigNoz actually come in?"

- **Write:** every turn/handoff/route/error → OTLP `gen_ai.*` spans → SigNoz (ClickHouse).
- **Read:** Triage, Health, Burn, Replay, Waterfall all **query those spans back**.
- **Act:** a SigNoz **alert** drives the self-heal webhook. Sink, source, and trigger.

### Fallbacks if something's offline

- SigNoz down? Triage/Health fall back to the local event log — still works, badge says so.
- No `ANTHROPIC_API_KEY`/`claude` CLI? Triage still root-causes deterministically (heuristic).
- Codex model rejected? That itself is a great Triage demo — it root-causes the model error.
