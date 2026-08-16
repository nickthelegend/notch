/**
 * Saved actions — shell commands and agent prompts you keep.
 *
 * The same three commands get retyped in every workspace: the build, the
 * focused test, the lint. And the same three prompts get retyped at every
 * agent: "review this diff against the constraints in the brain", "write the
 * failing test first". Retyping them is not the cost — *misremembering* them is.
 *
 * So an action is a named, reusable thing with exactly two kinds:
 *
 *   shell   a command line, run in whichever workspace is open
 *   prompt  a message, sent to whichever agent holds the baton
 *
 * Deliberately **global**, not per-project, because that is the whole point:
 * you save `npm test -- --run` once and it is on the toolbar of every project
 * you open afterwards. That makes `(:Action)` one of the two labels in this
 * codebase reached by a plain label match rather than through a `HAS_*` edge
 * from a project — the same exception `(:Entity)` gets, and for the same
 * reason: it is small (tens of rows, not tens of thousands) and it is *supposed*
 * to be shared. Everything project-scoped still hangs off an edge.
 */

import crypto from "node:crypto";
import { logbook } from "../core/logbook.js";
import type { HydraClient } from "./client.js";
import { hydra } from "./client.js";
import { kindBase } from "./ids.js";

export type ActionKind = "shell" | "prompt";

export interface SavedAction {
  /** Short opaque id, minted here. */
  id: string;
  name: string;
  kind: ActionKind;
  /** The command line, or the prompt text. */
  body: string;
  at: number;
  /** How many times it has been run — the toolbar orders by this. */
  runs: number;
}

function actionVid(): number {
  return kindBase("action") + crypto.randomInt(0, 2 ** 40);
}

/** Everything a caller can set; the rest is bookkeeping. */
export interface ActionInput {
  name: string;
  kind: ActionKind;
  body: string;
}

export class ActionStore {
  constructor(private client: HydraClient) {}

  /** Saved actions, most-run first, then newest. */
  async list(): Promise<SavedAction[]> {
    const res = await this.client.query(
      "MATCH (a:Action) RETURN a.aid AS aid, a.name AS name, a.kind AS kind, " +
        "a.body AS body, a.at AS at, a.runs AS runs ORDER BY at DESC",
    );
    const rows = res.rows
      .map((r) => ({
        id: String(r.aid ?? ""),
        name: String(r.name ?? ""),
        kind: (String(r.kind ?? "shell") === "prompt" ? "prompt" : "shell") as ActionKind,
        body: String(r.body ?? ""),
        at: Number(r.at ?? 0),
        runs: Number(r.runs ?? 0),
      }))
      .filter((a) => a.id && a.name);
    rows.sort((a, b) => b.runs - a.runs || b.at - a.at);
    return rows;
  }

  /**
   * Create one, or overwrite an existing one when `id` is supplied.
   *
   * The body cap is the property cap with room to spare: a single HydraDB
   * property value is capped at 32 KiB, and an action that silently lost its
   * tail would be worse than one that refused to save.
   */
  async save(input: ActionInput & { id?: string }): Promise<SavedAction> {
    const name = String(input.name ?? "").trim().slice(0, 80);
    const body = String(input.body ?? "").trim().slice(0, 8000);
    if (!name) throw new Error("an action needs a name");
    if (!body) throw new Error("an action needs something to run");
    const kind: ActionKind = input.kind === "prompt" ? "prompt" : "shell";

    const existing = input.id ? await this.find(input.id) : null;
    const id = existing?.id ?? crypto.randomBytes(6).toString("hex");
    const vid = existing ? existing.vid : actionVid();
    const at = existing?.at ?? Date.now();
    const runs = existing?.runs ?? 0;

    await this.client.upsertNodes(
      "Action",
      [{ id: vid, aid: id, name, kind, body, at, runs }],
      ["aid", "name", "kind", "body", "at", "runs"],
    );
    return { id, name, kind, body, at, runs };
  }

  /** The row behind an id, with its vertex id — internal, so writes hit the same node. */
  private async find(
    id: string,
  ): Promise<{ vid: number; id: string; at: number; runs: number } | null> {
    const res = await this.client.query(
      "MATCH (a:Action {aid: $aid}) RETURN a.id AS id, a.at AS at, a.runs AS runs LIMIT 1",
      { aid: id },
      { consistency: "strong" },
    );
    const row = res.rows[0];
    if (!row) return null;
    return { vid: Number(row.id ?? 0), id, at: Number(row.at ?? 0), runs: Number(row.runs ?? 0) };
  }

  /** Count a run. Best-effort: a lost counter must never fail the run itself. */
  async recordRun(id: string): Promise<void> {
    try {
      const hit = await this.find(id);
      if (!hit) return;
      await this.client.upsertNodes("Action", [{ id: hit.vid, runs: hit.runs + 1 }], ["runs"]);
    } catch (err) {
      logbook.warn("actions", "could not count an action run", err instanceof Error ? err.message : String(err));
    }
  }

  /** Fetch one for running. */
  async get(id: string): Promise<SavedAction | null> {
    const res = await this.client.query(
      "MATCH (a:Action {aid: $aid}) RETURN a.aid AS aid, a.name AS name, a.kind AS kind, " +
        "a.body AS body, a.at AS at, a.runs AS runs LIMIT 1",
      { aid: id },
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: String(r.aid ?? ""),
      name: String(r.name ?? ""),
      kind: (String(r.kind ?? "shell") === "prompt" ? "prompt" : "shell") as ActionKind,
      body: String(r.body ?? ""),
      at: Number(r.at ?? 0),
      runs: Number(r.runs ?? 0),
    };
  }

  /**
   * Forget one.
   *
   * The node is deleted rather than tombstoned. An action is a convenience, not
   * evidence — nothing in the graph points at it, so there is no history to
   * preserve and a tombstone would only make the toolbar slower.
   */
  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id);
    if (!hit) return false;
    await this.client.query("MATCH (a:Action {aid: $aid}) DELETE a", { aid: id });
    return true;
  }
}

let shared: ActionStore | null = null;

/** One store per process, on the shared client. */
export function actionStore(): ActionStore {
  if (!shared) shared = new ActionStore(hydra());
  return shared;
}

/** Tests point it at their own graph. */
export function setActionStore(store: ActionStore | null): void {
  shared = store;
}
