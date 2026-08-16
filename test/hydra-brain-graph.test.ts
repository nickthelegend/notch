/**
 * Graph memory: connected recall, causal chains, and cross-run continuity.
 *
 * The central assertion is negative and deliberately so — the memory that gets
 * recalled must be one that **no lexical channel could have found**. If a test
 * only proved that searching for "runtime.ts" finds a memory containing
 * "runtime.ts", it would prove the graph adds nothing.
 */

import crypto from "node:crypto";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { Brain } from "../src/core/brain.js";
import { retrieveFrom } from "../src/core/brain-index.js";
import { EventLog } from "../src/core/eventlog.js";
import { BrainGraph } from "../src/hydra/brain-graph.js";
import { projectGraph } from "../src/hydra/graph.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  up = await hydraUp();
  if (!up) console.warn(`skipping hydra brain tests — ${HYDRA_SKIP_MESSAGE}`);
});

async function setup(prefix: string) {
  const { loomDir } = isolatedProject(prefix);
  const log = await EventLog.open(loomDir);
  const brain = new Brain(log);
  const graph = projectGraph(path.resolve(loomDir));
  await graph.open();
  return { log, brain, bg: new BrainGraph(graph), graph, loomDir };
}

const prov = (agentId: string) => ({ agentId, eventId: 1, ts: Date.now() });

/**
 * A token no previous run can have used.
 *
 * Every test in this file shares one graph, and `Entity` nodes are global by
 * design — that is exactly what cross-run recall depends on. So a fixed entity
 * name would match memories left behind by *yesterday's* run of this same test
 * and quietly turn a real assertion into a tautology. Uniqueness per run is
 * what keeps these tests honest.
 */
function uniqueEntity(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

describe("connected recall", () => {
  it("finds a memory that shares no words with the query", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("connected");
    // Unique, because `Entity` nodes are global: a real file path here would be
    // shared with every other suite running against this graph, and one of
    // their memories could route a shorter path to ours and change the hop
    // count this test asserts.
    const file = `src/daemon/${uniqueEntity("runtime").toLowerCase()}.ts`;

    const decision = brain.add({
      kind: "decision",
      text: `Spawn adapters as a detached child in ${file} so interrupt can kill the tree.`,
      provenance: prov("claude-code"),
    });
    // Deliberately shares no vocabulary with the query below. That is the
    // whole point of the test: if the words overlapped, BM25 would find it and
    // the graph would be proving nothing.
    const failure = brain.add({
      kind: "failure",
      text: "A signalled subprocess never reports completion, so the baton stays parked forever.",
      provenance: prov("codex"),
    });
    await log.flush();
    await bg.sync(brain.all());
    await bg.link(failure.memory.id, "CAUSED_BY", decision.memory.id, "test fixture");

    const query = `${file} is misbehaving again`;

    // Precondition: no lexical channel can reach the failure from this query.
    expect(failure.memory.text).not.toContain("runtime");
    const lexical = retrieveFrom(brain.all(), {
      query,
      files: [file],
      limit: 10,
    });
    expect(
      lexical.map((h) => h.memory.id),
      "the failure must be unreachable lexically, or this test proves nothing",
    ).not.toContain(failure.memory.id);

    // The graph reaches it in two hops: failure → decision → the file.
    const { hits } = await bg.connected([file], { maxHops: 3 });
    const found = hits.find((h) => h.memoryId === failure.memory.id);
    expect(found, "the causally-connected failure should be recalled").toBeTruthy();
    expect(found!.hops).toBe(2);
    expect(found!.via).toBe(file);
  });

  it("reports the nearest path when a memory is reachable more than one way", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("nearest");
    const file = `src/core/${uniqueEntity("baton").toLowerCase()}.ts`;
    const direct = brain.add({
      kind: "constraint",
      text: `${file} must never be edited without holding the baton.`,
      provenance: prov("claude-code"),
    });
    await log.flush();
    await bg.sync(brain.all());

    const { hits } = await bg.connected([file], { maxHops: 4 });
    const hit = hits.find((h) => h.memoryId === direct.memory.id);
    expect(hit?.hops).toBe(1);
  });

  it("returns nothing rather than everything when the query names no entities", async () => {
    if (!up) return;
    const { bg } = await setup("noentity");
    const { hits, cypher } = await bg.connected([], { maxHops: 3 });
    expect(hits).toEqual([]);
    expect(cypher).toBe("");
  });
});

describe("causal chains", () => {
  it("walks failure → decision → constraint in one traversal", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("causal");
    const constraint = brain.add({
      kind: "constraint",
      text: "Every turn must terminate with run_complete or the baton is stranded.",
      provenance: prov("claude-code"),
    });
    const decision = brain.add({
      kind: "decision",
      text: "Detach the adapter child so an interrupt can signal the whole process tree.",
      provenance: prov("claude-code"),
    });
    const failure = brain.add({
      kind: "failure",
      text: "A signalled child never reports completion, so the turn hangs forever.",
      provenance: prov("codex"),
    });
    await log.flush();
    await bg.sync(brain.all());
    await bg.link(failure.memory.id, "CAUSED_BY", decision.memory.id, "test fixture");
    await bg.link(decision.memory.id, "CONSTRAINED_BY", constraint.memory.id, "test fixture");

    const chain = await bg.causalChain(failure.memory.id);
    const ids = chain.nodes.map((n) => n.memoryId);
    expect(ids).toContain(decision.memory.id);
    expect(ids).toContain(constraint.memory.id);
    expect(chain.links.map((l) => l.rel).sort()).toEqual(["CAUSED_BY", "CONSTRAINED_BY"]);
    // The query is returned so the UI can show its work rather than be believed.
    expect(chain.cypher).toContain("algo.SSpaths");
  });

  it("infers a link from shared entities and records what justified it", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("infer");
    const file = `src/core/${uniqueEntity("baton").toLowerCase()}.ts`;
    brain.add({
      kind: "decision",
      text: `Route every write through ${file} so the epoch is always checked.`,
      provenance: prov("claude-code"),
    });
    const failure = brain.add({
      kind: "failure",
      text: `A stale writer edited ${file} and nothing noticed until the diff.`,
      provenance: prov("codex"),
    });
    await log.flush();
    await bg.sync(brain.all());

    const links = await bg.inferLinks(failure.memory, brain.all());
    expect(links).toHaveLength(1);
    expect(links[0]!.rel).toBe("CAUSED_BY");
    expect(links[0]!.basis).toContain(file);

    const chain = await bg.causalChain(failure.memory.id);
    expect(chain.links[0]!.basis).toContain(file);
  });

  it("infers nothing for a memory with no plausible cause", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("noinfer");
    const lonely = brain.add({
      kind: "failure",
      text: "Something went wrong somewhere.",
      provenance: prov("codex"),
    });
    await log.flush();
    await bg.sync(brain.all());
    expect(await bg.inferLinks(lonely.memory, brain.all())).toEqual([]);
  });
});

describe("cross-run continuity", () => {
  /**
   * Track 3, concretely: a project that has learned nothing still knows what a
   * different project learned about the same file. This works because `Entity`
   * nodes are shared across projects while `MemoryUnit`s are not.
   */
  it("carries a lesson from one project into a brand-new one", async () => {
    if (!up) return;
    const token = uniqueEntity("RUST_MIN_STACK");
    const runA = await setup("xrun-a");
    runA.brain.add({
      kind: "constraint",
      text: `graph-node needs ${token} at 33554432 or its query futures overflow the stack.`,
      provenance: prov("codex"),
    });
    await runA.log.flush();
    await runA.bg.sync(runA.brain.all());

    const runB = await setup("xrun-b");
    expect(runB.brain.all()).toHaveLength(0);

    const carried = await runB.bg.crossRun([token]);
    expect(carried.length).toBeGreaterThan(0);
    expect(carried.some((m) => m.text.includes("33554432"))).toBe(true);
    // And it is not confused for one of this project's own memories.
    expect(carried.every((m) => m.project !== runB.graph.slot)).toBe(true);
  });

  /**
   * The bridge between a human typing a word and the graph's exact names.
   *
   * `queryEntities` only recognises things that look like identifiers, so a
   * plain word resolves to nothing and cross-run recall used to answer a
   * search box with a 400. The prefix resolver is what closes that, and this
   * asserts the property it depends on: a file is recorded under its basename
   * as well as its path, so the basename is reachable by prefix.
   */
  it("resolves a typed word to the entity names that exist", async () => {
    if (!up) return;
    const token = uniqueEntity("RUST_MIN_STACK");
    const { brain, bg, log } = await setup("xrun-prefix");
    brain.add({
      kind: "convention",
      text: `Set ${token} before starting the node.`,
      provenance: prov("codex"),
    });
    await log.flush();
    await bg.sync(brain.all());

    // The stored entity is lowercased; the prefix is the stem a human types.
    // It has to stay inside this run's unique suffix: every previous run of
    // this file left its own `rust_min_stack_*` entities on the shared node,
    // and a shorter stem matches all of them and is cut off by the LIMIT.
    const full = token.toLowerCase();
    const names = await bg.entitiesMatching(full.slice(0, full.length - 2), 20);
    expect(names).toContain(full);

    // Too short to be worth a scan — a one-character prefix would match most
    // of the table and answer with noise.
    expect(await bg.entitiesMatching("r")).toEqual([]);
    expect(await bg.entitiesMatching("   ")).toEqual([]);
  });

  it("excludes this project's own memories unless asked for them", async () => {
    if (!up) return;
    const token = uniqueEntity("NOTCH_LOCAL_PORT");
    const { brain, bg, log } = await setup("xrun-self");
    brain.add({
      kind: "fact",
      text: `The daemon binds ${token} on start.`,
      provenance: prov("claude-code"),
    });
    await log.flush();
    await bg.sync(brain.all());

    const without = await bg.crossRun([token]);
    expect(without).toEqual([]);
    const with_ = await bg.crossRun([token], { includeThisProject: true });
    expect(with_.some((m) => m.text.includes(token))).toBe(true);
  });
});

describe("handoff provenance", () => {
  it("records exactly which memories were injected into a handoff", async () => {
    if (!up) return;
    const { brain, bg, log } = await setup("projected");
    const a = brain.add({ kind: "fact", text: "Alpha is a fact.", provenance: prov("claude-code") });
    const b = brain.add({ kind: "fact", text: "Beta is a fact.", provenance: prov("claude-code") });
    const c = brain.add({ kind: "fact", text: "Gamma was not sent.", provenance: prov("claude-code") });
    await log.flush();
    await bg.sync(brain.all());

    await bg.recordProjection("7:claude-code->codex", [a.memory.id, b.memory.id], {
      from: "claude-code",
      to: "codex",
      epoch: 7,
      at: Date.now(),
    });

    const injected = await bg.projectedAt("7:claude-code->codex");
    const ids = injected.map((m) => m.memoryId).sort();
    expect(ids).toEqual([a.memory.id, b.memory.id].sort());
    expect(ids).not.toContain(c.memory.id);
  });

  it("records the handoff edge even when nothing was injected", async () => {
    if (!up) return;
    const { bg } = await setup("emptyhandoff");
    await bg.recordProjection("1:->alpha", [], {
      from: null,
      to: "alpha",
      epoch: 1,
      at: Date.now(),
    });
    const edges = await bg.handoffGraph();
    expect(edges.some((e) => e.to === "alpha")).toBe(true);
  });
});
