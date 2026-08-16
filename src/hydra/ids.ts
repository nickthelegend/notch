/**
 * String keys → HydraDB vertex ids.
 *
 * HydraDB vertex ids are non-negative integers, and `id` is the identity a
 * pattern matches on — it cannot be changed or removed. Notch's ids are
 * strings: `claude-code`, a 16-hex memory id, a project path. So there has to
 * be a mapping, it has to be stable across restarts, and it has to be
 * collision-free rather than collision-*unlikely*, because a silent collision
 * would fuse two unrelated nodes and there would be no error to find later.
 *
 * The layout partitions a 53-bit safe-integer space by entity kind:
 *
 *     vid = KIND * 2^44 + slot
 *
 * Events get the one sub-layout that isn't hashed, because their ids are load
 * bearing: `list({since})` and `lastId()` are ordering operations, so an event
 * id has to be dense and monotonic per project.
 *
 *     eventVid = EVENT * 2^44 + projectSlot * 2^32 + seq
 *
 * Everything else is hashed into its kind's range and linear-probed on
 * collision, with the resolved mapping written to the graph as `(:IdMap)` so
 * every process and every restart lands on the same integer.
 */

import crypto from "node:crypto";
import type { HydraClient } from "./client.js";

export const KIND = {
  idmap: 1,
  project: 2,
  event: 3,
  agent: 4,
  memory: 5,
  handoff: 6,
  claim: 7,
  fencing: 8,
  chat: 9,
  entity: 10,
  turn: 12,
  alert: 13,
  worktree: 14,
  chunk: 15,
  council: 16,
  answer: 17,
  action: 18,
} as const;

export type IdKind = keyof typeof KIND;

const KIND_SPAN = 2 ** 44;
const EVENT_PROJECT_SPAN = 2 ** 32;
/** 4096 projects per graph; each gets 4.29e9 event ids. */
export const MAX_PROJECT_SLOTS = KIND_SPAN / EVENT_PROJECT_SPAN;

export function kindBase(kind: IdKind): number {
  return KIND[kind] * KIND_SPAN;
}

/** Which kind's range does this vertex id fall in? Used when decoding paths. */
export function kindOf(vid: number): IdKind | null {
  const k = Math.floor(vid / KIND_SPAN);
  for (const [name, val] of Object.entries(KIND)) {
    if (val === k) return name as IdKind;
  }
  return null;
}

/** 44 bits of md5. Not a security boundary — just a spread. */
function hash44(s: string): number {
  const d = crypto.createHash("md5").update(s).digest();
  // 6 bytes = 48 bits, masked down to 44.
  const hi = d.readUInt32BE(0);
  const lo = d.readUInt16BE(4);
  return ((hi % 2 ** 28) * 2 ** 16 + lo) % KIND_SPAN;
}

export function eventVid(projectSlot: number, seq: number): number {
  return kindBase("event") + projectSlot * EVENT_PROJECT_SPAN + seq;
}

export function eventSeq(vid: number): number {
  return (vid - kindBase("event")) % EVENT_PROJECT_SPAN;
}

/**
 * The resolved key→id table, backed by `(:IdMap)` nodes in the graph.
 *
 * Held per HydraClient rather than globally so a test pointing at its own
 * graph cannot inherit another graph's assignments.
 */
export class IdAllocator {
  private cache = new Map<string, number>();
  private hydrated = false;

  constructor(private client: HydraClient) {}

  /**
   * Pull this project's rows into memory once, so every later `vid()` is a Map
   * lookup rather than a round trip.
   *
   * Scoped, and that is not an optimisation — it is the same rule the rest of
   * this layer follows. `(:IdMap)` is **global**: one row per agent, memory,
   * handoff and entity of every project that has ever opened this graph. An
   * unscoped `MATCH (m:IdMap)` is therefore a full scan whose cost is set by
   * the busiest node, not by the project doing the opening. Measured on a
   * development node with 1671 projects on it: **2.0s** for the whole table,
   * against a few ms for one project's slice — paid on every `open()`, by every
   * project, forever.
   *
   * Entities are deliberately still global. They are the basis of cross-run
   * recall — a constraint about `src/core/baton.ts` is about the same file in
   * the next run — and they are the one kind that is *supposed* to be shared.
   * They are also by far the smallest: 104 rows against 1671 projects on that
   * same node.
   *
   * `project:` is left to resolve lazily. It is one row, and the caller is
   * about to ask for exactly it.
   */
  async hydrate(projectId?: string): Promise<void> {
    if (this.hydrated) return;
    if (projectId) {
      // Project-scoped kinds all key as `<kind>:<projectId> <rest>`; see
      // ProjectGraph#agentVid and friends.
      const prefixes = ["entity:", ...["agent", "memory", "handoff"].map((k) => `${k}:${projectId} `)];
      for (const p of prefixes) {
        const res = await this.client.query(
          "MATCH (m:IdMap) WHERE m.k STARTS WITH $p RETURN m.id AS id, m.k AS k ORDER BY id",
          { p },
        );
        for (const row of res.rows) {
          const k = row.k as string | null;
          if (typeof k === "string") this.cache.set(k, Number(row.id));
        }
      }
      this.hydrated = true;
      return;
    }
    const res = await this.client.query(
      "MATCH (m:IdMap) RETURN m.id AS id, m.k AS k ORDER BY id",
    );
    for (const row of res.rows) {
      const k = row.k as string | null;
      if (typeof k === "string") this.cache.set(k, Number(row.id));
    }
    this.hydrated = true;
  }

  /** Forget the in-memory table (not the durable one). */
  reset(): void {
    this.cache.clear();
    this.hydrated = false;
  }

  private cacheKey(kind: IdKind, key: string): string {
    return `${kind}:${key}`;
  }

  /** The id for this key if it has already been resolved in this process. */
  peek(kind: IdKind, key: string): number | undefined {
    return this.cache.get(this.cacheKey(kind, key));
  }

  /**
   * Resolve a key to its vertex id, minting one if this is the first sighting.
   *
   * The probe loop is the collision handling: a 44-bit hash makes a clash
   * vanishingly unlikely, but "unlikely" is not "impossible", and the failure
   * mode is two different things sharing a node. After claiming, the claim is
   * read back — if someone else won that slot in between, the probe continues.
   * That read-back is what makes this safe under two daemons at once rather
   * than merely safe under one.
   */
  async vid(kind: IdKind, key: string): Promise<number> {
    const ck = this.cacheKey(kind, key);
    const hit = this.cache.get(ck);
    if (hit !== undefined) return hit;
    await this.hydrate();
    const again = this.cache.get(ck);
    if (again !== undefined) return again;

    const base = kindBase(kind);
    const start = hash44(ck);
    for (let probe = 0; probe < 64; probe++) {
      const candidate = base + ((start + probe) % KIND_SPAN);
      const existing = await this.client.query(
        "MATCH (m:IdMap {id: $id}) RETURN m.k AS k",
        { id: candidate },
      );
      const owner = existing.rows[0]?.k as string | undefined;
      if (owner === ck) {
        this.cache.set(ck, candidate);
        return candidate;
      }
      if (owner !== undefined && owner !== null) continue; // taken by another key

      await this.client.upsertNodes("IdMap", [{ id: candidate, k: ck, kind }], ["k", "kind"]);
      // Confirm we own it. A concurrent minter for a *different* key that
      // hashed here could have landed between the read and the write.
      const confirm = await this.client.query(
        "MATCH (m:IdMap {id: $id}) RETURN m.k AS k",
        { id: candidate },
        { consistency: "strong" },
      );
      if ((confirm.rows[0]?.k as string | undefined) === ck) {
        this.cache.set(ck, candidate);
        return candidate;
      }
    }
    throw new Error(`could not allocate a vertex id for ${ck} after 64 probes`);
  }

  /**
   * A project's 12-bit slot in the event id space. Same probe-and-confirm
   * discipline, but the range is small enough that exhausting it is a real
   * outcome rather than a theoretical one, so it says so plainly.
   */
  async projectSlot(projectId: string): Promise<number> {
    const ck = `slot:${projectId}`;
    const base = kindBase("idmap");
    // The cache stores marker *vertex ids* uniformly, because that is what
    // `hydrate()` reads back out of the graph. The slot is the offset within
    // the idmap range, so it is derived here rather than stored — caching the
    // slot itself would make a hydrated entry and a freshly-minted one mean
    // two different numbers under the same key.
    const hit = this.cache.get(ck);
    if (hit !== undefined) return hit - base;
    await this.hydrate();
    const again = this.cache.get(ck);
    if (again !== undefined) return again - base;

    const start = hash44(ck) % MAX_PROJECT_SLOTS;
    for (let probe = 0; probe < MAX_PROJECT_SLOTS; probe++) {
      const slot = (start + probe) % MAX_PROJECT_SLOTS;
      const marker = base + slot;
      const existing = await this.client.query(
        "MATCH (m:IdMap {id: $id}) RETURN m.k AS k",
        { id: marker },
      );
      const owner = existing.rows[0]?.k as string | undefined;
      if (owner === ck) {
        this.cache.set(ck, marker);
        return slot;
      }
      if (owner !== undefined && owner !== null) continue;

      await this.client.upsertNodes(
        "IdMap",
        [{ id: marker, k: ck, kind: "projectSlot" }],
        ["k", "kind"],
      );
      const confirm = await this.client.query(
        "MATCH (m:IdMap {id: $id}) RETURN m.k AS k",
        { id: marker },
        { consistency: "strong" },
      );
      if ((confirm.rows[0]?.k as string | undefined) === ck) {
        this.cache.set(ck, marker);
        return slot;
      }
    }
    throw new Error(
      `all ${MAX_PROJECT_SLOTS} project slots are taken — this graph cannot hold another project`,
    );
  }
}
