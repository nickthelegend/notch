/**
 * The baton = the write lock. Exactly one adapter per project may hold it;
 * holding it is what authorizes edits to the shared working tree.
 *
 * ## Why this is not a mutex any more
 *
 * The previous implementation read `.loom/state.json`, compared the holder, and
 * wrote the file back. That is a read-modify-write with no interlock: two
 * agents that read "unheld" in the same millisecond both wrote themselves in,
 * and both believed it. It never showed up because a single daemon serialises
 * its own turns — the guarantee came from the runtime being single-threaded,
 * not from the lock. Nothing detected a violation, because nothing could.
 *
 * ## What replaces it
 *
 * HydraDB serialises every canonical mutation for a cell through exactly one
 * writer and stamps each commit with a monotonic storage sequence. Those
 * sequences are a **total order**, and the client is handed its position in it
 * on every write (the bookmark). That is the primitive this is built on.
 *
 * Taking the baton is an *election*, not an assignment:
 *
 *   1. read the settled epochs, `strong`, so the view is re-verified against
 *      object storage rather than a possibly-stale local reader;
 *   2. append a `(:BatonClaim)` for the next epoch and keep the storage
 *      sequence the write committed at;
 *   3. read every claim for that epoch and take the **lowest sequence** as the
 *      winner.
 *
 * The winner is stable the moment it is observable, because a sequence is
 * assigned at commit and only ever increases: a claim that arrives later
 * cannot acquire a lower sequence, so it can never displace a winner someone
 * has already seen. Every participant reading the same epoch computes the same
 * holder without talking to each other. Eight concurrent claimants elect
 * exactly one, and the other seven learn they lost — see
 * `test/baton-race.test.ts`, which runs that race against a real node.
 *
 * ## Fencing
 *
 * The winner of epoch N is the writer at epoch N. Every baton-authorized
 * action carries the epoch its holder won with. When an action shows up
 * carrying an epoch that is no longer current — the classic stale writer, an
 * agent that was interrupted and did not notice — it is refused *and recorded*
 * as a `(:FencingViolation)`. The old mutex could not do this: with no epoch
 * there was nothing to be stale about, so the write simply landed.
 *
 * ## What HydraDB does and does not give us
 *
 * Worth stating plainly, because it is easy to overclaim. HydraDB's own
 * writer leases and SlateDB epoch fencing are *internal* — they choose which
 * `graph-node` may write a cell, and are not exposed as a client lock API.
 * What is exposed, and what this uses, is the commit order those mechanisms
 * produce. So: the total order is the storage layer's and is real; the
 * interpretation of that order as a baton is Notch's. A `MATCH ... WHERE ...
 * SET` compare-and-swap was tried first and is **not** safe here — the
 * predicate is evaluated against a pinned snapshot with no write-write
 * conflict detection, so two writers both match and both apply. That finding
 * is why the election exists.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { EventLog } from "./eventlog.js";
import { readProjectState, writeProjectState } from "./registry.js";
import { projectGraph, type ProjectGraph, LABEL, REL, relId } from "../hydra/graph.js";
import { kindBase } from "../hydra/ids.js";
import type { Consistency } from "../hydra/client.js";

export class NotHolderError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly holder: string | null,
  ) {
    super(
      holder
        ? `agent "${agentId}" does not hold the baton (holder: "${holder}")`
        : `no agent holds the baton`,
    );
    this.name = "NotHolderError";
  }
}

/** A write arrived carrying an epoch that is no longer the current one. */
export class StaleEpochError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly staleEpoch: number,
    public readonly currentEpoch: number,
    public readonly currentHolder: string | null,
  ) {
    super(
      `agent "${agentId}" tried to write at baton epoch ${staleEpoch}, but the current epoch is ` +
        `${currentEpoch} (holder: ${currentHolder ?? "nobody"}) — write fenced`,
    );
    this.name = "StaleEpochError";
  }
}

export interface BatonState {
  holder: string | null;
  epoch: number;
  since: number | undefined;
  /** The storage sequence the winning claim committed at. */
  seq: number;
  reason: string;
  /**
   * The epoch at which the current holder's *unbroken* tenure began.
   *
   * Fencing compares against this rather than against `epoch`, and the
   * difference matters. The epoch counter moves for reasons that have nothing
   * to do with the holder losing authority — a contender standing and losing
   * still advances it. An agent should be fenced when it was **displaced**,
   * not because the counter ticked underneath a tenure it never lost. So a
   * writer is stale when its epoch predates the tenure, not when it merely
   * predates the head.
   */
  tenureEpoch: number;
}

export interface BatonEpochRow {
  epoch: number;
  holder: string | null;
  seq: number;
  at: number;
  reason: string;
  /** Everyone who wanted it at this epoch, winner first. */
  contenders: { agent: string | null; seq: number }[];
}

export interface FencingViolation {
  id: number;
  at: number;
  agent: string;
  staleEpoch: number;
  currentEpoch: number;
  currentHolder: string;
  op: string;
  detail: string;
}

const NOBODY = "";
const EMPTY: BatonState = {
  holder: null,
  epoch: 0,
  since: undefined,
  seq: 0,
  reason: "",
  tenureEpoch: 0,
};

/** Claim vertex ids: dense per project, random within it so two concurrent
 * claimants never write the same node — a collision there would silently merge
 * two claims into one and lose a contender from the election. */
function claimVid(slot: number): number {
  return kindBase("claim") + slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
}

export class BatonManager {
  private state: BatonState = EMPTY;
  private graph: ProjectGraph;

  private constructor(
    private projectDir: string,
    private log: EventLog,
    graph: ProjectGraph,
  ) {
    this.graph = graph;
  }

  /**
   * Open the baton for a project and load the settled epochs.
   *
   * The project key matches the event log's, so the baton and the log land on
   * the same `(:Project)` node.
   */
  static async open(projectDir: string, log: EventLog, graph?: ProjectGraph): Promise<BatonManager> {
    const g = graph ?? projectGraph(path.resolve(path.join(projectDir, ".loom")));
    await g.open();
    const b = new BatonManager(projectDir, log, g);
    await b.refresh("strong");
    return b;
  }

  // -------------------------------------------------------------------------
  // Reads — synchronous, off the last settled view
  // -------------------------------------------------------------------------

  holder(): string | null {
    return this.state.holder;
  }

  /** The current writer epoch. Every baton-authorized write must carry it. */
  epoch(): number {
    return this.state.epoch;
  }

  holderSince(): number | undefined {
    return this.state.since;
  }

  snapshot(): BatonState {
    return { ...this.state };
  }

  /** Throws NotHolderError unless agentId currently holds the baton. */
  assertHolder(agentId: string): void {
    if (this.state.holder !== agentId) throw new NotHolderError(agentId, this.state.holder);
  }

  // -------------------------------------------------------------------------
  // The election
  // -------------------------------------------------------------------------

  /**
   * Re-read the settled epochs from HydraDB.
   *
   * `strong` before an election (the answer decides who may write) and causal
   * for routine refreshes, where the node's own bookmark already guarantees
   * read-your-writes.
   */
  async refresh(consistency: Consistency = "causal"): Promise<BatonState> {
    this.state = settle(await this.allClaims(consistency));
    return this.state;
  }

  /**
   * Stand for election at the next epoch. Returns whether we won it.
   *
   * `agentId` of `null` means "release" — a claim to hold nothing, which is
   * still an epoch, so a release is ordered against concurrent acquisitions
   * exactly like an acquisition is.
   */
  private async elect(
    agentId: string | null,
    reason: string,
    /**
     * Who the caller believed held the baton when it decided to stand.
     *
     * `undefined` means unconditional (a handoff moves the baton whatever the
     * current state is). Anything else is checked *after* winning, because the
     * check and the claim cannot be made atomic — there is no conditional
     * write. Winning an election you were not entitled to is therefore
     * possible, and is undone rather than prevented: the baton is handed back
     * to whoever actually held it, and the caller is told it lost. Restoring
     * costs one more election, which is the honest price of a check-then-act
     * on a store with no compare-and-swap.
     */
    expectPrevHolder?: string | null,
    /** The caller's `strong` view, so the election does not re-read it. */
    known?: BatonState,
  ): Promise<{ won: boolean; state: BatonState }> {
    const before = known ?? (await this.refresh("strong"));
    const epoch = before.epoch + 1;
    const at = Date.now();
    const vid = claimVid(this.graph.slot);

    // Step 1 — append the claim. The bookmark this write commits at is our
    // position in the cell's total order, and it is the whole ballot.
    const w = await this.graph.client.query(
      "UNWIND $rows AS row MERGE (c {id: row.id}) SET c:" +
        LABEL.claim +
        ", c.epoch = row.epoch, c.agent = row.agent, c.at = row.at, c.reason = row.reason, " +
        "c.proj = row.proj, c.seq = row.seq",
      {
        rows: [
          {
            id: vid,
            epoch,
            agent: agentId ?? NOBODY,
            at,
            reason,
            proj: this.graph.slot,
            // Written again in step 2: the sequence this commits at is only
            // knowable after it has committed. Until then it is 0, and `settle()`
            // treats a 0 as a ballot still being cast rather than as the
            // lowest one ever drawn.
            seq: 0,
          },
        ],
      },
    );

    // Step 2 — stamp the committed sequence onto the claim so every other
    // participant can see the ballot we drew, and hang it off the project.
    //
    // The edge has to exist *before* the count: claims are found by traversing
    // `(:Project)-[:HAS_CLAIM]->`, so a ballot with no edge is a ballot nobody
    // can see — including us. Writing it afterwards made every election find an
    // empty ballot box and report that nobody holds the baton.
    await this.graph.client.query("MATCH (c:BatonClaim {id: $id}) SET c.seq = $seq", {
      id: vid,
      seq: w.seq,
    });
    await this.graph.client.relate(LABEL.project, REL.hasClaim, LABEL.claim, [
      { src: this.graph.vid, dst: vid, rid: relId(this.graph.vid, vid, REL.hasClaim) },
    ]);

    // Step 3 — count. Lowest sequence at this epoch wins, ties broken by
    // vertex id so the rule is total even in the impossible case.
    const after = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasClaim}]->(c:${LABEL.claim}) ` +
        "WHERE c.epoch = $epoch " +
        "RETURN c.id AS id, c.epoch AS epoch, c.agent AS agent, c.seq AS seq, c.at AS at, " +
        "c.reason AS reason ORDER BY seq, id",
      { pv: this.graph.vid, epoch },
      { consistency: "strong" },
    );
    const rows = after.rows as unknown as ClaimRow[];
    // A claim whose seq is still 0 has not finished step 2; treat it as
    // pending rather than as the lowest ballot in existence.
    const settled = rows.filter((r) => Number(r.seq) > 0);
    const winner = settled[0];
    const won = winner !== undefined && Number(winner.id) === vid;

    if (!won) {
      // We lost, so the head moved somewhere we have not seen. This is the one
      // path that has to re-read: the winner could be anyone.
      await this.refresh("strong");
      return { won: false, state: this.state };
    }

    // We won, and we already know everything needed to describe the result:
    // the winner is us, at `epoch`, and the tenure either continues (we held
    // the previous epoch too) or starts here. Re-reading the whole ledger to
    // learn what we just did would be a round trip spent on arithmetic.
    const holder = agentId === null ? null : agentId;
    this.state = {
      holder,
      epoch,
      since: holder === null ? undefined : at,
      seq: w.seq,
      reason,
      tenureEpoch: before.holder === holder && before.tenureEpoch > 0 ? before.tenureEpoch : epoch,
    };

    if (expectPrevHolder !== undefined && before.holder !== expectPrevHolder) {
      // We won an epoch we had no claim to — someone took the baton between
      // our read and our ballot. Put it back where it belongs and report the
      // loss to our caller.
      await this.refresh("strong");
      const prev = holderAtEpoch(await this.allClaims("strong"), epoch - 1);
      if (prev !== expectPrevHolder && prev !== agentId) {
        await this.elect(prev, "restore");
        return { won: false, state: this.state };
      }
    }

    await this.link(vid, agentId);
    this.mirrorToDisk();
    return { won: true, state: this.state };
  }

  /** Every claim for this project, newest last. */
  private async allClaims(consistency: Consistency = "causal"): Promise<ClaimRow[]> {
    // Through the project's own edges. Scoping by `c.proj` is a full scan of
    // every claim in the graph, and `refresh()` runs on every election.
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasClaim}]->(c:${LABEL.claim}) ` +
        "RETURN c.id AS id, c.epoch AS epoch, c.agent AS agent, c.seq AS seq, c.at AS at, " +
        "c.reason AS reason ORDER BY epoch, seq",
      { pv: this.graph.vid },
      { consistency },
    );
    return res.rows as unknown as ClaimRow[];
  }

  /** Edges for the claim we just won: who claimed it, and under this project. */
  /** Provenance edges for a won claim. The HAS_CLAIM edge is already written
   * (it has to be, for the count to see the ballot) — this is who claimed it. */
  private async link(vid: number, agentId: string | null): Promise<void> {
    const client = this.graph.client;
    if (!agentId) return;
    const av = await this.graph.agentVid(agentId);
    await client.upsertNodes(LABEL.agent, [{ id: av, aid: agentId, proj: this.graph.slot }], [
      "aid",
      "proj",
    ]);
    await client.relate(LABEL.claim, REL.claimedBy, LABEL.agent, [
      { src: vid, dst: av, rid: relId(vid, av, REL.claimedBy) },
    ]);
    await client.relate(LABEL.project, REL.hasAgent, LABEL.agent, [
      { src: this.graph.vid, dst: av, rid: relId(this.graph.vid, av, REL.hasAgent) },
    ]);
  }

  /**
   * `.loom/state.json` stays written, but it is now a *cache* for surfaces
   * that read it directly (`loom doctor`) rather than the truth. The graph is
   * the truth; this file can be deleted and the baton is unaffected.
   */
  private mirrorToDisk(): void {
    const s = readProjectState(this.projectDir);
    s.holder = this.state.holder;
    if (this.state.since === undefined) delete s.holderSince;
    else s.holderSince = this.state.since;
    writeProjectState(this.projectDir, s);
  }

  // -------------------------------------------------------------------------
  // Public mutations
  // -------------------------------------------------------------------------

  /** First acquisition (no current holder). Logged as a handoff from nobody. */
  async acquire(agentId: string): Promise<void> {
    const before = await this.refresh("strong");
    if (before.holder === agentId) return;
    if (before.holder && before.holder !== agentId) {
      throw new NotHolderError(agentId, before.holder);
    }
    const { won, state } = await this.elect(agentId, "acquire", null, before);
    if (!won) throw new NotHolderError(agentId, state.holder);
    this.log.append({ kind: "handoff", payload: { from: null, to: agentId, epoch: state.epoch } });
  }

  /**
   * Move the baton. Caller is responsible for interrupting the current
   * holder and injecting the projection — see ProjectRuntime.handoff().
   */
  async handoff(to: string, meta: Record<string, unknown> = {}): Promise<{ from: string | null }> {
    const before = await this.refresh("strong");
    const from = before.holder;
    if (from === to) return { from };
    const { won, state } = await this.elect(to, "handoff", undefined, before);
    if (!won) throw new NotHolderError(to, state.holder);
    this.log.append({
      kind: "handoff",
      payload: { from, to, epoch: state.epoch, ...meta },
    });
    return { from };
  }

  async release(agentId: string): Promise<void> {
    const before = await this.refresh("strong");
    if (before.holder !== agentId) return;
    const { state } = await this.elect(null, "release", undefined, before);
    this.log.append({
      kind: "handoff",
      payload: { from: agentId, to: null, epoch: state.epoch },
    });
  }

  /**
   * Clear a holder unconditionally — used when the persisted holder no
   * longer exists in the project config (agent removed/renamed).
   */
  async forceClear(reason = "holder removed"): Promise<void> {
    const before = await this.refresh("strong");
    const from = before.holder;
    if (!from) return;
    const { state } = await this.elect(null, reason, undefined, before);
    this.log.append({
      kind: "handoff",
      payload: { from, to: null, reason, epoch: state.epoch },
    });
  }

  // -------------------------------------------------------------------------
  // Fencing
  // -------------------------------------------------------------------------

  /**
   * Authorize a write. Throws — and records a `(:FencingViolation)` — when the
   * caller's epoch is behind, which is exactly the stale-writer case the old
   * mutex let through silently.
   */
  async assertWriter(agentId: string, epoch: number, op: string, detail = ""): Promise<void> {
    const s = await this.refresh("strong");
    if (s.holder === agentId && epoch >= s.tenureEpoch) return;
    await this.recordViolation(agentId, epoch, s, op, detail);
    throw new StaleEpochError(agentId, epoch, s.epoch, s.holder);
  }

  /** True if this agent may write right now, without throwing. */
  async canWrite(agentId: string, epoch: number): Promise<boolean> {
    const s = await this.refresh("strong");
    return s.holder === agentId && epoch >= s.tenureEpoch;
  }

  private async recordViolation(
    agentId: string,
    staleEpoch: number,
    current: BatonState,
    op: string,
    detail: string,
  ): Promise<void> {
    const at = Date.now();
    const vid = kindBase("fencing") + this.graph.slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
    const client = this.graph.client;
    await client.upsertNodes(
      LABEL.fencing,
      [
        {
          id: vid,
          at,
          agent: agentId,
          stale_epoch: staleEpoch,
          current_epoch: current.epoch,
          current_holder: current.holder ?? NOBODY,
          op,
          detail: detail.slice(0, 2000),
          proj: this.graph.slot,
        },
      ],
      ["at", "agent", "stale_epoch", "current_epoch", "current_holder", "op", "detail", "proj"],
    );
    const av = await this.graph.agentVid(agentId);
    await client.upsertNodes(LABEL.agent, [{ id: av, aid: agentId, proj: this.graph.slot }], [
      "aid",
      "proj",
    ]);
    await client.relate(LABEL.fencing, REL.by, LABEL.agent, [
      { src: vid, dst: av, rid: relId(vid, av, REL.by) },
    ]);
    await client.relate(LABEL.project, REL.hasFencing, LABEL.fencing, [
      { src: this.graph.vid, dst: vid, rid: relId(this.graph.vid, vid, REL.hasFencing) },
    ]);
    await client.relate(LABEL.project, REL.hasAgent, LABEL.agent, [
      { src: this.graph.vid, dst: av, rid: relId(this.graph.vid, av, REL.hasAgent) },
    ]);
    // Also an event, so the Timeline and Self-heal see it without a second
    // source of truth.
    this.log.append({
      kind: "status",
      agentId,
      payload: {
        state: "fencing_violation",
        staleEpoch,
        currentEpoch: current.epoch,
        currentHolder: current.holder,
        op,
        detail,
      },
    });
  }

  async violations(limit = 50): Promise<FencingViolation[]> {
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasFencing}]->(f:${LABEL.fencing}) ` +
        "RETURN f.id AS id, f.at AS at, f.agent AS agent, f.stale_epoch AS se, " +
        "f.current_epoch AS ce, f.current_holder AS ch, f.op AS op, f.detail AS detail " +
        "ORDER BY at DESC LIMIT $limit",
      { pv: this.graph.vid, limit },
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      agent: String(r.agent ?? ""),
      staleEpoch: Number(r.se),
      currentEpoch: Number(r.ce),
      currentHolder: String(r.ch ?? ""),
      op: String(r.op ?? ""),
      detail: String(r.detail ?? ""),
    }));
  }

  /** Every epoch this project has had, with everyone who stood for it. */
  async history(limit = 200): Promise<BatonEpochRow[]> {
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasClaim}]->(c:${LABEL.claim}) ` +
        "RETURN c.id AS id, c.epoch AS epoch, c.agent AS agent, c.seq AS seq, c.at AS at, " +
        "c.reason AS reason ORDER BY epoch DESC, seq LIMIT $limit",
      { pv: this.graph.vid, limit: limit * 4 },
    );
    const byEpoch = new Map<number, ClaimRow[]>();
    for (const row of res.rows as unknown as ClaimRow[]) {
      const e = Number(row.epoch);
      if (!byEpoch.has(e)) byEpoch.set(e, []);
      byEpoch.get(e)!.push(row);
    }
    const out: BatonEpochRow[] = [];
    for (const [epoch, claims] of [...byEpoch.entries()].sort((a, b) => b[0] - a[0])) {
      const settled = claims.filter((c) => Number(c.seq) > 0).sort(bySeqThenId);
      const winner = settled[0];
      if (!winner) continue;
      out.push({
        epoch,
        holder: String(winner.agent ?? "") || null,
        seq: Number(winner.seq),
        at: Number(winner.at),
        reason: String(winner.reason ?? ""),
        contenders: settled.map((c) => ({
          agent: String(c.agent ?? "") || null,
          seq: Number(c.seq),
        })),
      });
    }
    return out.slice(0, limit);
  }
}

interface ClaimRow {
  id: number;
  epoch: number;
  agent: string | null;
  seq: number;
  at: number;
  reason: string | null;
}

function bySeqThenId(a: ClaimRow, b: ClaimRow): number {
  const d = Number(a.seq) - Number(b.seq);
  return d !== 0 ? d : Number(a.id) - Number(b.id);
}

/**
 * Fold every claim into the current holder.
 *
 * Per epoch, lowest committed sequence wins. The current epoch is the highest
 * one that has a settled winner; a claim still mid-write (seq 0) is not one.
 */
function settle(rows: ClaimRow[]): BatonState {
  const byEpoch = new Map<number, ClaimRow[]>();
  for (const r of rows) {
    if (Number(r.seq) <= 0) continue;
    const e = Number(r.epoch);
    if (!byEpoch.has(e)) byEpoch.set(e, []);
    byEpoch.get(e)!.push(r);
  }
  if (byEpoch.size === 0) return { ...EMPTY };
  const top = Math.max(...byEpoch.keys());
  const winner = byEpoch.get(top)!.sort(bySeqThenId)[0]!;
  const agent = String(winner.agent ?? "");

  // Walk back while the holder is unchanged: that is the current tenure.
  let tenure = top;
  let since = Number(winner.at);
  for (let e = top - 1; e >= 1; e--) {
    const claims = byEpoch.get(e);
    if (!claims?.length) break;
    const w = claims.slice().sort(bySeqThenId)[0]!;
    if (String(w.agent ?? "") !== agent) break;
    tenure = e;
    since = Number(w.at);
  }

  return {
    holder: agent === NOBODY ? null : agent,
    epoch: top,
    since: agent === NOBODY ? undefined : since,
    seq: Number(winner.seq),
    reason: String(winner.reason ?? ""),
    tenureEpoch: tenure,
  };
}

/** The settled holder at one specific epoch, or null if nobody held it. */
function holderAtEpoch(rows: ClaimRow[], epoch: number): string | null {
  if (epoch < 1) return null;
  const claims = rows.filter((r) => Number(r.epoch) === epoch && Number(r.seq) > 0);
  if (!claims.length) return null;
  const agent = String(claims.sort(bySeqThenId)[0]!.agent ?? "");
  return agent === NOBODY ? null : agent;
}
