/**
 * Parallel agent runs, in the graph.
 *
 * The baton is one write lock, and that is deliberate: exactly one agent may
 * modify the working tree. So "run every agent at once" cannot mean "let five
 * CLIs edit the same files" — that is the race the baton exists to prevent, and
 * building it would undo the guarantee the rest of this project is about.
 *
 * What it *can* mean, safely and usefully, is a **council**: put one question
 * to the whole fleet at the same time, give every member the same brain, and
 * put the answers side by side. Nobody takes the baton, nobody writes, and the
 * comparison is the point — five agents disagreeing about an approach is more
 * information than one agent asserting it.
 *
 *   (:Project)-[:HAS_COUNCIL]->(:Council {question, at, agents, status})
 *   (:Council)-[:ANSWERED]->(:CouncilAnswer {agent, text, ms, cost, ok})
 *   (:CouncilAnswer)-[:BY]->(:Agent)
 *
 * In the graph rather than in memory because a council is evidence: which
 * agents were asked, what each said, which one you picked, and what the pick
 * became. A daemon restart in the middle of a demo should not lose that, and
 * the Provenance tab reads it back from here.
 */

import crypto from "node:crypto";
import { logbook } from "../core/logbook.js";
import type { ProjectGraph } from "./graph.js";
import { LABEL, REL, relId } from "./graph.js";
import { kindBase } from "./ids.js";

/** One agent's answer to the council's question. */
export interface CouncilAnswer {
  agent: string;
  /** What it said. Empty until the turn completes. */
  text: string;
  /** Wall-clock for that agent's turn. */
  ms: number;
  /** What the adapter reported spending, or 0 when it reports nothing. */
  cost: number;
  /** False when the turn errored — the error text is in `text`. */
  ok: boolean;
  /** Set when the human picks this answer as the one to act on. */
  chosen: boolean;
}

export interface CouncilRun {
  id: string;
  question: string;
  at: number;
  agents: string[];
  /** `running` until every member has answered or failed. */
  status: "running" | "done";
  answers: CouncilAnswer[];
}

function councilVid(slot: number): number {
  return kindBase("council") + slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
}
function answerVid(slot: number): number {
  return kindBase("answer") + slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
}

/**
 * Per-project council writer and reader.
 *
 * Writes are best-effort in the same sense the telemetry writer's are: a
 * council that cannot be persisted must not take the turns down with it. But
 * unlike telemetry it is small and infrequent, so each write is awaited rather
 * than batched — the UI reads it back immediately after.
 */
export class CouncilStore {
  private vids = new Map<string, number>();

  constructor(private graph: ProjectGraph) {}

  /** Record a council the moment it starts, so a crash mid-run still shows it. */
  async start(run: Omit<CouncilRun, "answers" | "status">): Promise<void> {
    await this.graph.open();
    const vid = councilVid(this.graph.slot);
    this.vids.set(run.id, vid);
    try {
      await this.graph.client.upsertNodes(
        "Council",
        [
          {
            id: vid,
            cid: run.id,
            question: String(run.question).slice(0, 8000),
            at: run.at,
            // A list property would be a list value; the agents ride as one
            // string because HydraDB properties are scalars.
            agents: run.agents.join(","),
            status: "running",
            proj: this.graph.slot,
          },
        ],
        ["cid", "question", "at", "agents", "status", "proj"],
      );
      await this.graph.client.relate(LABEL.project, REL.hasCouncil, "Council", [
        { src: this.graph.vid, dst: vid, rid: relId(this.graph.vid, vid, REL.hasCouncil) },
      ]);
    } catch (err) {
      logbook.warn("council", "could not persist a council start", err instanceof Error ? err.message : String(err));
    }
  }

  /** Record one member's answer as it lands, not at the end of the run. */
  async answer(runId: string, a: CouncilAnswer): Promise<void> {
    const cv = this.vids.get(runId);
    if (cv === undefined) return;
    await this.graph.open();
    const vid = answerVid(this.graph.slot);
    try {
      await this.graph.client.upsertNodes(
        "CouncilAnswer",
        [
          {
            id: vid,
            cid: runId,
            agent: a.agent,
            text: String(a.text ?? "").slice(0, 24000),
            ms: a.ms,
            cost: a.cost,
            ok: a.ok ? 1 : 0,
            chosen: a.chosen ? 1 : 0,
            proj: this.graph.slot,
          },
        ],
        ["cid", "agent", "text", "ms", "cost", "ok", "chosen", "proj"],
      );
      await this.graph.client.relate("Council", REL.answered, "CouncilAnswer", [
        { src: cv, dst: vid, rid: relId(cv, vid, REL.answered) },
      ]);
      const av = await this.graph.agentVid(a.agent);
      await this.graph.client.relate("CouncilAnswer", REL.by, LABEL.agent, [
        { src: vid, dst: av, rid: relId(vid, av, REL.by) },
      ]);
    } catch (err) {
      logbook.warn("council", "could not persist a council answer", err instanceof Error ? err.message : String(err));
    }
  }

  /** Close the run out. */
  async finish(runId: string): Promise<void> {
    const vid = this.vids.get(runId);
    if (vid === undefined) return;
    await this.graph.open();
    try {
      await this.graph.client.upsertNodes("Council", [{ id: vid, status: "done" }], ["status"]);
    } catch (err) {
      logbook.warn("council", "could not close a council", err instanceof Error ? err.message : String(err));
    }
  }

  /** Mark the answer the human acted on. The rest stay, because they are the evidence. */
  async choose(runId: string, agent: string): Promise<void> {
    await this.graph.open();
    try {
      const res = await this.graph.client.query(
        "MATCH (c:Council {cid: $cid})-[:" + REL.answered + "]->(a:CouncilAnswer) WHERE a.agent = $agent " +
          "RETURN a.id AS id LIMIT 1",
        { cid: runId, agent },
        { consistency: "strong" },
      );
      const id = Number(res.rows[0]?.id ?? 0);
      if (id) await this.graph.client.upsertNodes("CouncilAnswer", [{ id, chosen: 1 }], ["chosen"]);
    } catch (err) {
      logbook.warn("council", "could not record a council pick", err instanceof Error ? err.message : String(err));
    }
  }

  /** Councils newest first, each with its answers. */
  async list(limit = 10): Promise<CouncilRun[]> {
    await this.graph.open();
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasCouncil}]->(c:Council) ` +
        "RETURN c.cid AS cid, c.question AS question, c.at AS at, c.agents AS agents, c.status AS status " +
        "ORDER BY at DESC LIMIT $limit",
      { pv: this.graph.vid, limit: Math.min(50, limit) },
    );
    const runs: CouncilRun[] = [];
    for (const r of res.rows) {
      const id = String(r.cid ?? "");
      if (!id) continue;
      const ans = await this.graph.client.query(
        "MATCH (c:Council {cid: $cid})-[:" + REL.answered + "]->(a:CouncilAnswer) " +
          "RETURN a.agent AS agent, a.text AS text, a.ms AS ms, a.cost AS cost, a.ok AS ok, a.chosen AS chosen",
        { cid: id },
      );
      runs.push({
        id,
        question: String(r.question ?? ""),
        at: Number(r.at ?? 0),
        agents: String(r.agents ?? "").split(",").filter(Boolean),
        status: String(r.status ?? "running") === "done" ? "done" : "running",
        answers: ans.rows.map((x) => ({
          agent: String(x.agent ?? ""),
          text: String(x.text ?? ""),
          ms: Number(x.ms ?? 0),
          cost: Number(x.cost ?? 0),
          ok: Number(x.ok ?? 0) === 1,
          chosen: Number(x.chosen ?? 0) === 1,
        })),
      });
    }
    return runs;
  }
}

const stores = new WeakMap<ProjectGraph, CouncilStore>();

/** One store per project graph, so the vid map is shared across callers. */
export function councilFor(graph: ProjectGraph): CouncilStore {
  let s = stores.get(graph);
  if (!s) {
    s = new CouncilStore(graph);
    stores.set(graph, s);
  }
  return s;
}
