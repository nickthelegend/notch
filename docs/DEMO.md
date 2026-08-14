# Notch — 2-minute demo script

The one line: **Notch turns a fleet of coding agents into one observable, self-healing
system, using SigNoz both as the sink *and* the source of truth.**

**Before you hit record:** `notch up`, SigNoz running (`scripts/signoz-up.sh` puts the UI on
`localhost:8085`), the `loom` project open, and a terminal ready for the two `curl`s in Beat 4.

### Pre-flight (do these in order — the order matters)

**1. Put the daemon's real port and a client token in your shell.** The default port is
7420, but anyone who started the daemon with `--port` is on something else, and a curl to
the wrong port fails silently mid-demo. Don't trust the number written here — ask the
daemon. Everything below uses these two variables:

```bash
CFG=~/.loom/daemon.json
PORT=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('$CFG')))['port'])")
TOKEN=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('$CFG')))['clients'][0]['token'])")
PROJ=<your-project-id>          # loom projects, or read it off the URL hash
echo "daemon on $PORT"
```

**2. Confirm SigNoz is actually answering _before_ you generate anything.** This must print
`signoz` — if it prints `unavailable`, ClickHouse is down and everything you do next is
written into a hole:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/projects/$PROJ/insights/logs \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['from'])"
```

(Without the header this returns `{"error":"unauthorized"}` and the one-liner blows up on a
`KeyError` — that's an auth problem, not a SigNoz problem.)

If that says `unavailable`: Docker Desktop is usually the culprit — start it, wait for
`docker info` to succeed, re-run `scripts/signoz-up.sh`, then check again.

**3. Seed a real error, so the Logs tab has something to show.** The **ERROR** severity chip
filters to nothing on a healthy fleet, and an empty filter reads on camera as a broken
feature rather than an honest one. Run a one-hop route through an agent that can't run on
this machine — one that isn't signed in is ideal, because the failure is real and the
message is legible:

```bash
loom route antigravity "say ready"    # any agent that will genuinely fail here
```

Fifteen seconds later the Logs tab has ERROR lines, each carrying the trace of the turn that
produced it:

```
ERROR  agy exited 1: Authentication required. Please visit the URL to log in…
ERROR  route 2a8bb79f failed: route failed
ERROR  agy exited 1
```

Do this **after** step 2, not before. Logs are exported as they happen with no retry buffer,
so an error generated while ClickHouse is down is simply gone — you get a green ERROR filter
and no idea why.

The `ship` route is **not** seeded for you — `loom init` gives every detected agent its own
kind as its role, so there is no planner/executor/reviewer for a default route to be built
from. Put it in the project's `.loom/config.json` before you record:

```json
{ "routes": { "ship": ["claude-code", "codex", "opencode"] } }
```

Then `loom routes` should list it. (Ad-hoc alternative, no config edit:
`loom route claude-code,codex,opencode "<task>"`.) Whatever model each agent is on, check it
in the agent picker before recording rather than trusting a number written here — the picker
asks the CLI, and the answers move.

---

### Beat 0 — the hook (0:00–0:15)

> "Everyone's running fleets of coding agents now. Nobody can *see* them. This is Notch —
> one baton, one brain, and every agent's every turn traced to SigNoz."

Open the **Observatory → Live fleet**. The brain hub, agents around it, the baton on one of them.
Point at the vitals strip: **spend, turns, tokens — all real.**

### Beat 1 — a real multi-agent route (0:15–0:45)

Switch to **Handoffs**, then run the `ship` route (or show it having just run).

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

Back on **Metrics**, scroll to the bottom: burn is a panel there, not its own tab — the cost
sparkline + 24h projection + per-agent budgets.

**Logs** tab — this is what pre-flight step 3 was for. Read the header out loud (it says how
many lines, and **from SigNoz**), then click **ERROR**: the failure you seeded is there, carrying
the trace of the turn that produced it. Type `baton` in the filter to swap to the handoff
story. The trace chips are colour-hashed, so lines from one turn visibly share a colour.

> "Traces, metrics and logs — all three signals, and every log line knows which span it
> came from."

**Replay** tab: scrub a turn, open the **Trace Waterfall**, click **View full trace in SigNoz ↗**
so SigNoz opens in a new tab — proving the loop is real, not a screenshot.

### Beat 4 — self-healing, live (1:30–2:00)

This is the closer. In the terminal, fire a SigNoz-shaped alert at the baton holder.

**Target whoever actually holds it.** Quarantining an idle agent gets you the limp
`"quarantined (agent wasn't holding the baton)"`; quarantining the *running* one gets you
`"quarantined; baton handed to claude-code"` with `displaced: true` — the baton visibly
coming off a working agent, which is the whole point of the beat. So read the holder first:

```bash
HOLDER=$(curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/projects/$PROJ \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['project']['holder'])")

curl -s -XPOST localhost:$PORT/api/webhooks/signoz -H 'content-type: application/json' \
  -d "{\"alerts\":[{\"status\":\"firing\",\"labels\":{\"alertname\":\"AgentErrorRateHigh\",\"notch.project\":\"loom\",\"gen_ai.agent.id\":\"$HOLDER\"}}]}"
```

> "A SigNoz alert fires. Notch quarantines the agent and **fails the baton over** — automatically."

Show the **Timeline**: the violet `⚡ SigNoz alert → baton forced off $HOLDER` line. Then resolve it:

```bash
curl -s -XPOST localhost:$PORT/api/webhooks/signoz -H 'content-type: application/json' \
  -d "{\"alerts\":[{\"status\":\"resolved\",\"labels\":{\"alertname\":\"AgentErrorRateHigh\",\"notch.project\":\"loom\",\"gen_ai.agent.id\":\"$HOLDER\"}}]}"
```

> "It recovers — and the baton comes **back**. Metric breach → intervention → recovery → retry."

Green `✓ SigNoz recovery · baton retried on $HOLDER` line appears. The response carries the
proof: `"recovered — baton handed back"`, with `retried: true` and how long it was paused.

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
