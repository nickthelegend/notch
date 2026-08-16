/**
 * The event log on HydraDB — durability, recovery, and ordering.
 *
 * The claim these tests exist to check is "the `.loom/` directory can be
 * deleted and the thread survives", because that is what "the graph is the
 * source of truth" has to mean in practice. Reading the log back through a
 * second `EventLog` instance is the closest a single process gets to a
 * restart, and the filesystem assertion covers the rest.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/eventlog.js";
import { hydra } from "../src/hydra/client.js";
import { projectGraph } from "../src/hydra/graph.js";
import { eventVid } from "../src/hydra/ids.js";
import { replayAt } from "../src/hydra/views.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  up = await hydraUp();
  if (!up) console.warn(`skipping hydra eventlog tests — ${HYDRA_SKIP_MESSAGE}`);
});

describe("event log on HydraDB", () => {
  it("appends, flushes durably, and recovers everything on reopen", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("log");
    const log = await EventLog.open(loomDir);
    expect(log.list()).toHaveLength(0);

    log.append({ kind: "message", agentId: "claude-code", payload: { text: "plan it" } });
    log.append({ kind: "handoff", payload: { from: "claude-code", to: "codex" } });
    log.append({ kind: "message", agentId: "codex", payload: { text: "done" } });
    await log.flush();
    expect(log.pending).toBe(0);
    log.close();

    const again = await EventLog.open(loomDir);
    expect(again.list()).toHaveLength(3);
    expect(again.lastId()).toBe(3);
    expect(again.list({ kinds: ["message"] }).map((e) => e.payload.text)).toEqual([
      "plan it",
      "done",
    ]);
  });

  it("keeps no log file on disk — the thread lives in the graph", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("nofile");
    const log = await EventLog.open(loomDir);
    log.append({ kind: "message", payload: { text: "hello" } });
    await log.flush();

    const files = fs.readdirSync(loomDir);
    expect(files).not.toContain("log.db");
    expect(files).not.toContain("log.jsonl");
  });

  it("filters by kind and by chat exactly as the other stores do", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("filter");
    const log = await EventLog.open(loomDir);
    log.append({ kind: "message", payload: { text: "main-1" } });
    log.append({ kind: "message", chat: "side", payload: { text: "side-1" } });
    log.append({ kind: "error", payload: { message: "boom" } });
    await log.flush();

    expect(log.list({ kinds: ["error"] })).toHaveLength(1);
    // An event written with no chat belongs to the main conversation.
    expect(log.list({ chat: "main" }).map((e) => e.payload.text ?? e.payload.message)).toEqual([
      "main-1",
      "boom",
    ]);
    expect(log.list({ chat: "side" })).toHaveLength(1);
    expect(log.list({ since: 1 }).map((e) => e.id)).toEqual([2, 3]);
    expect(log.list({ limit: 2 }).map((e) => e.id)).toEqual([2, 3]);
  });

  it("chains events with NEXT so replay never depends on a clock", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("chain");
    const log = await EventLog.open(loomDir);
    for (let i = 0; i < 5; i++) log.append({ kind: "message", payload: { text: `m${i}` } });
    await log.flush();

    const graph = projectGraph(path.resolve(loomDir));
    await graph.open();
    const res = await hydra().query(
      "MATCH (a:Event {id: $first})-[:NEXT*1..6]->(b) RETURN b.seq AS seq ORDER BY seq",
      { first: eventVid(graph.slot, 1) },
      { consistency: "strong" },
    );
    expect(res.rows.map((r) => Number(r.seq))).toEqual([2, 3, 4, 5]);
  });

  it("replays a point in time at both consistencies, and they agree", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("replay");
    const log = await EventLog.open(loomDir);
    log.append({ kind: "handoff", payload: { from: null, to: "alpha", epoch: 1 } });
    log.append({ kind: "message", agentId: "alpha", payload: { text: "first" } });
    log.append({ kind: "handoff", payload: { from: "alpha", to: "beta", epoch: 2 } });
    log.append({ kind: "message", agentId: "beta", payload: { text: "second" } });
    await log.flush();

    const graph = projectGraph(path.resolve(loomDir));
    // Rewound to event 2, alpha still holds it — the later handoff has not
    // happened yet at that point in the fold.
    const early = await replayAt(graph, 2, "causal");
    expect(early.holder).toBe("alpha");
    expect(early.epoch).toBe(1);
    expect(early.thread.map((t) => t.text)).toEqual(["first"]);

    const late = await replayAt(graph, 4, "causal");
    expect(late.holder).toBe("beta");
    expect(late.epoch).toBe(2);

    // `strong` re-verifies against object storage before pinning; it must not
    // disagree with the causal read, only cost more.
    const verified = await replayAt(graph, 4, "strong");
    expect(verified.holder).toBe(late.holder);
    expect(verified.events).toBe(late.events);
    expect(verified.readEpoch).toBeGreaterThan(0);
  });

  /**
   * Regression: HydraDB pages results, and a client that reads only the first
   * page silently returns a shorter answer with no error anywhere.
   *
   * This cost the port a real bug — a project with 3,000 events recovered
   * 1,024 of them on restart and reported success — and it is exactly the class
   * of failure that stays invisible until someone notices their history is
   * short. The row count here is deliberately well past a page.
   */
  it("recovers a log far larger than one result page", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("pages");
    const log = await EventLog.open(loomDir);
    const n = 5_000;
    for (let i = 1; i <= n; i++) log.append({ kind: "message", payload: { text: `m${i}` } });
    await log.flush();
    log.close();

    const again = await EventLog.open(loomDir);
    const events = again.list();
    expect(events).toHaveLength(n);
    expect(again.lastId()).toBe(n);
    // Order survives paging, and no row is duplicated across a page boundary.
    expect(events[0]!.payload.text).toBe("m1");
    expect(events[n - 1]!.payload.text).toBe(`m${n}`);
    expect(new Set(events.map((e) => e.id)).size).toBe(n);
    // 5,000 appends and a paged read-back is the slowest single assertion in
    // this suite, and it shares one node with 58 other files running in
    // parallel. Alone it takes ~15s; under that contention on a development
    // node carrying a few years of test projects it has been measured past
    // 40s. The default timeout is about vitest, not about the guarantee.
  }, 120_000);

  /**
   * HydraDB refuses a property at 32 KiB. A turn diff is routinely bigger, so
   * the store splits it across `(:EventChunk)` nodes. This asserts the split is
   * invisible: what goes in comes back byte-for-byte, and the event after it is
   * unaffected.
   */
  it("round-trips a payload far larger than HydraDB's 32 KiB property limit", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("big");
    const log = await EventLog.open(loomDir);
    // Non-ASCII on purpose: the chunker splits on bytes, and a character-based
    // split would pass on plain 'x' and corrupt this.
    const big = "diff ✂ line — ünïcode\n".repeat(9_000);
    log.append({ kind: "turn_diff", payload: { blob: big, files: ["src/a.ts"] } });
    log.append({ kind: "message", payload: { text: "after the big one" } });
    await log.flush();

    const again = await EventLog.open(loomDir);
    const events = again.list();
    expect(events).toHaveLength(2);
    expect(events[0]!.payload.blob).toBe(big);
    expect(events[0]!.payload.files).toEqual(["src/a.ts"]);
    expect(events[1]!.payload.text).toBe("after the big one");
  });
});
