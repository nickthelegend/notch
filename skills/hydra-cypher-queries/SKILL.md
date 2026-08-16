---
name: hydra-cypher-queries
description: Write Cypher that HydraDB actually accepts. HydraDB implements a subset of OpenCypher and the gaps are not guessable from the Cypher you know — no CONTAINS, no IN, no min/max, no RETURN *, single-node upserts must go through UNWIND, results are paginated, and a single property value is capped at 32 KiB. Use whenever the user asks to query the graph, write Cypher, read spans/logs/events/memory out of HydraDB, or when a query is failing with a parse or internal error.
---

# Writing Cypher for HydraDB

Every limit below was **measured against a running node**, not read off a doc.
When one bites, the error is usually a parse failure or a bare `internal_error`,
so the failure mode is "your query looks fine and does not run".

## The wire

```bash
curl -s "$HYDRA_URL/v1/graphs/$HYDRA_GRAPH/query" \
  -H "authorization: Bearer $HYDRA_TOKEN" -H 'content-type: application/json' \
  -d '{"cell_id":"cell-0","query":"MATCH (n:Project) RETURN n.pid AS pid LIMIT 10","parameters":{},"consistency":"causal","page_size":512}'
```

Defaults: `HYDRA_URL=http://127.0.0.1:8443`, `HYDRA_GRAPH=default`,
`HYDRA_CELL=cell-0`.

Response: `{ columns, rows, seq, bookmark, read_epoch, next_cursor, query_id }`.

**Pagination is not optional.** If `next_cursor` is non-null there are more
rows. Re-POST the *same* query with `"cursor": <next_cursor>` **and**
`"query_id": "<the query_id from the first response>"` — a cursor sent without
its query id is refused with `cursor does not belong to this query request`.
Ignoring the cursor silently truncates: 3000 rows in, 1024 out, no error.

**`read_epoch` is not a snapshot selector.** It comes back on a response; do not
send it on the next one.

## Consistency

| Value | What it does | Use for |
|---|---|---|
| `causal` (default) | reads at least as fresh as your last write, when you pass its `bookmark` | dashboards, list views |
| `strong` | re-verifies against object storage before pinning | anything that decides an action — pausing an agent, an election |

## What is missing

| Not supported | Do this instead |
|---|---|
| `IN` | one `=` per value, OR'd; or `UNWIND $rows AS row MATCH … {x: row.x}` |
| `CONTAINS`, `ENDS WITH` | `STARTS WITH` exists. Otherwise over-fetch and filter in the client |
| `IS NULL` / `IS NOT NULL` | write a sentinel (`""`, `0`) on the property and compare to it |
| `min()` / `max()` | `ORDER BY x ASC LIMIT 1` / `DESC LIMIT 1` |
| `RETURN *` | name every column: `RETURN n.id AS id, n.ts AS ts` |
| `MERGE (n {id: 1}) SET …` on its own | the `UNWIND` batch form below, even for one row |
| a list parameter anywhere but `UNWIND` | pass lists only as `UNWIND` input |

Vertex ids are **non-negative integers**, not strings. Notch derives them as
`kind * 2^44 + slot` so the id space is partitioned by node kind
(`src/hydra/ids.ts`).

## Upserting

```cypher
UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Span, n.ts = row.ts, n.agent = row.agent
```

- The `SET` list is spelled out **literally**; it cannot be driven by the data.
- Every value must read from the row map (`row.ts`), not from a scalar
  parameter — a batch that sets a constant sets it for every row.
- Relationships get their own integer id so a replay is idempotent:
  `MERGE (s)-[r:HAS_SPAN {id: row.rid}]->(d)`.

## Two traps worth the whole page

**`MATCH … WHERE … SET` is not a compare-and-swap.** It reads and writes without
holding anything, so eight concurrent callers can all pass the same `WHERE` and
all write. Measured: 2–4 "winners" out of 8. If you are electing a leader, do
not build it on this. Notch's baton instead lets every claimant write a ballot
and takes the **lowest storage sequence** at an epoch — the sequence HydraDB
already assigns by serialising cell mutations through one writer, returned in
the `bookmark`. That is a real total order, not a hoped-for one.

**A single property value is capped at 32 KiB.** Measured: 31 KiB commits,
32 KiB fails with an internal error. Anything that can grow — a payload, a
document, a transcript — has to be chunked across nodes
(`(:Event)-[:CHUNK]->(:EventChunk)` is Notch's version) and reassembled on read.

## Performance: reach rows through edges, never by property

```cypher
-- 2.27s on 74k events: a full scan of every project's events
MATCH (e:Event) WHERE e.proj = $slot RETURN count(*) AS n
-- 0.010s: the same answer, through the project's own edges
MATCH (p:Project {id: $pv})-[:HAS_EVENT]->(e:Event) RETURN count(*) AS n
```

The graph holds every project, so a property scan gets slower every time
somebody else starts one. This is why Notch writes a `HAS_*` edge for every
kind of node it owns.

## The Notch graph

```
(:Project {id, pid, slot})
  -[:HAS_EVENT]->   (:Event)-[:NEXT]->(:Event)     the log, explicitly ordered
  -[:HAS_MEMORY]->  (:MemoryUnit)
  -[:HAS_CLAIM]->   (:BatonClaim)-[:CLAIMED_BY]->(:Agent)
  -[:HAS_HANDOFF]-> (:Handoff)-[:FROM|TO]->(:Agent)
  -[:HAS_FENCING]-> (:FencingViolation)-[:BY]->(:Agent)
  -[:HAS_SPAN]->    (:Span {trace, span, ts, name, ms, code, msg, agent, ade, model, tin, tout, cost, hfrom, hto})
  -[:HAS_LOG]->     (:LogLine {ts, level, agent, body, trace, kind})
(:MemoryUnit)-[:ABOUT]->(:Entity)                  files, symbols, error codes
(:MemoryUnit)-[:CAUSED_BY|CONSTRAINED_BY]->(:MemoryUnit)
(:MemoryUnit)-[:PROJECTED_AT]->(:Handoff)          what was injected, when
```

`p.pid` is the absolute path of the project's `.loom` directory — the handle to
start from when you only know which project you mean.

Path procedures (`algo.SSpaths`, `algo.MSpaths`) take `sourceValues` as inline
literals, **not** as a `$parameter`. Escape anything that reaches them from
agent prose or a file path.
