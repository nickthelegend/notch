/**
 * The HydraDB wire.
 *
 * HydraDB speaks two protocols — Bolt 5.x for Neo4j drivers, and a typed JSON
 * HTTP API. This talks HTTP, deliberately: the JSON API returns the two things
 * this project is actually built on, and the Bolt driver hides both.
 *
 *   - `bookmark` — the cell's storage sequence at which a write committed.
 *     Writes for a cell serialise through exactly one writer, so those
 *     sequences form a total order. `core/baton.ts` elects the baton holder
 *     out of that order; it is the closest thing to a consensus primitive
 *     HydraDB exposes to a client, and it is real rather than advisory.
 *   - `consistency` — `causal` (the node's current durable reader view) or
 *     `strong` (refresh from object storage first, then pin). Notch spends
 *     the remote round trip only where the answer has to be verified: baton
 *     elections and the Observatory's audit mode. Everything else reads causal.
 *
 * One statement per request, always. That is HydraDB's rule, not ours.
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { logbook } from "../core/logbook.js";

export type Consistency = "causal" | "strong";

/** A decoded cell out of a HydraDB result row. */
export type HydraValue =
  | number
  | string
  | boolean
  | null
  | HydraValue[]
  | HydraPath
  | { [k: string]: HydraValue };

export interface HydraNode {
  id: number;
  labels: string[];
  properties: Record<string, HydraValue>;
}

export interface HydraRel {
  id: number;
  edge_type: string;
  src: number;
  dst: number;
  properties: Record<string, HydraValue>;
}

export interface HydraPath {
  nodes: HydraNode[];
  relationships: HydraRel[];
}

export interface QueryResult {
  columns: string[];
  /** Rows as objects keyed by the projected column name. */
  rows: Record<string, HydraValue>[];
  /** Storage sequence this write committed at / this read was pinned at. */
  seq: number;
  bookmark: string | null;
  readEpoch: number | null;
}

export interface HydraConfig {
  url: string;
  token: string;
  graph: string;
  namespace: string;
  cell: string;
  timeoutMs: number;
}

export class HydraError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly query: string,
  ) {
    super(message);
    this.name = "HydraError";
  }
}

export function hydraConfigFromEnv(): HydraConfig {
  return {
    url: process.env.HYDRA_URL ?? "http://127.0.0.1:8443",
    token: process.env.HYDRA_TOKEN ?? "local-development-token-32-bytes",
    graph: process.env.HYDRA_GRAPH ?? "default",
    namespace: process.env.HYDRA_NAMESPACE ?? "default",
    cell: process.env.HYDRA_CELL ?? "cell-0",
    timeoutMs: Number(process.env.HYDRA_TIMEOUT_MS ?? 30_000),
  };
}

/**
 * The bookmark is `sgk:<v>:<hex ns>:<hex graph>:<hex cell>:<seq>`. The last
 * field is the cell's storage sequence, and it is the only part anything here
 * reads. Parsing a wire format by hand is usually a smell; this one is
 * documented, stable, and the sequence is not exposed any other way.
 */
export function seqFromBookmark(bookmark: string | null | undefined): number {
  if (!bookmark) return 0;
  const tail = String(bookmark).split(":").pop();
  const n = Number(tail);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A single-quoted Cypher string literal.
 *
 * Needed in exactly one place and only because of a real limitation: HydraDB
 * accepts a list-valued parameter *only* as `UNWIND` input, so the
 * `sourceValues` of a path procedure cannot be `$names` — it has to be spelled
 * into the query. Everything else in this codebase uses parameters.
 *
 * Entity names reach here from agent prose and file paths, so this is a
 * genuine injection boundary rather than a formality: backslash first (or it
 * would re-escape the quotes we just added), then the quote, then control
 * characters dropped — they cannot occur in an entity name and have no business
 * near a parser. Length is capped because a pathological name should not be
 * able to blow the 1MB request body on its own.
 */
export function cypherString(raw: string): string {
  const cleaned = raw
    .slice(0, 512)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
  return `'${cleaned}'`;
}

/** Unwrap HydraDB's `{type, value}` envelope into a plain JS value. */
function decode(cell: unknown): HydraValue {
  if (cell === null || cell === undefined) return null;
  if (typeof cell !== "object") return cell as HydraValue;
  const c = cell as { type?: string; value?: unknown };
  if (typeof c.type !== "string") return c as HydraValue;
  switch (c.type) {
    case "list":
      return (c.value as unknown[]).map(decode);
    case "path":
      return decodePath(c.value);
    case "null":
      return null;
    default:
      // vertex_id, integer, float, string, boolean — all carry a scalar.
      return (c.value ?? null) as HydraValue;
  }
}

/**
 * Path nodes and relationships carry properties in Rust's serde-tagged form
 * (`{"String": "x"}` / `{"Integer": 1}`) rather than the `{type, value}` used
 * by ordinary columns. Two encodings for the same idea, so both are handled.
 */
function decodePath(value: unknown): HydraPath {
  const v = (value ?? {}) as { nodes?: unknown[]; relationships?: unknown[] };
  return {
    nodes: (v.nodes ?? []).map((n) => {
      const node = n as { id: number; labels?: string[]; properties?: Record<string, unknown> };
      return {
        id: Number(node.id),
        labels: node.labels ?? [],
        properties: decodeTaggedProps(node.properties),
      };
    }),
    relationships: (v.relationships ?? []).map((r) => {
      const rel = r as {
        id: number;
        edge_type: string;
        src: number;
        dst: number;
        properties?: Record<string, unknown>;
      };
      return {
        id: Number(rel.id),
        edge_type: rel.edge_type,
        src: Number(rel.src),
        dst: Number(rel.dst),
        properties: decodeTaggedProps(rel.properties),
      };
    }),
  };
}

function decodeTaggedProps(props: Record<string, unknown> | undefined): Record<string, HydraValue> {
  const out: Record<string, HydraValue> = {};
  for (const [k, raw] of Object.entries(props ?? {})) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const entries = Object.entries(raw as Record<string, unknown>);
      // {"String": "x"} — a single-key wrapper whose key names the type.
      if (entries.length === 1 && /^[A-Z]/.test(entries[0]![0])) {
        out[k] = entries[0]![1] as HydraValue;
        continue;
      }
    }
    out[k] = raw as HydraValue;
  }
  return out;
}

/**
 * The heartbeat row's vertex id — the top of the idmap band, which nothing else
 * allocates. Kept here rather than imported so the client has no dependency on
 * the id allocator.
 */
const HEARTBEAT_VID = 1 * 2 ** 44 + 4095;

export interface QueryOpts {
  consistency?: Consistency;
  /** Read-your-writes without paying for `strong`. */
  bookmark?: string | null;
  timeoutMs?: number;
  /** Attempts on a transient failure. Default 4. */
  retries?: number;
  /**
   * Pin the request id instead of minting one.
   *
   * Normally every call draws its own `query_id` so a retry is a replay and a
   * new write is a new write. Supplying one deliberately re-enters HydraDB's
   * deduplication: send the same id with the same payload and the second
   * request is recognised as the first, not applied twice. That is a real
   * durability property of the engine and the only way to *show* it is to
   * reuse an id on purpose — see the idempotency drill.
   */
  queryId?: string;
}

/**
 * Failures HydraDB expects a client to retry rather than surface.
 *
 * Its own source says so: *"`contention`, `routing`, and occasional `fencing`
 * are expected, not alarming"*. A client that treats them as errors is a client
 * that falls over the moment more than one writer shows up — which, for a tool
 * whose entire purpose is running a fleet of agents at once, is every
 * interesting moment. Retrying is not papering over a fault here; not retrying
 * is misreading the contract.
 *
 * Safe for writes because every request carries our own `query_id`, and HydraDB
 * deduplicates on it: a retried write is recognised as the same write rather
 * than applied twice.
 */
const RETRYABLE_CODES = new Set([
  "resource_exhausted", // 429 — admission control
  "routing_unavailable", // 503 — this node cannot serve right now
  "not_cell_writer", // 421 — writer moved
  "query_timeout", // 408
  "unreachable", // the socket, not the server
]);

const RETRYABLE_STATUS = new Set([408, 421, 429, 502, 503, 504]);

function isRetryable(err: unknown): boolean {
  if (!(err instanceof HydraError)) return false;
  if (RETRYABLE_CODES.has(err.code) || RETRYABLE_STATUS.has(err.status)) return true;
  // Contention surfaces as a 500 whose message names it; the class is not
  // carried in `code`, so the message is the only signal available.
  return /contention|conflict|writer|lease|epoch fenc/i.test(err.message);
}

export class HydraClient {
  /** Set by every query so `observedHealth()` never needs a round trip. */
  private lastOkAt = 0;
  private lastErrorAt = 0;
  private lastAttemptAt = 0;
  private lastErrorDetail = "";

  readonly cfg: HydraConfig;
  /** Last write's bookmark; sent with causal reads so they see our own writes. */
  private lastBookmark: string | null = null;
  private queries = 0;
  private retried = 0;
  /**
   * Our own keep-alive agent, rather than whatever `fetch` keeps globally.
   *
   * This is not a micro-optimisation, it fixes a wedge. `fetch` pools sockets
   * in a global dispatcher that Node does not expose, so when the database
   * container is destroyed and recreated on the same port, every subsequent
   * request hangs on a dead socket until its timeout — forever, with no
   * recovery, because nothing ever retires the pool. Observed: the node was
   * back and answering curl instantly while the daemon timed out for minutes.
   *
   * Owning the agent means a connection-level failure can retire it, and the
   * next request dials a fresh socket.
   */
  private agent: http.Agent | https.Agent | null = null;

  constructor(cfg: Partial<HydraConfig> = {}) {
    this.cfg = { ...hydraConfigFromEnv(), ...cfg };
  }

  get bookmark(): string | null {
    return this.lastBookmark;
  }

  get queryCount(): number {
    return this.queries;
  }

  /** Transient failures ridden out. Surfaced by `loom graph` as a health signal. */
  get retryCount(): number {
    return this.retried;
  }

  private get secure(): boolean {
    return this.cfg.url.startsWith("https:");
  }

  private getAgent(): http.Agent | https.Agent {
    if (!this.agent) {
      const Ctor = this.secure ? https.Agent : http.Agent;
      this.agent = new Ctor({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 10_000 });
    }
    return this.agent;
  }

  /** Drop every pooled socket. Called when a connection fails, not on an HTTP error. */
  private retireAgent(): void {
    this.agent?.destroy();
    this.agent = null;
  }

  /**
   * One request, on our own agent.
   *
   * Returns the status and body rather than a Response so the caller does not
   * have to care that this is not `fetch` any more.
   */
  private send(payload: string, timeoutMs: number): Promise<{ status: number; body: string }> {
    const url = new URL(`${this.cfg.url}/v1/graphs/${this.cfg.graph}/query`);
    const mod = this.secure ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method: "POST",
          agent: this.getAgent(),
          headers: {
            Authorization: `Bearer ${this.cfg.token}`,
            "X-Graph-Namespace": this.cfg.namespace,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
          );
          r.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`timed out after ${timeoutMs}ms`));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  /**
   * Is a node actually there, answering, **and writable**?
   *
   * A read-only probe is not enough, and the failure it misses is a real one:
   * HydraDB's `local` object-store backend cannot perform conditional writes
   * (`put_opts` with `PutMode::Update`), which its writer lease needs. A node
   * restarted on an existing local store therefore serves reads happily and
   * fails every write with `internal query execution error` — a message that
   * says nothing about the cause. A read-only ping calls that node healthy and
   * sends you looking at your own queries.
   *
   * So the probe writes. The heartbeat row is upserted rather than appended, so
   * this costs one row forever rather than one per check.
   */
  /**
   * What the last real query did, without running another one.
   *
   * The daemon can be perfectly healthy while the graph underneath it is gone —
   * that happened here: the node process exited, the WebSocket stayed open, the
   * status bar kept saying "live", and the first anyone knew was a CLI command
   * failing minutes later. A pill needs an answer on every poll, and a poll that
   * costs a round trip to the thing that might be down is the wrong shape. So
   * this reports what the traffic already flowing through the client observed.
   *
   * `null` means nothing has been attempted yet — which is not the same as
   * healthy, and is rendered differently.
   */
  observedHealth(): { reachable: boolean | null; since: number; detail: string } {
    if (!this.lastAttemptAt) return { reachable: null, since: 0, detail: "no query yet" };
    return {
      reachable: this.lastErrorAt <= this.lastOkAt,
      since: Math.max(this.lastOkAt, this.lastErrorAt),
      detail: this.lastErrorAt > this.lastOkAt ? this.lastErrorDetail : "answering",
    };
  }

  async ping(): Promise<{ ok: boolean; detail: string; writable: boolean }> {
    let seq = 0;
    try {
      const r = await this.query("MATCH (n:HydraHeartbeat) RETURN count(*) AS n", {}, {
        timeoutMs: 5_000,
        retries: 1,
      });
      seq = r.seq;
    } catch (err) {
      return {
        ok: false,
        writable: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    try {
      // Bounded like the read above. A diagnostic that inherits the normal
      // 30s-times-four write budget answers "is the node up?" in two minutes,
      // which is not an answer.
      await this.query(
        "UNWIND $rows AS row MERGE (n {id: row.id}) SET n:HydraHeartbeat, n.at = row.at",
        { rows: [{ id: HEARTBEAT_VID, at: Date.now() }] },
        { timeoutMs: 5_000, retries: 1 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        writable: false,
        detail:
          `reads work but writes fail (${msg}). If this node uses CLOUD_PROVIDER=local and was ` +
          `restarted on an existing store, that is expected: LocalFileSystem does not implement ` +
          `conditional writes, so the writer lease cannot be renewed. Use an S3-compatible ` +
          `backend for a store meant to outlive the process, or start from a fresh one.`,
      };
    }
    return {
      ok: true,
      writable: true,
      detail: `graph=${this.cfg.graph} cell=${this.cfg.cell} seq=${seq}`,
    };
  }

  /**
   * Run one statement and return **every** row.
   *
   * HydraDB pages results and hands back a `next_cursor`; a client that reads
   * only the first page gets a silently truncated answer. That is not a
   * theoretical concern here — it cost this port a real bug: a project with
   * 3,000 events recovered 1,024 of them on restart and reported success,
   * because the recovery query stopped at the first page. Nothing errored and
   * nothing looked wrong; the history was simply shorter.
   *
   * So pagination is followed to exhaustion. The snapshot does not need pinning
   * by hand: HydraDB holds the cursor's rows in bounded, expiring server state,
   * so page two is drawn from the same pinned snapshot as page one rather than
   * from a newer one. (`read_epoch` looks like the knob for this and is not —
   * the server rejects it outright: *"read_epoch is not a storage snapshot
   * selector; use bookmark for causal reads"*.)
   */
  async query(
    cypher: string,
    parameters: Record<string, unknown> = {},
    opts: QueryOpts = {},
  ): Promise<QueryResult> {
    // Our own id, not the server's.
    //
    // HydraDB deduplicates relationship-import requests by `query_id`, and when
    // a client does not supply one the server assigns `http-query-<n>` from a
    // counter that restarts with the process — while the idempotency records
    // live in the durable store and do not. After a node restart the counter
    // walks back over ids that already recorded a *different* payload, and
    // every batched write fails with "idempotency key conflict … this key
    // already stored a result for a different payload". Observed on a real
    // node, and it takes the whole daemon down with it.
    //
    // A unique id per call sidesteps that and makes the idempotency work for
    // us instead: a retried batch carries the same id only when it is genuinely
    // the same request (pagination), so a replay is a replay and a new write is
    // a new write.
    const id = opts.queryId ?? `notch-${crypto.randomUUID()}`;
    const first = await this.withRetry(
      () => this.page(cypher, parameters, opts, undefined, id),
      opts,
      cypher,
    );
    if (first.nextCursor === null || first.nextCursor === undefined) return first.result;

    const rows = [...first.result.rows];
    let cursor: number | null | undefined = first.nextCursor;
    let last = first.result;
    // The cursor belongs to the *request*, not just the query text: a follow-up
    // page that omits the originating `query_id` is refused with "result cursor
    // does not belong to this query request".
    const queryId = id;
    // A generous bound rather than `while (true)`: a server that kept handing
    // back a cursor would otherwise hang the daemon rather than fail it.
    for (let page = 0; page < 10_000 && cursor !== null && cursor !== undefined; page++) {
      const at: number = cursor;
      const next = await this.withRetry(
        () => this.page(cypher, parameters, opts, at, queryId),
        opts,
        cypher,
      );
      rows.push(...next.result.rows);
      cursor = next.nextCursor;
      last = next.result;
    }
    if (cursor !== null && cursor !== undefined) {
      throw new HydraError(
        `query returned more than 10,000 pages — refusing to keep reading`,
        "too_many_pages",
        0,
        cypher,
      );
    }
    return { ...last, rows, columns: first.result.columns };
  }

  /**
   * Run `fn`, retrying the failures HydraDB documents as expected.
   *
   * Exponential with jitter: without the jitter a fleet of agents that all hit
   * contention at once would all come back at once, which is the same
   * contention one beat later.
   */
  private async withRetry<T>(fn: () => Promise<T>, opts: QueryOpts, cypher: string): Promise<T> {
    const attempts = Math.max(1, opts.retries ?? 4);
    let lastErr: unknown;
    // Every query in the process funnels through here, so this is the one place
    // that sees whether the node is answering — see `observedHealth()`.
    this.lastAttemptAt = Date.now();
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const out = await fn();
        this.lastOkAt = Date.now();
        return out;
      } catch (err) {
        lastErr = err;
        if (!isRetryable(err) || attempt === attempts - 1) {
          this.lastErrorAt = Date.now();
          this.lastErrorDetail = err instanceof Error ? err.message.slice(0, 200) : String(err);
          throw err;
        }
        const backoff = Math.min(2_000, 40 * 2 ** attempt) * (0.5 + Math.random());
        this.retried++;
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    this.lastErrorAt = Date.now();
    this.lastErrorDetail = lastErr instanceof Error ? lastErr.message.slice(0, 200) : String(lastErr);
    throw lastErr;
  }

  private async page(
    cypher: string,
    parameters: Record<string, unknown>,
    opts: QueryOpts,
    cursor?: number,
    queryId?: string,
  ): Promise<{ result: QueryResult; nextCursor: number | null | undefined; queryId: string }> {
    const body: Record<string, unknown> = {
      cell_id: this.cfg.cell,
      query: cypher,
      parameters,
      consistency: opts.consistency ?? "causal",
      // Bigger pages than the 256 default: these reads are whole-log
      // rehydrations, and the round trips dominate.
      page_size: 4096,
    };
    if (cursor !== undefined) body.cursor = cursor;
    if (queryId !== undefined) body.query_id = queryId;
    // A causal read with our own bookmark waits for our last write to be
    // visible before pinning. Strong refreshes anyway, so the bookmark is
    // noise there.
    const bm = opts.bookmark === undefined ? this.lastBookmark : opts.bookmark;
    if (bm && (opts.consistency ?? "causal") === "causal") body.bookmark = bm;

    let res: { status: number; body: string };
    try {
      res = await this.send(JSON.stringify(body), opts.timeoutMs ?? this.cfg.timeoutMs);
    } catch (err) {
      // A connection-level failure means the socket pool may be pointed at a
      // process that no longer exists — a restarted or recreated container
      // reusing the same port. Retire the agent so the retry dials fresh.
      this.retireAgent();
      const msg = err instanceof Error ? err.message : String(err);
      throw new HydraError(
        `HydraDB unreachable at ${this.cfg.url}: ${msg}`,
        "unreachable",
        0,
        cypher,
      );
    }

    const text = res.body;
    if (res.status < 200 || res.status >= 300) {
      let code = "http_error";
      let message = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        // Non-JSON error body — keep the raw text, it is all we have.
      }
      throw new HydraError(message, code, res.status, cypher);
    }

    this.queries++;
    const parsed = JSON.parse(text) as {
      columns?: string[];
      rows?: unknown[][];
      bookmark?: string | null;
      read_epoch?: number | null;
      next_cursor?: number | null;
      query_id?: string;
    };
    const columns = parsed.columns ?? [];
    const rows = (parsed.rows ?? []).map((row) => {
      const obj: Record<string, HydraValue> = {};
      columns.forEach((c, i) => {
        obj[c] = decode(row[i]);
      });
      return obj;
    });
    if (parsed.bookmark) this.lastBookmark = parsed.bookmark;
    return {
      result: {
        columns,
        rows,
        seq: seqFromBookmark(parsed.bookmark),
        bookmark: parsed.bookmark ?? null,
        readEpoch: parsed.read_epoch ?? null,
      },
      nextCursor: parsed.next_cursor ?? null,
      queryId: parsed.query_id ?? "",
    };
  }

  /**
   * Upsert vertices in one round trip.
   *
   * HydraDB rejects a bare `MERGE (n {id: 1}) SET ...` — a single-node upsert
   * has to arrive through the `UNWIND` batch form, whose input must be a
   * parameter holding a list of maps. So even a one-row upsert goes through
   * here. `props` names the row fields to write, because the SET list has to be
   * spelled out literally; it cannot be driven by the data.
   */
  async upsertNodes(
    label: string,
    rows: Record<string, unknown>[],
    props: string[],
  ): Promise<QueryResult> {
    if (!rows.length) return { columns: [], rows: [], seq: 0, bookmark: null, readEpoch: null };
    const sets = ["n:" + label, ...props.map((p) => `n.${p} = row.${p}`)].join(", ");
    return this.query(`UNWIND $rows AS row MERGE (n {id: row.id}) SET ${sets}`, { rows });
  }

  /**
   * Relate matched pairs in one round trip. `MERGE` on the relationship so a
   * retry is idempotent — HydraDB commits an unchanged MERGE either way, so
   * replaying a batch costs the same as running it and changes nothing.
   */
  async relate(
    srcLabel: string,
    relType: string,
    dstLabel: string,
    rows: { src: number; dst: number; rid: number; [k: string]: unknown }[],
    props: string[] = [],
  ): Promise<QueryResult> {
    if (!rows.length) return { columns: [], rows: [], seq: 0, bookmark: null, readEpoch: null };
    const sets = props.length ? ` SET ${props.map((p) => `r.${p} = row.${p}`).join(", ")}` : "";
    return this.query(
      `UNWIND $rows AS row ` +
        `MATCH (s:${srcLabel} {id: row.src}), (d:${dstLabel} {id: row.dst}) ` +
        `MERGE (s)-[r:${relType} {id: row.rid}]->(d)${sets}`,
      { rows },
    );
  }

  /** Fire-and-log — for telemetry writes that must never break a turn. */
  async tryQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
    opts: QueryOpts = {},
  ): Promise<QueryResult | null> {
    try {
      return await this.query(cypher, parameters, opts);
    } catch (err) {
      logbook.warn(
        "hydra",
        "a HydraDB write failed and was dropped",
        `${cypher.slice(0, 160)}\n${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}

let shared: HydraClient | null = null;

/** The process-wide client. One connection pool, one bookmark chain. */
export function hydra(): HydraClient {
  if (!shared) shared = new HydraClient();
  return shared;
}

/** Tests point the shared client at their own graph. */
export function setHydra(client: HydraClient | null): void {
  shared = client;
}
