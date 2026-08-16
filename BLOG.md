# I put five coding agents in one graph — and the graph is what makes them safe

I run more than one coding agent. Claude Code for planning, Codex for building,
OpenCode for review, Grok and the Antigravity CLI when I want a second opinion or
a cheaper turn. They all work. None of them know the others exist.

Each one keeps its own memory in its own file — `CLAUDE.md`, `AGENTS.md`,
`.antigravity/` — and each one starts every session from nothing. So I'd explain
a decision to Claude Code, then explain it again to Codex twenty minutes later,
and then find out an hour after that they'd made contradictory choices about the
same file. I couldn't see what any of them were doing, what they cost, or why one
of them had quietly started failing.

That's what Notch is for. The version I'm writing about here is a ground-up
re-architecture of its bottom layer onto **HydraDB** — an object-store-native
distributed graph database — and the interesting part was not "we swapped the
database". It's that two questions the product could never answer became one
traversal each.

---

## One brain, one baton

Two ideas do most of the work.

**One shared brain.** Instead of five private memories, there's one store of
typed units — constraints, failures, decisions, conventions, facts — each
attributed to the agent that learned it. When an agent finishes a turn, Notch
mines its prose into structured decisions and folds them in.

**One baton.** Exactly one agent holds the write lock at a time. Handing it over
is an explicit event, and on every handoff Notch projects the brain into the next
agent's context, so Codex starts its turn already knowing what Claude Code
decided and why.

Before this rewrite, the log was a per-project SQLite file and the baton was a
field in `.loom/state.json`. Both worked. Both also decided what the product
could never ask.

---

## The baton is the part I'd defend in a design review

A lock in a JSON file is a read-modify-write with no interlock. Two agents can
both read "holder: null" and both write themselves in, and nothing anywhere
notices. That is not a theoretical race — it is the normal outcome under any
concurrency at all.

So the first thing I tried on HydraDB was the obvious thing:

```cypher
MATCH (b:Baton {id: $id}) WHERE b.holder = $expected SET b.holder = $me
```

**That is not a compare-and-swap.** It reads and writes without holding
anything. I ran eight concurrent claimants against a real node and got **two to
four winners**, run to run. If I had shipped it, the demo would have worked every
time and the guarantee would have been fiction.

What HydraDB *does* give you is more useful than a CAS, and it took me a while to
see it: every canonical mutation for a cell serialises through one writer and
comes back with the storage sequence it committed at. Those sequences are a total
order, and your client is handed its position in it (in the `bookmark`).

So taking the baton became an **election**:

1. Every claimant appends its own `(:BatonClaim)` for the next epoch and keeps
   the sequence its write committed at.
2. The lowest sequence at that epoch wins.
3. A ballot that arrives later can never draw a lower sequence — so a winner
   cannot be overtaken once anyone has seen it.

Every client computes the same holder from the same ledger without talking to the
others. Eight concurrent claimants now elect exactly one, and the losers can see
*why* they lost, because the ballots are still there. That test runs against a
real node in CI.

The honest caveat, which is in the README in the same words: **HydraDB exposes no
client lock API.** Its writer leases are internal. What it exposes is the commit
order those leases produce, and that is what this is built on.

The other half is **fencing**. An agent is issued a tenure epoch when it wins.
If it tries to write on a tenure it has since lost, the write is refused and the
refusal is recorded as a `(:FencingViolation)`. The Observatory has a button that
does this on purpose — a real stale-epoch write through the same gate every
baton-authorized action goes through. A guarantee nobody can watch fail is a
guarantee nobody has any reason to believe.

---

## "Why did this actually fail" is a traversal now

The brain used to be text: memory units, recalled by shared entities plus BM25.
That finds memories that *say* similar things. It cannot find the memory that
matters and shares no words with your query.

In the graph, memory units carry edges: `ABOUT` an entity (a file, a symbol, an
error code), `CAUSED_BY` another unit, `CONSTRAINED_BY` a constraint,
`SUPERSEDES` the belief it corrected. Which buys two things text search can't do
at all:

- **A third recall channel.** Alongside entity overlap and BM25, a bounded
  traversal from what the turn is *touching*. Two memories that never share a
  word are one hop apart when they're about the same file.
- **Causal chains.** "Why did this fail" is a shortest-path query from a failure
  to the decision that caused it and the constraint that decision violated —
  `algo.SSpaths`, one call.

`ABOUT` edges are deliberately **not** project-scoped, which is what makes
cross-run recall work: a constraint learned about `src/core/baton.ts` in one run
is about the same file in the next one.

---

## Then I deleted the second database

Notch used to ship OpenTelemetry to a separate telemetry stack and read it back
over SQL. It worked. It also cost three things:

- a window where the dashboard and the event log disagreed, because one of them
  hadn't ingested yet;
- a Logs view that had to carry "the query store isn't answering" as a
  first-class state, because that store could be down while the daemon was up;
- a second stack to provision before a demo.

The fold is unchanged — same GenAI semantic conventions, same
`gen_ai.agent.turn` spans with model, tokens, cost and duration, same log lines
carrying the trace id of the turn that produced them. Only the destination moved:
spans and log lines are now `(:Span)` and `(:LogLine)` hanging off the project,
one hop from the events they describe. Metrics are *derived from those spans on
read*, so a chart and the span list behind it cannot disagree.

All three problems disappear at once. And self-heal got better as a side effect:
it used to arrive as an inbound alert webhook, which had to sit **in front of**
the bearer auth wall because the alerting system had no token — the one
unauthenticated way to move the baton in the whole daemon. Now the watcher reads
the evidence the daemon already wrote: three error spans in ten minutes, or a
single fenced write, and the agent is paused and the baton fails over. Every
`/api` route needs a token again.

That last threshold is my favourite rule in the codebase. One fenced write is
enough on its own, because a stale writer is by definition an agent that has lost
track of whether it may act.

---

## Things that cost me real hours

A build log with no failures in it is a marketing page, so — all of these were
measured against a live node, not read off a doc:

**A single property value is capped at 32 KiB.** 31 KiB commits; 32 KiB fails
with an internal error. Event payloads can be anything, so events are chunked
across `(:Event)-[:CHUNK]->(:EventChunk)` and reassembled on read. Byte-based
chunking, not character-based — that distinction is the difference between
working and working until someone pastes emoji.

**Results are paginated and it is silent.** 3000 rows in, 1024 out, no error, no
warning. You follow `next_cursor` — and you must carry the `query_id` with it, or
the cursor is refused. `read_epoch` comes back on a response and is *not* a
snapshot selector to send on the next one; I tried.

**Supply your own `query_id`.** HydraDB dedupes writes by it. The server's auto
counter resets when the node restarts, so a fresh node happily deduped writes
against ids my client had used an hour earlier. That one presented as "some
events just don't appear."

**Reach rows through edges, never by property.** `MATCH (e:Event) WHERE e.proj =
$slot` is a full scan of every project's events, because the graph holds every
project. Measured on 74k events: **2.27s** for the scan, **0.010s** for the same
answer through `(:Project)-[:HAS_EVENT]->`. Everything Notch owns now hangs off a
`HAS_*` edge.

**The scan rule catches you twice.** I knew not to scope by property, and I
still shipped one: the key→id table is a single global label, so hydrating it on
`open()` was a full scan of every project that had ever touched the node. It was
invisible until the dev node had 1671 projects on it, at which point the test
suite went from 87 seconds to 322 with timeouts. The tell was that it got slower
every week and nothing in the diff explained it.

**Node's `fetch` keep-alive pool wedges permanently** if the container is
recreated on the same port. Not slow — wedged, forever, until the process
restarts. The client owns its own `http.Agent` and retires it on a connection
failure.

**The `local` object-store backend cannot resume an existing store**, because it
has no conditional writes. A node restarted onto its old volume never comes
healthy. The symptom looks exactly like data loss, so `loom doctor` says it in
words.

**The honest-empty-state rule**, which predates all of this and still earns its
keep. The Metrics tab once showed "Spend — nothing recorded yet" directly
underneath a `$3.64` total. Both were true — the total sums the whole log, the
sparkline only the last ten turns — but on one screen it reads as the dashboard
contradicting itself. Two true numbers that disagree are worse than one number.

---

## Try it

```bash
./scripts/hydra-up.sh            # one node; it round-trips a real write before claiming success
npm install -g notch
cd your-project && loom init && loom
```

Everything lives in that one node: the log, the baton, the brain, the spans, the
log lines. There is no second service to bring up for observability, and
`.loom/` holds no log at all — delete it and the thread survives.

The tests run against a **real** node. There is no in-memory double, and
deliberately so: the two most valuable findings in this port — that
`MATCH … WHERE … SET` is not a compare-and-swap, and that a list parameter is
only accepted as `UNWIND` input — are exactly the kind a fake would have hidden.

Notch is MIT, **716 passing tests across 59 files**, and has installers for
macOS, Windows, Linux and Android.

- **Code:** https://github.com/nickthelegend/notch
- **Download:** https://notch-observatory.vercel.app
