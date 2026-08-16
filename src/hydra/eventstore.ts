/**
 * The event log, on HydraDB.
 *
 * `EventStore` is synchronous — `append` returns the event, `list` returns an
 * array — and HydraDB is an HTTP hop away. Rather than turn 38 call sites
 * (most of them inside adapter stream callbacks that cannot await anything)
 * into async, the store keeps a hydrated mirror of the log in memory and
 * writes through to HydraDB on a strictly-ordered queue.
 *
 * The mirror is a *cache of HydraDB*, not a second source of truth:
 *
 *   - it is built by reading HydraDB at open, so a restart recovers the log
 *     from the graph and nothing else;
 *   - it is never consulted for anything HydraDB has not been asked to store;
 *   - `flush()` awaits durability, and the daemon calls it at every boundary
 *     that matters — end of turn, before a handoff, before answering an API
 *     read, on shutdown.
 *
 * Writes are coalesced into `UNWIND` batches, which is HydraDB's batched write
 * form and the difference between one round trip per streamed token and one
 * per burst. Ordering inside a batch is preserved because the rows carry their
 * own sequence numbers and the `NEXT` chain is written from those, not from
 * arrival order.
 *
 * Single-writer, by construction: one daemon owns a project, exactly as the
 * SQLite store assumed when it owned one file. Two daemons on one project
 * would both mint sequence N — which is why the *baton*, where contention is
 * real, does not work this way. See `core/baton.ts`.
 */

import type { EventKind, LoomEvent, NewEvent } from "../types.js";
import { MAIN_CHAT } from "../types.js";
import type { EventStore, ListOpts } from "../core/eventlog.js";
import { logbook } from "../core/logbook.js";
import type { ProjectGraph } from "./graph.js";
import { LABEL, REL, relId } from "./graph.js";
import { eventVid, kindBase } from "./ids.js";

/**
 * Chunk vertex ids, derived from the event sequence and piece index so a
 * retried write is idempotent. 256 pieces per event bounds a project at ~16.7M
 * events, which is well past what a log this shape will ever hold.
 */
function chunkVid(slot: number, seq: number, ord: number): number {
  return kindBase("chunk") + slot * 2 ** 32 + (seq * MAX_CHUNKS + ord);
}

/** Flush when the pending batch reaches this many rows… */
const BATCH_ROWS = 128;
/** …or this many bytes of payload, whichever comes first. */
const BATCH_BYTES = 384 * 1024;
/**
 * HydraDB rejects a single property value at 32 KiB — measured against a real
 * node, not read off a doc: 31 KiB commits, 32 KiB fails with an internal
 * execution error. The limit is per property rather than per request, so a
 * batch of many medium rows is fine and one large row is not.
 *
 * A turn diff routinely exceeds this. Truncating it would quietly amputate the
 * Changes view, so payloads over the limit are **split** across `(:EventChunk)`
 * nodes and reassembled on read. Nothing is lost up to `MAX_CHUNKS`.
 */
const CHUNK_BYTES = 24 * 1024;
/** 256 chunks ≈ 6 MB of payload. Past that it is clipped, and it says so. */
const MAX_CHUNKS = 256;

interface PendingRow {
  id: number;
  seq: number;
  ts: number;
  kind: string;
  agent: string;
  chat: string;
  /** Inline payload, or "" when it was too big and lives in chunks. */
  payload: string;
  /** How many `(:EventChunk)` nodes carry this payload. 0 = inline. */
  chunks: number;
  truncated: boolean;
  prev: number;
  /** The chunk bodies, written alongside the event. */
  parts: string[];
}

/**
 * Split a string into pieces no larger than `CHUNK_BYTES` **bytes**.
 *
 * Byte-counted, not character-counted: the limit HydraDB enforces is on the
 * encoded value, and one emoji in a diff is four bytes to one JS character. A
 * character-based split would pass locally and fail on the first payload with
 * anything non-ASCII in it.
 */
function chunkByBytes(s: string, limit: number): string[] {
  if (Buffer.byteLength(s, "utf8") <= limit) return [s];
  const out: string[] = [];
  let start = 0;
  while (start < s.length) {
    // Estimate, then walk back until the piece fits. UTF-8 is at most 4 bytes
    // per code unit pair, so the estimate is never far off.
    let end = Math.min(s.length, start + limit);
    while (end > start && Buffer.byteLength(s.slice(start, end), "utf8") > limit) {
      end -= Math.max(1, Math.ceil((Buffer.byteLength(s.slice(start, end), "utf8") - limit) / 4));
    }
    if (end <= start) end = start + 1; // never make no progress
    out.push(s.slice(start, end));
    start = end;
  }
  return out;
}

/**
 * The last write chain per project, so a reopen cannot outrun a close.
 *
 * `EventStore.close()` is synchronous and cannot await its own flush, which
 * left close-then-reopen racy: the new store hydrated from HydraDB while the
 * old one's final batch was still in flight, and the events in that batch
 * simply were not there. Callers that await `flush()` first were fine; callers
 * that did the obvious thing were not, which is the wrong way round.
 *
 * Making `open()` await the previous store's chain fixes it by construction
 * rather than by discipline — there is no correct-usage rule to remember.
 */
const inFlight = new Map<string, Promise<void>>();

export class HydraEventStore implements EventStore {
  private mirror: LoomEvent[] = [];
  private nextSeq = 1;
  private pending: PendingRow[] = [];
  private pendingBytes = 0;
  /** The write chain. Every flush appends to it, so batches land in order. */
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(private graph: ProjectGraph) {}

  /**
   * Open the log, recovering every event from HydraDB.
   *
   * Read `strong` — this is the one read where paying the object-store round
   * trip is unambiguously right. A daemon restarting on a causal view could
   * pin a snapshot that is missing its own last writes and then mint sequence
   * numbers that already exist.
   */
  static async open(graph: ProjectGraph): Promise<HydraEventStore> {
    await graph.open();
    // Let any previous store for this project finish writing before reading.
    await inFlight.get(graph.projectId)?.catch(() => {});
    const store = new HydraEventStore(graph);
    // Reached through the project's own edges, not by scanning every Event in
    // the graph for a matching `proj`. See the note in graph.ts: the scan is
    // ~200x slower and gets worse with every project anyone else adds.
    const res = await graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasEvent}]->(e:${LABEL.event}) ` +
        "RETURN e.seq AS seq, e.ts AS ts, e.kind AS kind, e.agent AS agent, " +
        "e.chat AS chat, e.payload AS payload, e.chunks AS chunks ORDER BY seq",
      { pv: graph.vid },
      { consistency: "strong" },
    );
    // Payloads that overflowed 32 KiB live in `(:EventChunk)` nodes; fetch and
    // reassemble them so the caller never learns that any of this happened.
    const chunked = res.rows
      .filter((r) => Number(r.chunks ?? 0) > 0)
      .map((r) => Number(r.seq));
    const reassembled = await store.readChunks(chunked);

    for (const row of res.rows) {
      const seq = Number(row.seq);
      if (!Number.isFinite(seq) || seq <= 0) continue;
      const raw = Number(row.chunks ?? 0) > 0 ? (reassembled.get(seq) ?? "") : row.payload;
      store.mirror.push({
        id: seq,
        ts: Number(row.ts) || 0,
        kind: String(row.kind) as EventKind,
        ...(row.agent ? { agentId: String(row.agent) } : {}),
        ...(row.chat ? { chat: String(row.chat) } : {}),
        payload: parsePayload(raw),
      });
    }
    store.nextSeq = (store.mirror[store.mirror.length - 1]?.id ?? 0) + 1;
    return store;
  }

  /** Reassemble chunked payloads, keyed by event sequence. */
  private async readChunks(seqs: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!seqs.length) return out;
    // `IN` is not in HydraDB's WHERE grammar, so this asks per event. Chunked
    // payloads are rare (a big diff, not a message), so the fan-out is small.
    for (const seq of seqs) {
      const res = await this.graph.client.query(
        `MATCH (e:${LABEL.event} {id: $ev})-[:${REL.chunk}]->(c:EventChunk) ` +
          "RETURN c.ord AS ord, c.data AS data ORDER BY ord",
        { ev: eventVid(this.graph.slot, seq) },
        { consistency: "strong" },
      );
      out.set(seq, res.rows.map((r) => String(r.data ?? "")).join(""));
    }
    return out;
  }

  append(
    e: Required<Omit<NewEvent, "agentId" | "chat">> & { agentId?: string; chat?: string },
  ): LoomEvent {
    if (this.closed) throw new Error("event log is closed");
    const seq = this.nextSeq++;
    const ev: LoomEvent = {
      id: seq,
      ts: e.ts,
      kind: e.kind,
      ...(e.agentId ? { agentId: e.agentId } : {}),
      ...(e.chat ? { chat: e.chat } : {}),
      payload: e.payload,
    };
    this.mirror.push(ev);

    const full = JSON.stringify(e.payload ?? {});
    let parts = chunkByBytes(full, CHUNK_BYTES);
    let truncated = false;
    if (parts.length > MAX_CHUNKS) {
      parts = parts.slice(0, MAX_CHUNKS);
      truncated = true;
    }
    const inline = parts.length === 1;
    this.pending.push({
      id: eventVid(this.graph.slot, seq),
      seq,
      ts: ev.ts,
      kind: ev.kind,
      agent: ev.agentId ?? "",
      chat: ev.chat ?? "",
      payload: inline ? parts[0]! : "",
      chunks: inline ? 0 : parts.length,
      truncated,
      prev: seq > 1 ? eventVid(this.graph.slot, seq - 1) : 0,
      parts: inline ? [] : parts,
    });
    this.pendingBytes += full.length;

    if (this.pending.length >= BATCH_ROWS || this.pendingBytes >= BATCH_BYTES) {
      void this.flush();
    } else if (!this.timer) {
      // A short debounce so a burst of streamed tokens becomes one batch,
      // without letting a lone event sit undurable indefinitely.
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 25);
      this.timer.unref?.();
    }
    return ev;
  }

  list(opts: ListOpts = {}): LoomEvent[] {
    let out = this.mirror;
    if (opts.since !== undefined) out = out.filter((e) => e.id > opts.since!);
    if (opts.kinds?.length) {
      const want = new Set(opts.kinds);
      out = out.filter((e) => want.has(e.kind));
    }
    if (opts.chat !== undefined) {
      out = out.filter((e) =>
        opts.chat === MAIN_CHAT ? (e.chat ?? MAIN_CHAT) === MAIN_CHAT : e.chat === opts.chat,
      );
    }
    if (opts.limit && out.length > opts.limit) out = out.slice(-opts.limit);
    return out === this.mirror ? [...out] : out;
  }

  lastId(): number {
    return this.mirror[this.mirror.length - 1]?.id ?? 0;
  }

  /** Await durability of everything appended so far. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    if (batch.length) {
      this.pending = [];
      this.pendingBytes = 0;
      this.chain = this.chain.then(() => this.writeBatch(batch));
      inFlight.set(this.graph.projectId, this.chain.catch(() => {}));
    }
    return this.chain;
  }

  private async writeBatch(rows: PendingRow[]): Promise<void> {
    const client = this.graph.client;
    try {
      // Every SET value in a batch has to come out of the row map — HydraDB
      // rejects a scalar parameter here — so the project slot rides along on
      // each row rather than being passed once.
      await client.query(
        "UNWIND $rows AS row MERGE (e {id: row.id}) SET e:" +
          LABEL.event +
          ", e.seq = row.seq, e.ts = row.ts, e.kind = row.kind, e.agent = row.agent, " +
          "e.chat = row.chat, e.payload = row.payload, e.truncated = row.truncated, " +
          "e.chunks = row.chunks, e.proj = row.proj",
        {
          // `parts` is carried on the pending row for the chunk write below; it
          // must not go into the event row, where it would be a list-valued
          // property HydraDB has nowhere to put.
          rows: rows.map(({ parts: _parts, ...r }) => ({ ...r, proj: this.graph.slot })),
        },
      );
      await this.writeChunks(rows);
      // The project edge makes "every event in this project" a traversal
      // rather than a property scan.
      await client.relate(
        LABEL.project,
        REL.hasEvent,
        LABEL.event,
        rows.map((r) => ({
          src: this.graph.vid,
          dst: r.id,
          rid: relId(this.graph.vid, r.id, REL.hasEvent),
        })),
      );
      // The NEXT chain is the log's order made explicit, so replay never has
      // to trust a clock. Rows whose predecessor is in an earlier batch still
      // link correctly because `prev` is computed from the sequence number.
      const links = rows.filter((r) => r.prev > 0);
      await client.relate(
        LABEL.event,
        REL.next,
        LABEL.event,
        links.map((r) => ({
          src: r.prev,
          dst: r.id,
          rid: relId(r.prev, r.id, REL.next),
          ord: r.seq,
        })),
        ["ord"],
      );
    } catch (err) {
      // Put the rows back so the next flush retries them. Dropping them would
      // leave the mirror claiming events the graph has never heard of, which
      // is precisely the drift this store exists to prevent.
      this.pending = [...rows, ...this.pending];
      this.pendingBytes += rows.reduce((n, r) => n + r.payload.length, 0);
      logbook.warn(
        "hydra",
        `could not persist ${rows.length} event(s) — they stay queued for the next flush`,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
  }

  /**
   * Write the overflow pieces of any payload too big for one property.
   *
   * One request per event rather than one big batch: 256 chunks of 24 KiB is
   * 6 MB, well past the 1 MB HTTP body cap, so the pieces are sent in
   * body-sized groups. Chunk ids are derived from the event sequence and the
   * piece index, which keeps a retry idempotent — the same chunk lands on the
   * same node instead of duplicating.
   */
  private async writeChunks(rows: PendingRow[]): Promise<void> {
    const withParts = rows.filter((r) => r.parts.length > 0);
    if (!withParts.length) return;
    const client = this.graph.client;
    for (const row of withParts) {
      const chunkRows = row.parts.map((data, ord) => ({
        id: chunkVid(this.graph.slot, row.seq, ord),
        ord,
        ev_seq: row.seq,
        data,
        proj: this.graph.slot,
      }));
      // ~24 KiB each, so 24 rows is comfortably inside the 1 MB body budget.
      for (let i = 0; i < chunkRows.length; i += 24) {
        const group = chunkRows.slice(i, i + 24);
        await client.query(
          "UNWIND $rows AS row MERGE (c {id: row.id}) SET c:EventChunk, c.ord = row.ord, " +
            "c.ev_seq = row.ev_seq, c.data = row.data, c.proj = row.proj",
          { rows: group },
        );
        await client.relate(
          LABEL.event,
          REL.chunk,
          "EventChunk",
          group.map((c) => ({ src: row.id, dst: c.id, rid: relId(row.id, c.id, REL.chunk) })),
        );
      }
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Best effort: the caller that wants a guarantee awaits flush() first.
    void this.flush().catch(() => {});
  }

  /** How many events are queued but not yet durable. Surfaced by `loom doctor`. */
  get pendingCount(): number {
    return this.pending.length;
  }
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
