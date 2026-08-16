/**
 * Read-backs the Observatory renders.
 *
 * These deliberately query HydraDB rather than folding the in-memory mirror,
 * even where the mirror holds the same events. Two reasons, and only the second
 * is about correctness:
 *
 *   - Replay's `strong` mode is only meaningful if the read actually goes to
 *     the store. Folding a local array and *calling* it verified would be a
 *     lie in the one place the product makes a verification claim.
 *   - A daemon that has been running for five minutes has five minutes of log
 *     in memory; the graph has every run this project has ever had.
 */

import type { ProjectGraph } from "./graph.js";
import type { Consistency } from "./client.js";

export interface GraphCounts {
  events: number;
  memories: number;
  entities: number;
  handoffs: number;
  claims: number;
  violations: number;
  agents: number;
}

/**
 * What this project actually has in the graph. Shown by `loom doctor`.
 *
 * Deliberately impatient. This is the *diagnostic* — the thing you call when
 * you suspect the node is unwell — so it must not inherit the 30s query budget
 * and four retries that a real read gets. On a paused node that combination
 * turned "is HydraDB up?" into a 45-second hang, which is the least useful
 * possible answer to that question.
 */
export async function graphCounts(graph: ProjectGraph): Promise<GraphCounts> {
  const probe = { timeoutMs: 4_000, retries: 1 } as const;
  await graph.open();
  // Counted through the project's edges rather than by scanning each label for
  // a matching `proj` — the scan is a full pass over every project's rows.
  const via = async (rel: string, label: string): Promise<number> => {
    const res = await graph.client.query(
      `MATCH (p:Project {id: $pv})-[:${rel}]->(n:${label}) RETURN count(*) AS n`,
      { pv: graph.vid },
      probe,
    );
    return Number(res.rows[0]?.n ?? 0);
  };
  const global = async (label: string): Promise<number> => {
    const res = await graph.client.query(`MATCH (n:${label}) RETURN count(*) AS n`, {}, probe);
    return Number(res.rows[0]?.n ?? 0);
  };
  const [events, memories, entities, handoffs, claims, violations, agents] = await Promise.all([
    via("HAS_EVENT", "Event"),
    via("HAS_MEMORY", "MemoryUnit"),
    // Entities are shared across projects on purpose — that is what makes
    // cross-run recall possible — so this one is a global count.
    global("Entity"),
    via("HAS_HANDOFF", "Handoff"),
    via("HAS_CLAIM", "BatonClaim"),
    via("HAS_FENCING", "FencingViolation"),
    via("HAS_AGENT", "Agent"),
  ]);
  return { events, memories, entities, handoffs, claims, violations, agents };
}

export interface ReplaySnapshot {
  /** The last event id included. */
  until: number;
  at: number;
  holder: string | null;
  epoch: number;
  events: number;
  decisions: { ts: number; text: string; by: string }[];
  thread: { ts: number; author: string; text: string }[];
  agents: { id: string; state: string; lastTs: number }[];
  /** The storage sequence the read was pinned at — proof of what was verified. */
  readEpoch: number | null;
}

/**
 * Reconstruct "who held the baton at event N, and what had been said" straight
 * out of the graph.
 *
 * This is the thing the append-only log buys and a mutable state table cannot:
 * every intermediate state is still derivable because none of them were ever
 * overwritten.
 */
export async function replayAt(
  graph: ProjectGraph,
  until: number,
  consistency: Consistency = "causal",
): Promise<ReplaySnapshot> {
  await graph.open();
  const res = await graph.client.query(
    "MATCH (p:Project {id: $pv})-[:HAS_EVENT]->(e:Event) WHERE e.seq <= $until " +
      "RETURN e.seq AS seq, e.ts AS ts, e.kind AS kind, e.agent AS agent, e.payload AS payload " +
      "ORDER BY seq",
    { pv: graph.vid, until },
    { consistency },
  );

  let holder: string | null = null;
  let epoch = 0;
  let at = 0;
  const decisions: ReplaySnapshot["decisions"] = [];
  const thread: ReplaySnapshot["thread"] = [];
  const agents = new Map<string, { id: string; state: string; lastTs: number }>();

  for (const row of res.rows) {
    const ts = Number(row.ts ?? 0);
    const kind = String(row.kind ?? "");
    const agent = String(row.agent ?? "");
    at = Math.max(at, ts);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(String(row.payload ?? "{}")) as Record<string, unknown>;
    } catch {
      // A payload that will not parse is still an event that happened; the
      // fold keeps going rather than losing the rest of the timeline to it.
    }
    if (kind === "handoff") {
      holder = (payload.to as string | null) ?? null;
      if (typeof payload.epoch === "number") epoch = payload.epoch;
    } else if (kind === "decision") {
      decisions.push({ ts, text: String(payload.text ?? ""), by: agent || "user" });
    } else if (kind === "message") {
      thread.push({
        ts,
        author: agent || String(payload.author ?? "user"),
        text: String(payload.text ?? "").slice(0, 400),
      });
    }
    if (agent) {
      const state =
        kind === "run_complete" ? "idle" : kind === "message" ? "running" : kind === "error" ? "error" : "idle";
      agents.set(agent, { id: agent, state, lastTs: ts });
    }
  }

  return {
    until: Number(res.rows[res.rows.length - 1]?.seq ?? 0),
    at,
    holder,
    epoch,
    events: res.rows.length,
    decisions: decisions.slice(-40),
    thread: thread.slice(-60),
    agents: [...agents.values()],
    readEpoch: res.readEpoch,
  };
}
