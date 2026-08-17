# HydraDB usage — honest audit, and 50 features ranked by how load-bearing it is

## 1. What HydraDB actually offers, as observed from the node

Not from marketing — from the wire, this machine, this session.

| Capability | Evidence |
|---|---|
| Cell-addressed query protocol | `POST /v1/graphs/{graph}/query` with `{query, query_id, cell_id}`. A hand-rolled body without `cell_id` is rejected: *"missing field `cell_id`"*. |
| Cypher subset | `MATCH` / `MERGE` / `UNWIND` / `SET` / `DELETE` / `DETACH DELETE` / `STARTS WITH`. **No `count()`** — it answers *"OpenCypher query is not supported yet"*. **No `CONTAINS`.** List parameters are only accepted as `UNWIND` input, not inlined. |
| Built-in traversal procedures | `algo.MSpaths` (multi-source) and `algo.SSpaths` (single-source) — bounded path-finding executed **inside** the engine. |
| Commit ordering | Every write draws a monotonic storage sequence from the internal writer lease. Visible as `seq=` in `graph/health`. |
| Causal consistency | Bookmarks returned per query and replayed on the next one, so a read never goes backwards in time. |
| Strong reads | `consistency: "strong"` re-verifies against object storage instead of serving a cached view. |
| Idempotency | Requests are deduplicated by `query_id`; the records are durable and outlive the process. |
| Pagination | Results page via `nextCursor`; a client reading only page 1 silently gets a short answer. |
| Object-storage durability | Data survives the process; `.loom/` holds no log at all. |

## 2. Audit — every reference classified

`src/hydra/` is **3,418 lines** across ten modules. **81 call sites** reach it from
`core/`, `daemon/`, `observability/` and `cli/`.

### GENUINELY USED — a judge can trigger it and watch it work

| Where | What it does | How to see it |
|---|---|---|
| [client.ts](../src/hydra/client.ts) | The protocol itself: `query_id` per call, bookmark chain, `nextCursor` paging, retry, strong reads | Every other row depends on it |
| [eventstore.ts](../src/hydra/eventstore.ts) | Event log as `(:Event)` chained by `[:NEXT]` under `(:Project)`; >32 KiB payloads split across `(:EventChunk)` | Delete `.loom/`, thread survives |
| [core/baton.ts](../src/core/baton.ts) | **Baton election over HydraDB's commit order.** Every claimant appends a ballot; lowest `seq` at an epoch wins | Provenance → baton ledger, ballots winner-first |
| [core/baton.ts](../src/core/baton.ts) | **Fencing.** A write at a stale epoch is refused and recorded as `(:FencingViolation)` | Provenance → **Run a fence drill** |
| [brain-graph.ts](../src/hydra/brain-graph.ts) | Memory as `(:MemoryUnit)` with `ABOUT`/`CAUSED_BY`/`CONSTRAINED_BY`/`SUPERSEDES`; connected recall via `algo.MSpaths` | Brain tab; handoff briefs |
| [brain-graph.ts](../src/hydra/brain-graph.ts) | Causal chains — failure → decision → constraint, multi-hop | Observatory → Provenance |
| [brain-graph.ts](../src/hydra/brain-graph.ts) | Cross-run recall: `(:Entity)` is global, `(:MemoryUnit)` is not | Brain tab → "What other projects know" |
| [telemetry.ts](../src/hydra/telemetry.ts) | `(:Span)` and `(:LogLine)` one hop from the event that produced them | Observatory → Logs, Metrics, Replay |
| [council.ts](../src/hydra/council.ts) | `(:Council)-[:ANSWERED]->(:CouncilAnswer)` | Council tab, history survives restart |
| [actions.ts](../src/hydra/actions.ts) | Global `(:Action)` nodes — one graph, every workspace | Toolbar ⚡ |
| [ids.ts](../src/hydra/ids.ts) | Deterministic vertex ids + `(:IdMap)`, so `MERGE` is idempotent on replay | Underpins every write |
| [decisions-store.ts](../src/hydra/decisions-store.ts) | Mined decisions as `(:Decision)` | Observatory → Decisions |

### IMPORTED BUT UNUSED — none

Every module in `src/hydra/` has live call sites.

### FAKED — none

`grep` for mock/stub/fake/fallbackData/dummyData across `src/`: **0 hits**. There is
no in-memory double even in the test suite — the HydraDB suites run against a real
node, deliberately, because the two most valuable findings of the port
(`MATCH … WHERE … SET` is not a compare-and-swap; a list parameter is only accepted
as `UNWIND` input) are exactly what a fake would have hidden.

### The one thing a judge should know that isn't in the pitch

`src/core/eventlog.ts` still contains a **SQLite store**, selected by `LOOM_STORE`,
defaulting to `hydra`. It is not a fallback — nothing degrades into it, and if
HydraDB is configured and unreachable the log throws rather than starting an empty
one beside a full one.

But it means the honest answer to *"is HydraDB swappable here?"* is split:

- **The event log alone** — yes, swappable, and that path is maintained.
- **Everything else** — no. The baton election, fencing, connected recall, causal
  chains, cross-run memory, provenance and the telemetry graph have **no** SQLite
  implementation. `grep LOOM_STORE src/core/baton.ts src/hydra/brain-graph.ts`
  returns nothing. With `LOOM_STORE=sqlite`, `loom doctor` says so out loud: *"the
  graph views have nothing to read, and the baton is a file mutex again."*

### MISSING — HydraDB capabilities not yet touched

| Capability | Status |
|---|---|
| Multi-cell / multi-tenant routing | Only `cell-0` is ever addressed |
| `algo.*` beyond `MSpaths`/`SSpaths` | Whatever else the engine ships is unexplored |
| Bolt protocol (`:7687`) | Published by the container, never dialled — everything goes over HTTP |
| Vector / embedding search, if the build has it | Untested |
| Graph-level snapshot & restore | Not used; snapshots are folded application-side |

### Verification status, stated precisely

The live evidence in this document — 93/93 API checks, real graph counts, a real
fence drill recording epoch 0 → 1, cross-run queries returning memories from other
projects, `seq` advancing — was gathered **earlier in this same session** against a
real node on `:8455`.

**That node no longer exists.** Docker Desktop was reset mid-session; the
`notch-verify` container and its `notch-verify-data` volume are gone. The only
surviving HydraDB on this machine belongs to a different project's stack and hangs
on queries against the `default` graph. So the audit's code classification is
current, and its live evidence is real but hours old rather than re-run just now.
Bringing a node back is `./scripts/hydra-up.sh`.

---

## 3. Fifty features, ranked by how load-bearing HydraDB is

Ranked by the honest test: **could this be built without HydraDB?** The ones at the
top are impossible without it. The ones at the bottom would work over any store and
are marked as such rather than dressed up.

### Tier 1 — impossible without HydraDB (1–12)

| # | Feature | Capability used | Why a judge notices |
|---|---|---|---|
| 1 | **Distributed baton across two machines** — the same election, two daemons, one winner | Commit-order sequence + fencing | The lock is not a file any more; prove it across hosts |
| 2 | **Fence-drill from a second writer** — a real stale writer, not a simulated one | Writer epochs | Watching the guarantee fail on purpose is the demo |
| 3 | **Split-brain drill** — partition a node, show both sides converge on one holder | Commit order | The claim that clients agree without talking |
| 4 | **Cross-project blast radius** — "who else depends on this file?", one traversal | Global `(:Entity)` + `algo.MSpaths` | No second store can answer this |
| 5 | **Memory supersession chain** — walk `SUPERSEDES` back through what a belief replaced | Edge traversal | Memory with a history, not a row |
| 6 | **Causal chain from any error span** — span → event → decision → constraint | Multi-hop `algo.SSpaths` | One traversal replaces a pile of joins |
| 7 | **Time-travel to any commit sequence** — the whole app at `seq = N` | Storage sequence as a clock | The scrubber is reading the engine's own order |
| 8 | **Consistency toggle in the Observatory** — same panel, cached vs `strong`, side by side | `consistency: "strong"` | Makes an invisible database property visible |
| 9 | **Bookmark readout** — show the causal token each view was read at | Bookmark chain | Nobody else will show this |
| 10 | **Idempotency replay drill** — re-send a batch with the same `query_id`, show it is a no-op | Durable idempotency records | A real distributed-systems property, demonstrated |
| 11 | **Handoff brief provenance** — exactly which memories were injected, per handoff | `PROJECTED_AT` edges | "What did this agent know?" answered after the fact |
| 12 | **Fleet knowledge heatmap** — which agent knows which region of the codebase | `ASSERTED` × `ABOUT` | A join no relational schema has |

### Tier 2 — HydraDB is the natural home (13–28)

| # | Feature | Capability used |
|---|---|---|
| 13 | Entity page — everything ever recorded about one file/symbol | `(:Entity)` fan-in |
| 14 | Stale-memory sweep — beliefs whose entity has not been touched in N commits | Traversal + `seq` |
| 15 | Orphan sweep — nodes reachable from no project | Global label scan |
| 16 | Project slot map — every project on the node, one screen | `(:Project)` |
| 17 | Event-chunk inspector — see a >32 KiB payload reassembled | `(:EventChunk)` |
| 18 | Live query cost — rows scanned and ms, per Observatory panel | Query stats |
| 19 | Baton timeline — every epoch as a swimlane with its ballots | `(:BatonClaim)` |
| 20 | Agent memory diff — what A knows that B does not | Set difference over `ASSERTED` |
| 21 | Council re-run against an older graph state | Sequence-addressed reads |
| 22 | Decision → outcome edges — did the decision hold? | New edge type |
| 23 | Cross-run action usage — which saved actions run in which projects | Global `(:Action)` |
| 24 | Turn cost attribution by agent, derived from spans | `(:Span)` aggregation |
| 25 | Memory confidence decay driven by graph distance | Traversal depth |
| 26 | Trace waterfall straight from `(:Span)` parent edges | Span tree |
| 27 | "Why is this agent paused?" — quarantine → the exact spans that tripped it | Edge from quarantine to evidence |
| 28 | Graph-native full-text over `(:LogLine)` | `STARTS WITH` + entity bridge |

### Tier 3 — genuinely better on a graph, but not impossible elsewhere (29–40)

| # | Feature |
|---|---|
| 29 | Handoff route map, weighted by traversal count |
| 30 | Per-file authored history with agent attribution |
| 31 | Memory injection trail animated on the handoff edge |
| 32 | Council answer clustering by shared entities |
| 33 | Agent similarity — who reasons about the same regions |
| 34 | Constraint violation detector — a diff touching a constrained file |
| 35 | Retrieval explainer — which channel found each memory (lexical / entity / connected) |
| 36 | Cross-project duplicate-lesson detector |
| 37 | Budget attribution by traversal from spend to turn to agent |
| 38 | Replay ghosting — previous state shadowed under current |
| 39 | Cost ticker driven by span aggregation |
| 40 | Agreement ring for a council, sized by camp |

### Tier 4 — useful, but the store is swappable (41–50)

Listed honestly: **HydraDB is not load-bearing for these.** They would work over any
database, and a judge on this track should not be told otherwise.

| # | Feature |
|---|---|
| 41 | Action import/export as JSON |
| 42 | Reduced-motion honouring across every animation |
| 43 | Offline banner when the daemon goes away |
| 44 | Explorer right-click on a directory |
| 45 | Keyboard shortcut for the actions popover |
| 46 | Action folders / tagging |
| 47 | Council transcript export to markdown |
| 48 | Per-project theme accent |
| 49 | Command-palette fuzzy ranking improvements |
| 50 | Terminal split panes |

### If you build three

**#1 (distributed baton across two machines)**, **#8 (consistency toggle)** and
**#10 (idempotency replay drill)**. Each is impossible to fake, each makes a
database property visible on screen, and together they answer the only question
that matters on this track: *is the graph doing real work, or is it a place to put
rows?*
