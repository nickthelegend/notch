# Notch — 2-minute demo script

The one line: **Notch turns a fleet of coding agents into one observable, self-healing
system, with its log, its baton, its brain and its telemetry all in one HydraDB graph.**

**Before you hit record:** the node running (`scripts/hydra-up.sh`), `notch up`, the `loom`
project open, and a terminal ready for the calls in Beats 4 and 5.

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

**2. Confirm the graph is actually answering _before_ you generate anything.** This must
print `hydradb` — if it prints `unavailable`, the node is down and everything you do next is
written into a hole:

```bash
curl -s -H "Authorization: Bearer $TOKEN" localhost:$PORT/api/projects/$PROJ/insights/logs \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['from'])"
```

(Without the header this returns `{"error":"unauthorized"}` and the one-liner blows up on a
`KeyError` — that's an auth problem, not a store problem.)

If that says `unavailable`: Docker Desktop is usually the culprit — start it, wait for
`docker info` to succeed, re-run `scripts/hydra-up.sh`, then check again. `loom doctor` will
also tell you, and it knows the one non-obvious failure: HydraDB's `local` object-store
backend cannot resume an existing store, so a node that was restarted onto an old volume
never comes healthy. Give it a fresh one.

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

Do this **after** step 2, not before: a line recorded while the node is unreachable is
requeued in memory, and a daemon restart forgets it.

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

> "Everyone's running fleets of coding agents now. Nobody can *see* them, and nobody can
> stop two of them writing at once. This is Notch — one baton, one brain, one graph."

Open the **Observatory → Live fleet**. The brain hub, agents around it, the baton on one of
them. Point at the vitals strip: **spend, turns, tokens — all real.**

### Beat 1 — a real multi-agent route (0:15–0:40)

Switch to **Handoffs**, then run the `ship` route (or show it having just run).

> "planner → builder → reviewer — three *different* real CLIs: Claude Code, Codex, OpenCode.
> Watch the baton pass."

Switch to **Metrics**. Point at the per-agent fleet: **each real model, real tokens, real cost.**

> "This isn't a mock. Every one of these is a `gen_ai.agent.turn` span, sitting one hop from
> the event that produced it."

### Beat 2 — the read-back: Health + Triage (0:40–1:05)

Still on **Metrics** — point at the **Health badges** (green/amber/red).

> "This score is computed from each agent's *own spans* — error rate, latency, token bloat."

Click **⚠ Triage** on an agent that failed.

> "The agent reads its **own** spans back out of the graph and root-causes itself."
> *(Point at the `FROM HYDRADB` badge, the root cause, the upstream handoff, the fix.)*
> "That procedure ships as a skill any agent here can run — `skills/hydra-agent-triage`."

### Beat 3 — cost, logs, replay (1:05–1:25)

Back on **Metrics**, scroll to the bottom: burn is a panel there, not its own tab — the cost
sparkline + 24h projection + per-agent budgets.

**Logs** tab — this is what pre-flight step 3 was for. Read the header out loud (it says how
many lines, and **from HydraDB**), then click **ERROR**: the failure you seeded is there,
carrying the trace of the turn that produced it. Type `baton` in the filter to swap to the
handoff story. The trace chips are colour-hashed, so lines from one turn visibly share a
colour.

> "Traces, metrics and logs — all three signals, in the same store as the events they
> describe. Nothing can be out of sync with anything."

**Replay** tab: scrub a turn, open the **Trace Waterfall** — one turn's span tree, with the
log lines emitted inside it.

### Beat 4 — the guarantee, watched failing (1:25–1:40)

**Provenance** tab. The HydraDB strip is live: node, cell, storage sequence, and the write it
just round-tripped. Below it, the baton ledger — every claim, with the sequence it committed
at and which one won.

Press **Run fence drill**.

> "That was a real write, through the same gate every baton-authorized action goes through,
> with an epoch that is genuinely stale. It was refused, and the refusal is now a
> `(:FencingViolation)` in the graph. A guarantee nobody can watch fail is a guarantee
> nobody has any reason to believe."

### Beat 5 — self-healing, live (1:40–2:00)

This is the closer. One fenced write is enough to trip the watcher — so the drill you just
ran is already the input. Ask the daemon to evaluate:

```bash
curl -s -XPOST -H "Authorization: Bearer $TOKEN" \
  localhost:$PORT/api/projects/$PROJ/heal/evaluate | python3 -m json.tool
```

> "Notch counts its own error spans and its own fencing record, quarantines the agent, and
> **fails the baton over** — automatically. No alert, no webhook, no second system: it reads
> the evidence it already wrote."

Show the **Timeline**: the violet `⚡ self-heal · … → baton forced off …` line, and the
**Self-heal** tab, where the episode is a row — who was paused, when, who took the baton.

Try to hand the baton back by hand; it is refused with `409 agent_quarantined`. Then let it
recover:

```bash
curl -s -XDELETE -H "Authorization: Bearer $TOKEN" \
  localhost:$PORT/api/projects/$PROJ/quarantine/<agent> | python3 -m json.tool
```

> "It recovers — and the baton comes **back**. Failure → intervention → recovery → retry."

Green `✓ self-heal recovery` line appears.

> "That's Notch: a fleet you can watch, that watches *itself* — out of one graph."

---

### If asked "where does HydraDB actually come in?"

- **The log** is `(:Event)` nodes chained by `[:NEXT]`. `.loom/` holds no log at all — delete
  it and the thread survives.
- **The baton** is an election over HydraDB's commit order: every claimant appends a ballot,
  the lowest storage sequence at an epoch wins. Eight concurrent claimants elect exactly one.
- **The brain** is memory units with `ABOUT` / `CAUSED_BY` / `CONSTRAINED_BY` / `SUPERSEDES`
  edges, and recall has a third channel nothing else had: a bounded traversal from what the
  turn is touching.
- **The telemetry** is `(:Span)` and `(:LogLine)` one hop from the event that produced them.
- **The healing** is a query over both: error spans and fencing violations in a window.

### Fallbacks if something's offline

- A window of the log older than telemetry? Triage/Health fall back to the event log — still
  works, badge says so.
- No `ANTHROPIC_API_KEY`/`claude` CLI? Triage still root-causes deterministically (heuristic).
- Codex model rejected? That itself is a great Triage demo — it root-causes the model error.
