/**
 * The graph model, and one project's handle onto it.
 *
 * Notch's concepts were already a graph — agents pass a baton, a memory is
 * asserted by whoever learned it, a failure is caused by a decision, a decision
 * is constrained by a constraint. SQLite made all of that a foreign key you had
 * to join by hand, and the two questions worth asking ("what did this agent
 * know when it took over", "why did this actually fail") were the two that
 * fell out of expressible range. Here they are one traversal each.
 *
 *   (:Project)
 *     -[:HAS_EVENT]->  (:Event)-[:NEXT]->(:Event)      the log, explicitly ordered
 *     -[:HAS_MEMORY]-> (:MemoryUnit)
 *     -[:HAS_CLAIM]->  (:BatonClaim)
 *     -[:HAS_HANDOFF]->(:Handoff)
 *     -[:HAS_FENCING]->(:FencingViolation)
 *     -[:HAS_AGENT]->  (:Agent)
 *     -[:HAS_SPAN]->   (:Span)             telemetry: one per turn/handoff/route
 *     -[:HAS_LOG]->    (:LogLine)          the structured log
 *     -[:HAS_COUNCIL]->(:Council)          one question put to the whole fleet
 *   (:Council)-[:ANSWERED]->(:CouncilAnswer)-[:BY]->(:Agent)
 *   (:Event)-[:CHUNK]->(:EventChunk)                   payloads over 32 KiB
 *
 *   (:Handoff)-[:FROM]->(:Agent)  -[:TO]->(:Agent)
 *   (:Agent)-[:ASSERTED]->(:MemoryUnit)
 *   (:MemoryUnit)-[:PROJECTED_AT]->(:Handoff)          what was injected, when
 *   (:MemoryUnit)-[:SUPERSEDES]->(:MemoryUnit)         the correction chain
 *   (:MemoryUnit)-[:ABOUT]->(:Entity)                  files, symbols, error codes
 *   (:MemoryUnit)-[:CAUSED_BY]->(:MemoryUnit)          failure → decision
 *   (:MemoryUnit)-[:CONSTRAINED_BY]->(:MemoryUnit)     decision → constraint
 *   (:BatonClaim)-[:CLAIMED_BY]->(:Agent)
 *   (:FencingViolation)-[:BY]->(:Agent)
 *
 * `ABOUT` is the edge that makes recall a graph problem instead of a text
 * problem: two memories that never share a word are one hop apart when they
 * are about the same file.
 *
 * Every `HAS_*` edge above exists for one reason, and it is not tidiness.
 * Scoping by property — `MATCH (e:Event) WHERE e.proj = $slot` — is a full
 * scan of every event in the graph, and the graph holds every project. Measured
 * on 74k events: **2.27s for the scan, 0.010s for the traversal**, for the same
 * one-row answer. Reaching a project's rows through its own edges is the
 * difference between a store that grows gracefully and one that gets slower
 * every time somebody else starts a project.
 */

import { HydraClient, hydra } from "./client.js";
import { IdAllocator, kindBase } from "./ids.js";

export const LABEL = {
  project: "Project",
  event: "Event",
  agent: "Agent",
  memory: "MemoryUnit",
  handoff: "Handoff",
  claim: "BatonClaim",
  fencing: "FencingViolation",
  entity: "Entity",
  idmap: "IdMap",
} as const;

export const REL = {
  hasEvent: "HAS_EVENT",
  hasMemory: "HAS_MEMORY",
  hasDecision: "HAS_DECISION",
  hasSpan: "HAS_SPAN",
  hasLog: "HAS_LOG",
  hasClaim: "HAS_CLAIM",
  hasHandoff: "HAS_HANDOFF",
  hasFencing: "HAS_FENCING",
  hasAgent: "HAS_AGENT",
  next: "NEXT",
  from: "FROM",
  to: "TO",
  asserted: "ASSERTED",
  projectedAt: "PROJECTED_AT",
  supersedes: "SUPERSEDES",
  about: "ABOUT",
  causedBy: "CAUSED_BY",
  constrainedBy: "CONSTRAINED_BY",
  claimedBy: "CLAIMED_BY",
  by: "BY",
  chunk: "CHUNK",
  hasCouncil: "HAS_COUNCIL",
  answered: "ANSWERED",
} as const;

/**
 * Relationship ids have to be unique integers too, and unlike vertices there is
 * no natural key to hash — an edge is identified by its endpoints and type.
 * Folding those three together keeps `MERGE (s)-[r:T {id: ...}]->(d)` idempotent
 * on replay, which is what makes a retried batch a no-op instead of a duplicate.
 */
export function relId(src: number, dst: number, type: string): number {
  let h = 2166136261;
  const s = `${src}:${dst}:${type}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Relationship ids live in their own space; HydraDB does not share them
  // with vertices, so a plain 32-bit spread is enough.
  return h;
}

/** One project's view of the graph: the client, the id table, and its root node. */
export class ProjectGraph {
  readonly client: HydraClient;
  readonly ids: IdAllocator;
  readonly projectId: string;
  private _slot = -1;
  private _vid = -1;
  private ready: Promise<void> | null = null;

  constructor(projectId: string, client: HydraClient = hydra()) {
    this.projectId = projectId;
    this.client = client;
    this.ids = new IdAllocator(client);
  }

  get slot(): number {
    if (this._slot < 0) throw new Error("ProjectGraph.open() has not completed");
    return this._slot;
  }

  get vid(): number {
    if (this._vid < 0) throw new Error("ProjectGraph.open() has not completed");
    return this._vid;
  }

  /**
   * Idempotent. Concurrent callers share one in-flight open.
   *
   * A *failed* open is not cached. Holding on to the rejected promise meant one
   * transient outage poisoned the project permanently: HydraDB came back, every
   * `open()` kept replaying the same stale rejection, and the only cure was
   * restarting the daemon. Clearing it on failure makes the next caller retry,
   * which is what "the node was briefly down" should cost.
   */
  open(): Promise<void> {
    if (!this.ready) {
      this.ready = this.doOpen().catch((err: unknown) => {
        this.ready = null;
        this.ids.reset();
        this._slot = -1;
        this._vid = -1;
        throw err;
      });
    }
    return this.ready;
  }

  private async doOpen(): Promise<void> {
    await this.ids.hydrate(this.projectId);
    this._slot = await this.ids.projectSlot(this.projectId);
    this._vid = await this.ids.vid("project", this.projectId);
    await this.client.upsertNodes(
      LABEL.project,
      [{ id: this._vid, pid: this.projectId, slot: this._slot, opened_at: Date.now() }],
      ["pid", "slot", "opened_at"],
    );
    // A heartbeat row so `ping()` has something to match even on an empty
    // graph — "zero rows" and "the node is down" should not look alike.
    // Same id the client's write probe upserts, so the two cannot diverge.
    await this.client.upsertNodes(
      "HydraHeartbeat",
      [{ id: kindBase("idmap") + 4095, at: Date.now() }],
      ["at"],
    );
  }

  /** Vertex id for an agent, minting on first sight. */
  agentVid(agentId: string): Promise<number> {
    return this.ids.vid("agent", `${this.projectId}\u0000${agentId}`);
  }

  memoryVid(memoryId: string): Promise<number> {
    return this.ids.vid("memory", `${this.projectId}\u0000${memoryId}`);
  }

  entityVid(entity: string): Promise<number> {
    // Entities are deliberately NOT project-scoped. A constraint about
    // `src/core/baton.ts` learned in one run is about the same file in the
    // next one, and that is the whole basis of cross-run recall.
    return this.ids.vid("entity", entity.toLowerCase());
  }

  handoffVid(key: string): Promise<number> {
    return this.ids.vid("handoff", `${this.projectId}\u0000${key}`);
  }
}

const graphs = new Map<string, ProjectGraph>();

/** One ProjectGraph per project id per process. */
export function projectGraph(projectId: string, client?: HydraClient): ProjectGraph {
  const existing = graphs.get(projectId);
  if (existing && (!client || existing.client === client)) return existing;
  const g = new ProjectGraph(projectId, client);
  graphs.set(projectId, g);
  return g;
}
