# Notch — full context handoff

Written to brief another LLM (or another human) on what Notch is, how it is put
together, and which parts are worth stealing for a different project. It assumes
no prior exposure to the repo.

Repo: https://github.com/nickthelegend/notch · MIT · TypeScript · ~35k lines of
`src` across 75 files, 716 tests across 59.

---

## 1. What it is, in one paragraph

Notch is an orchestrator for a fleet of **coding-agent CLIs** — Claude Code,
Codex, OpenCode, Grok Code, the Antigravity CLI — plus a GUI bridge for Kiro. It
does not call model APIs. It drives the binaries the user already has installed,
headlessly, and stitches them into one conversation with shared memory. Every
action it takes is emitted as an event, and those events become OpenTelemetry-shaped
spans and log lines **in the same HydraDB graph as the events, the baton and the
brain**. The distinguishing feature is that it then **reads its own telemetry
back** to score, diagnose and heal itself.

---

## 2. The three ideas that carry the whole design

Everything else is plumbing around these.

### 2.1 The baton

Exactly one agent holds a write lock at a time. Nothing else may modify the
project. Handing it over is an explicit, logged event. This is what makes a fleet
of independent processes safe to run over one repo, and it is what makes the
system observable at all — the baton's path *is* the trace.

### 2.2 One shared brain

Rather than five private memories, there is one store of typed units:
`constraint`, `failure`, `decision`, `convention`, `fact`, `task`. Each is
attributed to the agent that learned it. On every handoff the brain is
**projected** into the next agent's context — a framed block prepended to its
prompt, so the receiving agent starts already knowing what the previous one
decided.

Critical detail people get wrong when reimplementing: the projection is
**one-shot per handoff**, not on every turn. It is armed at handoff time
(`runtime.ts:1566`), consumed and deleted on the next turn
(`runtime.ts:1496-1500`). Turn 2 after a handoff does *not* get it again.

### 2.3 The event log is the source of truth

Everything — turns, handoffs, routes, memory folds, errors, decisions, health
interventions — is an append-only event: `(:Event)` nodes chained by `[:NEXT]`
under a `(:Project)` in HydraDB, durable on object storage. `.loom/` holds no log
at all. All UI state is *derived* by folding that log. This is what makes time-travel replay
possible: you can reconstruct "who held the baton at 14:32, what every agent's
state was, and which turn was running" by replaying to an index.

**If you take one architectural idea, take this one.** It costs nothing up front
and buys replay, audit, and honest metrics for free.

---

## 3. Repo layout

```
src/
  adapters/        one file per agent CLI + a registry
    bridges/       GUI apps driven over the Chrome DevTools Protocol
  cli/             index.ts — the whole `loom` CLI (commander)
  core/            registry, brain, decisions, routes, ades, git, skills, mcp
  daemon/
    server.ts      3.2k lines — every HTTP route + WebSocket
    runtime.ts     1.8k lines — ProjectRuntime: baton, turns, routes, quarantine
    app-page.ts    9.1k lines — THE ENTIRE WEB UI, see the warning below
  hydra/           client.ts, ids.ts, graph.ts, eventstore.ts, brain-graph.ts,
                   telemetry.ts, decisions-store.ts, views.ts
  observability/   index.ts (the fold), metrics.ts, logs.ts, insights.ts,
                   logs-query.ts, triage.ts, decisions.ts, ask.ts
app/               Expo / React Native phone app
desktop/           Electron shell
test/              716 tests, 59 files — all against a real HydraDB node
```

### ⚠ The one landmine: `src/daemon/app-page.ts`

The entire web UI — HTML, CSS and ~8000 lines of JavaScript — is **one
TypeScript template literal**. Consequences that will bite you within an hour:

- **A backtick anywhere in that file terminates the string**, including inside a
  `//` comment. This broke the build three separate times during development.
  Write `` `val` `` in a comment and the daemon stops serving.
- `\"` inside a double-quoted JS string collapses to `"` and breaks the served
  JS. HTML with double-quoted attributes must use single-quoted JS strings.
- Unicode must be written `\\uXXXX`.

**Validation gate before believing any UI change works:**

```bash
curl -s localhost:7420/app > /tmp/pg.html
node -e "const h=require('fs').readFileSync('/tmp/pg.html','utf8');
  const m=[...h.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map(x=>x[1]).sort((a,b)=>b.length-a.length)[0];
  require('fs').writeFileSync('/tmp/page.js',m)"
node --check /tmp/page.js
```

Would I do it this way again? No. It exists because the daemon serves a
zero-build single-file app. If you are starting fresh, use a real bundler.

---

## 4. The adapter contract

An **adapter** can hold the baton and run a turn headlessly. A **bridge** can only
observe (it types into a GUI's chat box over CDP and reads the panel back).

Each adapter drives a CLI in print/headless mode and normalises its output into
events:

| Agent | Mechanism | Reports |
|---|---|---|
| Claude Code | `claude -p --output-format stream-json --resume` | cost + tokens |
| Codex | `codex exec --json`, `exec resume <thread>` | tokens only |
| OpenCode | `opencode serve` HTTP + SSE | cost + tokens |
| Grok Code | `grok -p --output-format json -r <session>` | tokens only |
| Antigravity | `agy --print --conversation <id>` | neither |

**The honesty rule that shaped the whole product:** an agent that reports no cost
shows `$0`, never an estimate. Never invent a number the tool did not give you.
This sounds minor and it is the reason the metrics are trustworthy.

Adapters register in `src/adapters/index.ts` with a tier:

```ts
registerAgentKind("codex", (cfg, dir) => new CodexAdapter(...));           // adapter
registerAgentKind("kiro",  (cfg, dir) => new KiroBridge(...), "bridge");  // bridge
```

---

## 5. The observability layer — the part worth copying

### 5.1 Write path

`recordAgentEvent()` (`src/observability/`) is a single funnel: one internal event
fans out to all three signals.

- **Traces** — `gen_ai.agent.turn` spans following the OpenTelemetry
  [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
  plus `notch.baton.handoff`. Model, tokens, cost, duration as attributes.
- **Metrics** — derived from the turn spans on read rather than stored
  separately, so a chart and the span list behind it cannot disagree:
  `notch.turns`, `notch.cost.usd`, `gen_ai.client.token.usage`,
  `gen_ai.client.operation.duration`.
- **Logs** — every message, tool call, file edit and error, each carrying the
  **trace id of the turn that produced it**. That correlation is the whole point.

Spans and log lines go into HydraDB as `(:Span)` and `(:LogLine)` hanging off the
project by an edge, batched (64 rows or 400ms) and chained. A failed write is
requeued and logged — never dropped silently.

### 5.2 Read path — this is the differentiator

Four features query the telemetry back out of the graph:

1. **Agent Health (0–100)** — a pure, unit-tested function over an agent's own
   spans: error rate (≤40 pts), latency (≤25), token bloat (≤20), recent error
   (≤15). Being derivable by hand is what makes it trustworthy.
2. **Triage** — pulls the agent's own `gen_ai.*` spans, finds the most recent
   failure *and the upstream handoff that fed it*, and root-causes it. LLM prose
   when a key is present, deterministic heuristic otherwise.
3. **Trace waterfall** — one turn's spans as time-positioned bars, with the log
   lines emitted inside them.
4. **Logs view** — read straight from `(:LogLine)`. **No local fallback**: if the
   node is unreachable it says so rather than showing an empty list that reads as
   a quiet run. A span has a fallback because it summarises an event already in
   memory; a log line's severity and body do not exist anywhere else.

Every read-back endpoint returns a `from: "hydradb" | "local-log" | "unavailable"`
so the UI can never imply live data it does not have.

### 5.3 Act path — self-healing

A watcher evaluates every open project on a timer, reading the evidence the
daemon already wrote. There is no inbound webhook and no second system.

- **3 error spans in 10 minutes, or 1 fenced write** → quarantine the agent
  (refuse it the baton). If it was holding the baton, take it and hand to a
  healthy agent. One fenced write is enough on its own: a stale writer is by
  definition an agent that has lost track of whether it may act.
- **no errors since the pause** → un-quarantine, hand the baton back, retrying up
  to 3 times before leaving it for a human.

Real episode: `held 17s · baton moved to claude-code · baton handed back`.

A quarantine is **enforced**, not merely recorded: `POST /handoff` to a paused
agent answers `409 agent_quarantined`. That was a real bug once — the pause was
written to state and nothing read it back, so a paused agent kept taking work.

**Security note (a whole class of risk deleted):** self-heal used to arrive over
an inbound alert webhook, which had to sit *in front of* the bearer auth wall
because the alerting system had no token. It was the only unauthenticated way to
move the baton. Reading the evidence out of the graph the daemon already owns
closed that door with the feature it existed for — every `/api` route now needs
the bearer token.

---

## 6. HydraDB gotchas (cost real hours, all measured on a live node)

- **`MATCH … WHERE … SET` is not a compare-and-swap.** It reads and writes
  without holding anything: eight concurrent claimants passing the same `WHERE`
  produced **2–4 winners**. The baton is an election over commit order instead.
- **A single property value is capped at 32 KiB** — 31 KiB commits, 32 KiB fails
  with an internal error. Anything that can grow must be chunked
  (`(:Event)-[:CHUNK]->(:EventChunk)`).
- **Results are paginated and the cursor is easy to miss**: 3000 rows in, 1024
  out, no error. Follow `next_cursor`, and carry the `query_id` with it or the
  cursor is refused. `read_epoch` comes back on a response; it is not a snapshot
  selector to send on the next one.
- **Supply your own `query_id`.** HydraDB dedupes writes by it, and the server's
  auto counter resets on restart — so a fresh node collides with ids the client
  used before it.
- **The Cypher subset is narrower than it looks**: no `IN`, no `CONTAINS`, no
  `IS NULL`, no `min`/`max`, no `RETURN *`; a single-node upsert must go through
  `UNWIND $rows AS row MERGE (n {id: row.id}) SET …`; list parameters are only
  accepted as `UNWIND` input. See `skills/hydra-cypher-queries`.
- **Reach rows through edges, never by property.** Measured on 74k events:
  **2.27s** for `MATCH (e:Event) WHERE e.proj = $slot`, **0.010s** for the same
  answer through `(:Project)-[:HAS_EVENT]->`. The graph holds every project.
- **The same rule catches you a second time, on your own id table.** The
  key→vid map is one global `(:IdMap)` label, so hydrating it unscoped is a full
  scan whose cost is set by the busiest node rather than the project opening.
  Measured on a dev node carrying 1671 projects: **2.0s per `open()`**, and the
  suite's wall clock went from 87s to 322s with timeouts once it got there.
  Hydration is scoped by key prefix now (`agent:<projectId> `, …), with entities
  left global because sharing them across runs is the point.
- **Node's `fetch` keep-alive pool wedges permanently** when the container is
  recreated on the same port. The client owns an `http.Agent` and retires it on a
  connection failure.
- **The `local` object-store backend cannot resume an existing store** (no
  conditional writes). A restarted node needs a fresh volume; `loom doctor` says
  so, because the symptom otherwise looks like data loss.

---

## 8. Product rules that made it feel trustworthy

These are cheap and they are most of why the demo lands.

1. **Never show a number you cannot source.** `$0` not an estimate. `not
   measured` not `0%`. A measured confidence and a pattern-matched one are
   labelled differently.
2. **Degrade loudly.** "the graph isn't answering" beats an empty list.
3. **Two true numbers that disagree are worse than one number.** The Metrics tab
   once showed "Spend — nothing recorded yet" under a `$3.64` total (total summed
   the whole log; the sparkline only the last ten turns). Both true, and it read
   as the dashboard contradicting itself.
4. **Don't assign roles you didn't earn.** `loom init` names each agent after its
   own kind rather than guessing planner/executor/reviewer, because guessing from
   detection order looks like a recommendation.

---

## 9. Porting this to CockroachDB

CockroachDB is a distributed SQL database, so the *domain* changes completely —
but the shape transfers well. Do **not** try to port the agent-fleet concept
literally; port the loop.

### What maps directly

| Notch | CockroachDB analogue |
|---|---|
| Agent | Node / range / SQL session |
| Baton (single writer) | Leaseholder for a range |
| Handoff | **Lease transfer** — already an event CRDB emits |
| Event log | CRDB's own `crdb_internal` tables + changefeed |
| Turn span | Statement / transaction span |
| Agent health 0–100 | Node health from p99 latency, retry rate, queue depth |
| Triage | "Why is this query slow?" from its own execution traces |
| Self-heal on alert | Drain a node, transfer leases away, rebalance |

### The pitch that transfers

*"Most tools ship telemetry and stop. This one reads its own telemetry back and
acts on it."* For CockroachDB: a control plane that watches its own cluster
metrics and **moves leases off a degrading node automatically**, then moves them
back when it recovers — with every decision recorded and replayable.

That is genuinely compelling because CRDB already exposes everything you need:

- `crdb_internal.node_statement_statistics` — per-statement latency, retries
- `crdb_internal.ranges` — leaseholder per range
- `SHOW STATEMENTS`, `EXPLAIN ANALYZE (DEBUG)` — real execution traces
- **Changefeeds** — CRDB will stream row changes to Kafka/webhook, which is a
  ready-made event source. You do not need to invent the event log.
- `ALTER RANGE ... RELOCATE LEASE` and node draining — the "act" verbs.

### Concrete project shape

1. **Instrument** — CRDB emits OTel traces natively (`--vmodule`, or its
   Prometheus endpoint at `:8080/_status/vars`). Ship to your backend.
2. **Read back** — query statement statistics and range/leaseholder state.
   Score each node 0–100 from p99, retry rate, and queue depth. Same formula
   shape as Notch's health score.
3. **Triage** — "why did this transaction retry?" answered from that
   transaction's own trace plus the contended range's history. This is the
   direct analogue of Notch's Triage and it is the money shot.
4. **Act** — on a firing alert, relocate leases off the degraded node; on
   resolve, rebalance back. Log every intervention as an episode with a
   duration, exactly like the Self-heal tab.
5. **Replay** — fold the changefeed to reconstruct cluster state at any instant.

### What to keep from the implementation

- **Event log as source of truth**, UI derived by folding it.
- **`from:` provenance on every read** so the UI can't fake liveness.
- **The honesty rules in §8** — verbatim, they cost nothing.
- **A one-file validation gate** before trusting any UI change.

### What to drop

- The single-template-literal UI. Use a bundler.
- The GUI/CDP bridge concept — irrelevant here.
- The adapter registry — CRDB is one system, not five heterogeneous CLIs.

---

## 10. Honest state of the repo

Things a new maintainer should know rather than discover:

- **The Kiro bridge's selectors are unverified.** The CDP mechanism works against
  a real Chromium; Kiro's actual chat DOM was never confirmed because it shows no
  panel until you open one.
- **The LoomPad macropad is designed, not shipped** — CAD exists,
  `hardware/orchestrator-pad/firmware/` does not.
- **`app-dom.test.ts` needed its own test-runner lane.** `npm test` runs it
  separately (`vitest run --exclude app-dom && vitest run app-dom`) because 62
  jsdom windows against a real daemon contend with 56 other parallel files. This
  was three distinct bugs stacked: a leaked in-flight turn, an 8s wait budget
  against a `/api/setup` that takes 4.8–6.0s idle, and genuine contention. Each
  needed measuring, not guessing.
- **The phone app's Observatory tab strip** is 686px wide in a 375px viewport;
  Logs and Replay sit off the right edge and resisted automation.

---

## 11. Prompt to hand another LLM

> Read `HANDOFF.md` in this repo. It describes Notch, an orchestrator for coding
> agents with an observability loop that reads its own telemetry back out of the
> graph it wrote it to, in order to score, diagnose and heal itself.
>
> I want to build the same *loop* for CockroachDB: instrument the cluster, read
> the telemetry back to score nodes and root-cause slow or retrying transactions,
> and act on alerts by relocating leases off a degrading node — with every
> intervention logged as a replayable episode.
>
> Start from §9. Keep the event-log-as-truth architecture and the honesty rules
> in §8. Ignore the agent-adapter machinery; it doesn't transfer. Tell me what
> the smallest end-to-end vertical slice is that proves the loop, and build that
> first.
