/**
 * Observatory insights, read back from SigNoz's ClickHouse: the spans behind the
 * Span Replay viewer and the Trace Waterfall, the per-agent burn-rate series, and
 * a deterministic 0–100 Agent Health Score. All of it is derived from the same
 * real gen_ai spans Notch exports — nothing here is synthetic.
 *
 * The scoring (`healthScore`) is a pure function so it is unit-tested without a
 * live ClickHouse, and it is the same math the UI badges render.
 */

import type { LoomEvent } from "../types.js";
import { SPAN_TABLE, chLiteral, chQuery } from "./clickhouse.js";

export type InsightSpan = {
  traceId: string;
  spanId: string;
  ts: number;
  name: string;
  ms: number;
  code: number; // OTel status: 2 = error
  msg: string;
  agent: string;
  ade: string; // gen_ai.system — the adapter kind
  model: string;
  tin: number;
  tout: number;
  cost: number;
  handoffFrom: string;
  handoffTo: string;
};

const SELECT = `
  toString(trace_id) AS traceId, toString(span_id) AS spanId,
  toUnixTimestamp64Milli(timestamp) AS ts, name,
  round(duration_nano / 1e6) AS ms, status_code AS code, status_message AS msg,
  attributes_string['gen_ai.agent.id']       AS agent,
  attributes_string['gen_ai.system']         AS ade,
  attributes_string['gen_ai.request.model']  AS model,
  attributes_string['notch.handoff.from']    AS handoffFrom,
  attributes_string['notch.handoff.to']      AS handoffTo,
  toFloat64(attributes_number['gen_ai.usage.cost_usd'])     AS cost,
  toUInt32(attributes_number['gen_ai.usage.input_tokens'])  AS tin,
  toUInt32(attributes_number['gen_ai.usage.output_tokens']) AS tout`;

const SERVICE = "`resource_string_service$$name` = 'notch'";

function rowToSpan(r: Record<string, unknown>): InsightSpan {
  return {
    traceId: String(r.traceId ?? ""),
    spanId: String(r.spanId ?? ""),
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
    handoffFrom: String(r.handoffFrom ?? ""),
    handoffTo: String(r.handoffTo ?? ""),
  };
}

/** Recent spans for a project (optionally one agent), newest first. */
export async function fetchSpans(project: string, opts: { agent?: string; limit?: number } = {}): Promise<InsightSpan[]> {
  const proj = chLiteral(project);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const agentFilter = opts.agent ? `AND attributes_string['gen_ai.agent.id'] = '${chLiteral(opts.agent)}'` : "";
  const sql = `SELECT ${SELECT} FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['notch.project'] = '${proj}' ${agentFilter}
    ORDER BY timestamp DESC LIMIT ${limit}`;
  return (await chQuery(sql)).map(rowToSpan);
}

/** How many error spans an agent has emitted since `sinceMs` — the self-heal recheck signal. */
export async function recentAgentErrors(project: string, agent: string, sinceMs: number): Promise<number> {
  const proj = chLiteral(project);
  const a = chLiteral(agent);
  const sinceSec = Math.floor(Math.max(0, sinceMs) / 1000);
  const sql = `SELECT count() AS n FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['notch.project'] = '${proj}'
      AND attributes_string['gen_ai.agent.id'] = '${a}'
      AND status_code = 2
      AND timestamp >= toDateTime(${sinceSec})`;
  const rows = await chQuery(sql);
  return Number(rows[0]?.n ?? 0);
}

/** Every span in one trace, oldest first — the waterfall's rows. */
export async function traceSpans(traceId: string): Promise<InsightSpan[]> {
  const t = chLiteral(traceId);
  if (!t) return [];
  const sql = `SELECT ${SELECT} FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND trace_id = '${t}' ORDER BY timestamp ASC LIMIT 300`;
  return (await chQuery(sql)).map(rowToSpan);
}

/**
 * Fallback: derive InsightSpans from the local event log — the same data SigNoz
 * gets — so the Observatory's replay/health/waterfall still work when ClickHouse
 * is down or the agent hasn't emitted to SigNoz yet.
 */
export function insightSpansFromLog(events: LoomEvent[], agent?: string): InsightSpan[] {
  const out: InsightSpan[] = [];
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const mine = e.agentId === agent || p.to === agent || p.from === agent;
    if (agent && !mine) continue;
    const common = { traceId: "", spanId: String(e.id), ts: e.ts, ade: "", model: String(p.model ?? ""), handoffFrom: "", handoffTo: "" };
    if (e.kind === "run_complete") {
      out.push({ ...common, name: "gen_ai.agent.turn", ms: Number(p.durationMs ?? 0), code: p.error ? 2 : 1, msg: String(p.error ?? ""),
        agent: e.agentId ?? "", tin: Number(p.inputTokens ?? 0), tout: Number(p.outputTokens ?? 0), cost: Number(p.costUsd ?? 0) });
    } else if (e.kind === "error") {
      out.push({ ...common, name: "notch.error", ms: 0, code: 2, msg: String(p.message ?? "error"), agent: e.agentId ?? "", tin: 0, tout: 0, cost: 0 });
    } else if (e.kind === "handoff") {
      out.push({ ...common, name: "notch.baton.handoff", ms: 0, code: 1, msg: `${p.from ?? "?"} -> ${p.to ?? "?"}`,
        agent: e.agentId ?? "", tin: 0, tout: 0, cost: 0, handoffFrom: String(p.from ?? ""), handoffTo: String(p.to ?? "") });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export type BurnBucket = { t: number; byAgent: Record<string, number>; total: number };
export type BurnSeries = {
  hours: number;
  buckets: BurnBucket[];
  totalUsd: number;
  /** USD/hour over the covered window, and the linear projection for 24h. */
  ratePerHour: number;
  projected24h: number;
};

/** Per-agent cost over time, bucketed — the burn-rate sparkline's data + a linear projection. */
export async function burnSeries(project: string, opts: { hours?: number; buckets?: number } = {}): Promise<BurnSeries> {
  const proj = chLiteral(project);
  const hours = Math.min(720, Math.max(1, opts.hours ?? 24));
  const nBuckets = Math.min(60, Math.max(2, opts.buckets ?? 12));
  const stepSec = Math.max(60, Math.round((hours * 3600) / nBuckets));
  const sql = `SELECT
      toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL ${stepSec} SECOND)) AS bucket,
      attributes_string['gen_ai.agent.id'] AS agent,
      sum(toFloat64(attributes_number['gen_ai.usage.cost_usd'])) AS cost
    FROM ${SPAN_TABLE}
    WHERE ${SERVICE} AND attributes_string['notch.project'] = '${proj}'
      AND name = 'gen_ai.agent.turn'
      AND timestamp >= now() - INTERVAL ${hours} HOUR
    GROUP BY bucket, agent ORDER BY bucket ASC`;
  const rows = await chQuery(sql);
  const map = new Map<number, BurnBucket>();
  for (const r of rows) {
    const t = Number(r.bucket ?? 0) * 1000;
    const agent = String(r.agent ?? "unknown");
    const cost = Number(r.cost ?? 0);
    const b = map.get(t) ?? { t, byAgent: {}, total: 0 };
    b.byAgent[agent] = (b.byAgent[agent] ?? 0) + cost;
    b.total += cost;
    map.set(t, b);
  }
  const buckets = [...map.values()].sort((a, b) => a.t - b.t);
  const totalUsd = buckets.reduce((a, b) => a + b.total, 0);
  const ratePerHour = totalUsd / hours;
  return { hours, buckets, totalUsd, ratePerHour, projected24h: ratePerHour * 24 };
}

export type Health = {
  score: number; // 0–100
  grade: "healthy" | "degraded" | "unhealthy";
  turns: number;
  errorCount: number;
  buckets: { errorRate: number; latency: number; tokenBloat: number; recency: number }; // penalties (each ≥ 0)
};

const isErr = (s: InsightSpan): boolean => s.code === 2 || s.name === "notch.error" || s.name === "notch.route.failed";

/**
 * A deterministic 0–100 health score from an agent's own spans. Four penalty
 * buckets subtract from 100:
 *   errorRate (≤40) — share of spans that errored
 *   latency   (≤25) — share of turns slower than 30s
 *   tokenBloat(≤20) — average input tokens above an 80k comfort line
 *   recency   (≤15) — how recently the last error fired (fades over 30 min)
 * Pure: same input, same score — this is what the UI badge shows.
 */
export function healthScore(spans: InsightSpan[], now = Date.now()): Health {
  const turns = spans.filter((s) => s.name === "gen_ai.agent.turn");
  const errs = spans.filter(isErr).sort((a, b) => b.ts - a.ts);
  const nTurns = turns.length;

  const errorRate = spans.length ? Math.round((errs.length / spans.length) * 40) : 0;
  const slow = turns.filter((t) => t.ms > 30_000).length;
  const latency = nTurns ? Math.round(Math.min(1, slow / nTurns) * 25) : 0;
  const avgIn = nTurns ? turns.reduce((a, t) => a + t.tin, 0) / nTurns : 0;
  const tokenBloat = Math.round(Math.min(1, Math.max(0, (avgIn - 80_000) / 120_000)) * 20);
  let recency = 0;
  if (errs[0]) {
    const ageMin = (now - errs[0].ts) / 60_000;
    recency = Math.round(Math.max(0, 1 - ageMin / 30) * 15);
  }

  const score = Math.max(0, Math.min(100, 100 - errorRate - latency - tokenBloat - recency));
  const grade = score >= 80 ? "healthy" : score >= 50 ? "degraded" : "unhealthy";
  return { score, grade, turns: nTurns, errorCount: errs.length, buckets: { errorRate, latency, tokenBloat, recency } };
}
