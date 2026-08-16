/**
 * Decisions, on HydraDB.
 *
 * These used to live in `.loom/decisions.json`. That was the last store left
 * behind when the log, the baton and the brain moved into the graph, and it had
 * two consequences worth naming rather than tidying away quietly:
 *
 *   1. The Decisions Explorer emptied when `.loom/` was deleted, while the
 *      README says a `.loom/` you can delete is the point.
 *   2. A decision recorded by hand — `loom decision "…"`, which writes a
 *      `decision` event to the log — never appeared in the Explorer at all,
 *      because the Explorer read the file and the file only knew about mined
 *      decisions. Two ways to record a decision, one of which the UI ignored.
 *
 * So decisions are `(:Decision)` nodes hanging off the project, and the reader
 * unions them with the `decision` events already in the log. A hand-written
 * decision and a mined one are the same kind of thing to whoever is reading;
 * they differ only in `source`, which is shown rather than hidden.
 */

import type { AgentDecision, DecisionCategory, DecisionSource } from "../observability/decisions.js";
import { normalizeStoredDecision } from "../observability/decisions.js";
import type { LoomEvent } from "../types.js";
import type { ProjectGraph } from "./graph.js";
import { LABEL, REL, relId } from "./graph.js";
import { kindBase } from "./ids.js";

/** Bounded like the file it replaces, so one project cannot grow without limit. */
const MAX_DECISIONS = 1000;

function decisionVid(slot: number, id: string): number {
  // Decisions carry their own generated ids; hash into the project's band.
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return kindBase("alert") + slot * 2 ** 32 + h;
}

/** Lists are not property values, so the array fields ride as JSON strings. */
function packList(v: string[] | undefined): string {
  return JSON.stringify(v ?? []);
}
function unpackList(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const out = JSON.parse(v) as unknown;
    return Array.isArray(out) ? out.map(String) : [];
  } catch {
    return [];
  }
}

export class DecisionStore {
  constructor(private graph: ProjectGraph) {}

  async store(decisions: AgentDecision[]): Promise<void> {
    if (!decisions.length) return;
    await this.graph.open();
    const rows = decisions.map((d) => ({
      id: decisionVid(this.graph.slot, d.id),
      did: d.id,
      chat: d.chatId ?? "",
      agent: d.agentId ?? "",
      role: d.agentRole ?? "",
      ts: d.timestamp ?? 0,
      turn_index: d.turnIndex ?? 0,
      trace: d.traceId ?? "",
      turn_id: d.turnId ?? "",
      category: String(d.category ?? "other"),
      title: String(d.title ?? "").slice(0, 4000),
      reasoning: String(d.reasoning ?? "").slice(0, 8000),
      // -1 rather than 0: a heuristic decision carries no confidence at all,
      // and storing 0 would render as "0% confident" — a measured claim the
      // extractor never made.
      conf: typeof d.confidence === "number" ? d.confidence : -1,
      source: String(d.source ?? "heuristic"),
      alternatives: packList(d.alternatives),
      files_created: packList(d.filesCreated),
      files_modified: packList(d.filesModified),
      artifacts: packList(d.artifactNames),
      memory_keys: packList(d.memoryKeys),
      upstream: packList(d.upstreamDecisionIds),
      turn_tokens: d.turnTokensUsed ?? 0,
      turn_cost: d.turnCostUsd ?? 0,
      duration: d.durationMs ?? 0,
    }));

    await this.graph.client.query(
      "UNWIND $rows AS row MERGE (d {id: row.id}) SET d:Decision, d.did = row.did, " +
        "d.chat = row.chat, d.agent = row.agent, d.role = row.role, d.ts = row.ts, " +
        "d.turn_index = row.turn_index, d.trace = row.trace, d.turn_id = row.turn_id, " +
        "d.category = row.category, d.title = row.title, d.reasoning = row.reasoning, " +
        "d.conf = row.conf, d.source = row.source, d.alternatives = row.alternatives, " +
        "d.files_created = row.files_created, d.files_modified = row.files_modified, " +
        "d.artifacts = row.artifacts, d.memory_keys = row.memory_keys, " +
        "d.upstream = row.upstream, d.turn_tokens = row.turn_tokens, " +
        "d.turn_cost = row.turn_cost, d.duration = row.duration",
      { rows },
    );
    await this.graph.client.relate(
      LABEL.project,
      REL.hasDecision,
      "Decision",
      rows.map((r) => ({
        src: this.graph.vid,
        dst: r.id,
        rid: relId(this.graph.vid, r.id, REL.hasDecision),
      })),
    );
  }

  /** Every decision this project has recorded, newest first. */
  async list(): Promise<AgentDecision[]> {
    await this.graph.open();
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasDecision}]->(d:Decision) ` +
        "RETURN d.did AS did, d.chat AS chat, d.agent AS agent, d.role AS role, d.ts AS ts, " +
        "d.turn_index AS turn_index, d.trace AS trace, d.turn_id AS turn_id, " +
        "d.category AS category, d.title AS title, d.reasoning AS reasoning, d.conf AS conf, " +
        "d.source AS source, d.alternatives AS alternatives, d.files_created AS files_created, " +
        "d.files_modified AS files_modified, d.artifacts AS artifacts, " +
        "d.memory_keys AS memory_keys, d.upstream AS upstream, d.turn_tokens AS turn_tokens, " +
        "d.turn_cost AS turn_cost, d.duration AS duration " +
        "ORDER BY ts DESC LIMIT $limit",
      { pv: this.graph.vid, limit: MAX_DECISIONS },
    );
    return res.rows.map((r) => {
      const conf = Number(r.conf ?? -1);
      return normalizeStoredDecision({
        id: String(r.did ?? ""),
        projectId: this.graph.projectId,
        chatId: String(r.chat ?? ""),
        agentId: String(r.agent ?? ""),
        agentRole: String(r.role ?? ""),
        timestamp: Number(r.ts ?? 0),
        turnIndex: Number(r.turn_index ?? 0),
        ...(r.trace ? { traceId: String(r.trace) } : {}),
        ...(r.turn_id ? { turnId: String(r.turn_id) } : {}),
        category: String(r.category ?? "other") as DecisionCategory,
        title: String(r.title ?? ""),
        reasoning: String(r.reasoning ?? ""),
        ...(conf >= 0 ? { confidence: conf } : {}),
        source: String(r.source ?? "heuristic") as DecisionSource,
        alternatives: unpackList(r.alternatives),
        filesCreated: unpackList(r.files_created),
        filesModified: unpackList(r.files_modified),
        artifactNames: unpackList(r.artifacts),
        memoryKeys: unpackList(r.memory_keys),
        upstreamDecisionIds: unpackList(r.upstream),
        turnTokensUsed: Number(r.turn_tokens ?? 0),
        turnCostUsd: Number(r.turn_cost ?? 0),
        durationMs: Number(r.duration ?? 0),
      });
    });
  }
}

/**
 * Decisions a human typed, lifted out of the log.
 *
 * `loom decision "…"` and `POST /decisions` both append a `decision` event and
 * nothing else — there is no turn to mine and no extractor involved. Rendering
 * them alongside the mined ones is the whole point of the Explorer; leaving
 * them out made the most deliberate decisions in a project the only ones it
 * could not show.
 */
export function decisionsFromLog(events: LoomEvent[], projectId: string): AgentDecision[] {
  const out: AgentDecision[] = [];
  for (const e of events) {
    if (e.kind !== "decision") continue;
    const text = String((e.payload as Record<string, unknown>).text ?? "").trim();
    if (!text) continue;
    // An auto-captured "Decision:" line from an agent reply is attributed to
    // that agent; a typed one is the user's.
    const auto = (e.payload as Record<string, unknown>).auto === true;
    out.push(
      normalizeStoredDecision({
        id: `log-${e.id}`,
        projectId,
        chatId: e.chat ?? "",
        agentId: e.agentId ?? (auto ? "" : "user"),
        agentRole: auto ? "agent" : "human",
        timestamp: e.ts,
        turnIndex: 0,
        turnId: String(e.id),
        category: "other" as DecisionCategory,
        title: text.slice(0, 200),
        reasoning: text,
        // No confidence: nobody measured one. A number here would be invented.
        source: (auto ? "heuristic" : "human") as DecisionSource,
        alternatives: [],
        filesCreated: [],
        filesModified: [],
        artifactNames: [],
        memoryKeys: [],
        upstreamDecisionIds: [],
        turnTokensUsed: 0,
        turnCostUsd: 0,
        durationMs: 0,
      }),
    );
  }
  return out;
}
