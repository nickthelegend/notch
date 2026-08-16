/**
 * Telemetry, in the graph.
 *
 * Every turn, handoff, route and error is folded into a `gen_ai`-shaped span
 * and written next to the event it came from:
 *
 *   (:Project)-[:HAS_SPAN]->(:Span)      one per turn / handoff / route / error
 *   (:Project)-[:HAS_LOG]->(:LogLine)    the structured log the Logs view reads
 *
 * Both hang off the project by an edge rather than a property, because scoping
 * by property is a full scan of every project's rows — see graph.ts for the
 * measurement.
 *
 * Two things follow from keeping this in one store, and both are the reason it
 * is here rather than in a telemetry stack of its own:
 *
 *   - **There is nothing to be out of sync with.** A span and the event it was
 *     folded from are one query away from each other, and a trace can be joined
 *     to the memory a turn produced without leaving the graph.
 *   - **Nothing degrades.** A view backed by a second system has to have an
 *     opinion about that system being down. Here "the store is down" and "the
 *     daemon is down" are the same condition, reported once.
 *
 * The fold itself — which event becomes which span, and with what `gen_ai.*`
 * attributes — lives in `observability/index.ts`. This file is the storage.
 */

import crypto from "node:crypto";
import { logbook } from "../core/logbook.js";
import type { ProjectGraph } from "./graph.js";
import { LABEL, REL, relId } from "./graph.js";
import { kindBase } from "./ids.js";

/** One row of the span table. Shape matches what the Observatory renders. */
export interface StoredSpan {
  traceId: string;
  spanId: string;
  ts: number;
  name: string;
  ms: number;
  /** OTel status: 2 = error. */
  code: number;
  msg: string;
  agent: string;
  /** `gen_ai.system` — the adapter kind. */
  ade: string;
  model: string;
  tin: number;
  tout: number;
  cost: number;
  handoffFrom: string;
  handoffTo: string;
}

export interface StoredLog {
  ts: number;
  /** debug | info | warn | error */
  level: string;
  agent: string;
  body: string;
  traceId: string;
  kind: string;
}

/** Flush when this many rows are queued… */
const BATCH_ROWS = 64;
/** …or after this long, so a quiet fleet still lands its telemetry. */
const FLUSH_MS = 400;

function spanVid(slot: number): number {
  return kindBase("turn") + slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
}
function logVid(slot: number): number {
  return kindBase("alert") + slot * 2 ** 32 + crypto.randomInt(0, 2 ** 32);
}

/**
 * Per-project telemetry writer and reader.
 *
 * Writes are queued and batched exactly like the event log's, for the same
 * reason: a turn emits a burst of spans and one round trip per burst is the
 * difference between telemetry that is free and telemetry you can feel.
 */
export class TelemetryStore {
  private spanQueue: Record<string, unknown>[] = [];
  private logQueue: Record<string, unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private graph: ProjectGraph) {}

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  recordSpan(s: StoredSpan): void {
    this.spanQueue.push({
      id: spanVid(this.graph.slot),
      trace: s.traceId,
      span: s.spanId,
      ts: s.ts,
      name: s.name,
      ms: s.ms,
      code: s.code,
      msg: String(s.msg ?? "").slice(0, 4000),
      agent: s.agent,
      ade: s.ade,
      model: s.model,
      tin: s.tin,
      tout: s.tout,
      cost: s.cost,
      hfrom: s.handoffFrom,
      hto: s.handoffTo,
      proj: this.graph.slot,
    });
    this.schedule();
  }

  recordLog(l: StoredLog): void {
    this.logQueue.push({
      id: logVid(this.graph.slot),
      ts: l.ts,
      level: l.level,
      agent: l.agent,
      body: String(l.body ?? "").slice(0, 8000),
      trace: l.traceId,
      kind: l.kind,
      proj: this.graph.slot,
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.spanQueue.length + this.logQueue.length >= BATCH_ROWS) {
      void this.flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Await durability of everything recorded so far. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const spans = this.spanQueue;
    const logs = this.logQueue;
    if (!spans.length && !logs.length) return this.chain;
    this.spanQueue = [];
    this.logQueue = [];
    this.chain = this.chain.then(() => this.write(spans, logs));
    return this.chain;
  }

  private async write(
    spans: Record<string, unknown>[],
    logs: Record<string, unknown>[],
  ): Promise<void> {
    const c = this.graph.client;
    try {
      await this.graph.open();
      if (spans.length) {
        await c.query(
          "UNWIND $rows AS row MERGE (s {id: row.id}) SET s:Span, s.trace = row.trace, " +
            "s.span = row.span, s.ts = row.ts, s.name = row.name, s.ms = row.ms, " +
            "s.code = row.code, s.msg = row.msg, s.agent = row.agent, s.ade = row.ade, " +
            "s.model = row.model, s.tin = row.tin, s.tout = row.tout, s.cost = row.cost, " +
            "s.hfrom = row.hfrom, s.hto = row.hto, s.proj = row.proj",
          { rows: spans },
        );
        await c.relate(
          LABEL.project,
          REL.hasSpan,
          "Span",
          spans.map((r) => ({
            src: this.graph.vid,
            dst: r.id as number,
            rid: relId(this.graph.vid, r.id as number, REL.hasSpan),
          })),
        );
      }
      if (logs.length) {
        await c.query(
          "UNWIND $rows AS row MERGE (l {id: row.id}) SET l:LogLine, l.ts = row.ts, " +
            "l.level = row.level, l.agent = row.agent, l.body = row.body, " +
            "l.trace = row.trace, l.kind = row.kind, l.proj = row.proj",
          { rows: logs },
        );
        await c.relate(
          LABEL.project,
          REL.hasLog,
          "LogLine",
          logs.map((r) => ({
            src: this.graph.vid,
            dst: r.id as number,
            rid: relId(this.graph.vid, r.id as number, REL.hasLog),
          })),
        );
      }
    } catch (err) {
      // Telemetry must never break a turn, but it must also never lie about
      // having been written. Requeue and say so.
      this.spanQueue = [...spans, ...this.spanQueue];
      this.logQueue = [...logs, ...this.logQueue];
      logbook.warn(
        "telemetry",
        `could not persist ${spans.length} span(s) and ${logs.length} log line(s) — requeued`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  private static readonly SPAN_COLS =
    "s.trace AS trace, s.span AS span, s.ts AS ts, s.name AS name, s.ms AS ms, " +
    "s.code AS code, s.msg AS msg, s.agent AS agent, s.ade AS ade, s.model AS model, " +
    "s.tin AS tin, s.tout AS tout, s.cost AS cost, s.hfrom AS hfrom, s.hto AS hto";

  private rowToSpan(r: Record<string, unknown>): StoredSpan {
    return {
      traceId: String(r.trace ?? ""),
      spanId: String(r.span ?? ""),
      ts: Number(r.ts ?? 0),
      name: String(r.name ?? ""),
      ms: Number(r.ms ?? 0),
      code: Number(r.code ?? 0),
      msg: String(r.msg ?? ""),
      agent: String(r.agent ?? ""),
      ade: String(r.ade ?? ""),
      model: String(r.model ?? ""),
      tin: Number(r.tin ?? 0),
      tout: Number(r.tout ?? 0),
      cost: Number(r.cost ?? 0),
      handoffFrom: String(r.hfrom ?? ""),
      handoffTo: String(r.hto ?? ""),
    };
  }

  /** Newest spans first, optionally for one agent. */
  async spans(opts: { agent?: string; limit?: number } = {}): Promise<StoredSpan[]> {
    await this.graph.open();
    const where = opts.agent ? " WHERE s.agent = $agent" : "";
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasSpan}]->(s:Span)${where} ` +
        `RETURN ${TelemetryStore.SPAN_COLS} ORDER BY ts DESC LIMIT $limit`,
      {
        pv: this.graph.vid,
        limit: Math.min(2000, opts.limit ?? 200),
        ...(opts.agent ? { agent: opts.agent } : {}),
      },
    );
    return res.rows.map((r) => this.rowToSpan(r));
  }

  /** Every span in one trace, oldest first — the waterfall. */
  async trace(traceId: string): Promise<StoredSpan[]> {
    await this.graph.open();
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasSpan}]->(s:Span) WHERE s.trace = $trace ` +
        `RETURN ${TelemetryStore.SPAN_COLS} ORDER BY ts LIMIT 500`,
      { pv: this.graph.vid, trace: traceId },
    );
    return res.rows.map((r) => this.rowToSpan(r));
  }

  /** How many error spans this agent has produced since `sinceMs`. Drives self-heal. */
  async errorsSince(agent: string, sinceMs: number): Promise<number> {
    await this.graph.open();
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasSpan}]->(s:Span) ` +
        "WHERE s.agent = $agent AND s.code = 2 AND s.ts > $since RETURN count(*) AS n",
      { pv: this.graph.vid, agent, since: sinceMs },
      { consistency: "strong" },
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Structured logs, newest first, filterable the way the Logs view filters. */
  async logs(
    opts: { level?: string; agent?: string; contains?: string; limit?: number } = {},
  ): Promise<StoredLog[]> {
    await this.graph.open();
    const clauses: string[] = [];
    const params: Record<string, unknown> = {
      pv: this.graph.vid,
      limit: Math.min(2000, opts.limit ?? 300),
    };
    if (opts.level && opts.level !== "all") {
      clauses.push("l.level = $level");
      params.level = opts.level;
    }
    if (opts.agent) {
      clauses.push("l.agent = $agent");
      params.agent = opts.agent;
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const res = await this.graph.client.query(
      `MATCH (p:${LABEL.project} {id: $pv})-[:${REL.hasLog}]->(l:LogLine)${where} ` +
        "RETURN l.ts AS ts, l.level AS level, l.agent AS agent, l.body AS body, " +
        "l.trace AS trace, l.kind AS kind ORDER BY ts DESC LIMIT $limit",
      params,
    );
    let out: StoredLog[] = res.rows.map((r) => ({
      ts: Number(r.ts ?? 0),
      level: String(r.level ?? "info"),
      agent: String(r.agent ?? ""),
      body: String(r.body ?? ""),
      traceId: String(r.trace ?? ""),
      kind: String(r.kind ?? ""),
    }));
    // Substring search is filtered here rather than in Cypher: HydraDB's WHERE
    // has `STARTS WITH` but no `CONTAINS`, and "the line mentions runtime.ts"
    // is a contains question.
    if (opts.contains?.trim()) {
      const needle = opts.contains.trim().toLowerCase();
      out = out.filter(
        (l) => l.body.toLowerCase().includes(needle) || l.agent.toLowerCase().includes(needle),
      );
    }
    return out;
  }

  /** Total spend and tokens, per agent, over a window. Backs Metrics. */
  async usage(sinceMs = 0): Promise<
    { agent: string; turns: number; cost: number; tin: number; tout: number; errors: number }[]
  > {
    const spans = await this.spans({ limit: 2000 });
    const by = new Map<
      string,
      { agent: string; turns: number; cost: number; tin: number; tout: number; errors: number }
    >();
    for (const s of spans) {
      if (s.ts < sinceMs || !s.agent) continue;
      const cur =
        by.get(s.agent) ?? { agent: s.agent, turns: 0, cost: 0, tin: 0, tout: 0, errors: 0 };
      if (s.name === "notch.agent.turn") cur.turns += 1;
      cur.cost += s.cost;
      cur.tin += s.tin;
      cur.tout += s.tout;
      if (s.code === 2) cur.errors += 1;
      by.set(s.agent, cur);
    }
    return [...by.values()].sort((a, b) => b.cost - a.cost);
  }
}

const stores = new Map<string, TelemetryStore>();

/** One TelemetryStore per project per process. */
export function telemetryFor(graph: ProjectGraph): TelemetryStore {
  const existing = stores.get(graph.projectId);
  if (existing) return existing;
  const t = new TelemetryStore(graph);
  stores.set(graph.projectId, t);
  return t;
}

export function clearTelemetryStores(): void {
  stores.clear();
}
