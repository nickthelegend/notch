# Notch — full context handoff

Written to brief another LLM (or another human) on what Notch is, how it is put
together, and which parts are worth stealing for a different project. It assumes
no prior exposure to the repo.

Repo: https://github.com/nickthelegend/notch · MIT · TypeScript · ~31k lines of
`src`, 70 files, 733 tests.

---

## 1. What it is, in one paragraph

Notch is an orchestrator for a fleet of **coding-agent CLIs** — Claude Code,
Codex, OpenCode, Grok Code, the Antigravity CLI — plus a GUI bridge for Kiro. It
does not call model APIs. It drives the binaries the user already has installed,
headlessly, and stitches them into one conversation with shared memory. Every
action it takes is emitted as an event, and those events become OpenTelemetry
spans, metrics and logs shipped to SigNoz. The distinguishing feature is that it
then **reads its own telemetry back** to score, diagnose and heal itself.

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

Everything — turns, handoffs, routes, memory folds, errors, decisions, alerts —
is an append-only event in a SQLite log (`node:sqlite`, JSONL fallback). All UI
state is *derived* by folding that log. This is what makes time-travel replay
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
  observability/   signoz.ts, metrics.ts, logs.ts, insights.ts, triage.ts,
                   decisions.ts, ask.ts
app/               Expo / React Native phone app
desktop/           Electron shell
test/              733 tests, 57 files
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
- **Metrics** — six instruments: `gen_ai.client.token.usage` (split by
  `gen_ai.token.type`), `gen_ai.client.operation.duration` (histogram, seconds),
  `notch.handoffs` (labelled from→to), `notch.agents.active` (gauge). Delta
  temporality.
- **Logs** — every message, tool call, file edit and error, each carrying the
  **trace id of the turn that produced it**. That correlation is the whole point.

All via OTLP/HTTP to `localhost:4318`. No vendor SDK — hand-rolled JSON payloads.

### 5.2 Read path — this is the differentiator

Four features query the telemetry back out of ClickHouse:

1. **Agent Health (0–100)** — a pure, unit-tested function over an agent's own
   spans: error rate (≤40 pts), latency (≤25), token bloat (≤20), recent error
   (≤15). Being derivable by hand is what makes it trustworthy.
2. **Triage** — pulls the agent's own `gen_ai.*` spans, finds the most recent
   failure *and the upstream handoff that fed it*, and root-causes it. LLM prose
   when a key is present, deterministic heuristic otherwise.
3. **Trace waterfall** — spans as time-positioned bars + deep link into SigNoz.
4. **Logs view** — read straight from ClickHouse. **No local fallback**: if
   ClickHouse is down it says so rather than showing an empty list that reads as
   a quiet run.

Every read-back endpoint returns a `from: "signoz" | "unavailable"` (or
`"log"` where a local fallback exists) so the UI can never imply live data it
does not have.

### 5.3 Act path — self-healing

`POST /api/webhooks/signoz` receives Alertmanager payloads.

- **firing** → quarantine the named agent (refuse it the baton). If it was
  holding the baton mid-turn, take it and hand to a healthy agent.
- **resolved** → un-quarantine, hand the baton back.

Real episode: `held 17s · baton moved to claude-code · baton handed back`.

The framing that sells it: *SigNoz knows the alert fired; only the orchestrator
knows the fleet reacted.* That half cannot live in the observability tool.

**Security note (fixed late, learn from it):** this route sits *in front of* the
bearer auth wall, because Alertmanager has no token. Its own
`NOTCH_WEBHOOK_SECRET` was optional, so a daemon bound past localhost served an
unauthenticated endpoint that could move the baton. It now refuses when no secret
is set and the bind address is not loopback.

---

## 6. ClickHouse gotchas (cost real hours)

- `signoz_logs.distributed_logs_v2` stores timestamps in **nanoseconds**, and
  `trace_id`/`span_id` are **already lowercase hex** — unlike the trace tables.
- Metrics: join `distributed_samples_v4` to `distributed_time_series_v4` on
  `fingerprint`, **group by fingerprint** (hour-floored rows multiply samples),
  and put the time filter on the samples side only.
- Some builds have **no `histogramQuantile`** — p95 may be impossible.

## 7. SigNoz API gotchas (v0.134)

- Login is `POST /api/v2/sessions/email_password` and **requires `orgID`**, from
  `/api/v2/sessions/context?email=` — the only open-access org lookup.
  `/api/v1/orgs` needs a session and returns SPA HTML with a **200**.
- Alert rules need `version: "v5"` and `condition.compositeQuery.queries` as an
  **array** — not `builderQueries`.
- A rule with no channel is refused.
- Dashboards: a `filters` block normalises to `filter: null`, which v5 rejects —
  **panels spin forever with no error**. Use `filter: {expression: ""}`.
- An *ungrouped* gauge query returned 0 points; grouped returned all.

---

## 8. Product rules that made it feel trustworthy

These are cheap and they are most of why the demo lands.

1. **Never show a number you cannot source.** `$0` not an estimate. `not
   measured` not `0%`. A measured confidence and a pattern-matched one are
   labelled differently.
2. **Degrade loudly.** "ClickHouse isn't answering" beats an empty list.
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
> agents with an observability loop that reads its own telemetry back out of
> ClickHouse to score, diagnose and heal itself.
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
