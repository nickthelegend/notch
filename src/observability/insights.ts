/**
 * Observatory read-back — out of HydraDB.
 *
 * The spans live in the graph (`hydra/telemetry.ts`), so these read them from
 * there. `InsightSpan` is exactly what the store holds, `healthScore` is a pure
 * function over it, and the Observatory renders those numbers unchanged.
 *
 * `insightSpansFromLog` is NOT a fallback for the store being unreachable —
 * with one store, "the graph is down" and "the daemon is down" are the same
 * condition. It is kept because it is still the right answer for a window of
 * the log that predates telemetry being switched on.
 */

import type { LoomEvent } from "../types.js";
import type { StoredSpan, TelemetryStore } from "../hydra/telemetry.js";

/** A span as the Observatory renders it. Identical to what the store holds. */
export type InsightSpan = StoredSpan;

/** Recent spans for a project (optionally one agent), newest first. */
export async function fetchSpans(
  store: TelemetryStore,
  opts: { agent?: string; limit?: number } = {},
): Promise<InsightSpan[]> {
  return store.spans({
    ...(opts.agent ? { agent: opts.agent } : {}),
    limit: Math.min(500, Math.max(1, opts.limit ?? 200)),
  });
}

/** How many error spans an agent has emitted since `sinceMs` — the self-heal recheck signal. */
export async function recentAgentErrors(
  store: TelemetryStore,
  agent: string,
  sinceMs: number,
): Promise<number> {
  return store.errorsSince(agent, Math.max(0, sinceMs));
}

/** Every span in one trace, oldest first — the waterfall's rows. */
export async function traceSpans(store: TelemetryStore, traceId: string): Promise<InsightSpan[]> {
  if (!traceId) return [];
  return store.trace(traceId);
}

/**
 * Derive InsightSpans from the daemon's in-memory event log.
 *
 * Not a fallback for a missing store any more — it is the right answer for a
 * window of the log that predates telemetry being switched on, and for a turn
 * whose spans have not been flushed yet.
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

/**
 * Per-agent cost over time, bucketed — the burn sparkline plus a projection.
 *
 * Bucketed here rather than in Cypher: HydraDB's aggregation has no
 * `toStartOfInterval` equivalent, and the span count over a 24h window is small
 * enough that pulling it and grouping in memory is both simpler and faster than
 * any query that could express it.
 */
export async function burnSeries(
  store: TelemetryStore,
  opts: { hours?: number; buckets?: number } = {},
): Promise<BurnSeries> {
  const hours = Math.min(720, Math.max(1, opts.hours ?? 24));
  const nBuckets = Math.min(60, Math.max(2, opts.buckets ?? 12));
  const stepMs = Math.max(60_000, Math.round((hours * 3600_000) / nBuckets));
  const since = Date.now() - hours * 3600_000;

  const spans = (await store.spans({ limit: 2000 })).filter(
    (s) => s.name === "gen_ai.agent.turn" && s.ts >= since,
  );
  const map = new Map<number, BurnBucket>();
  for (const s of spans) {
    const t = Math.floor(s.ts / stepMs) * stepMs;
    const agent = s.agent || "unknown";
    const b = map.get(t) ?? { t, byAgent: {}, total: 0 };
    b.byAgent[agent] = (b.byAgent[agent] ?? 0) + s.cost;
    b.total += s.cost;
    map.set(t, b);
  }
  const buckets = [...map.values()].sort((a, b) => a.t - b.t);
  const totalUsd = buckets.reduce((a, b) => a + b.total, 0);
  const ratePerHour = totalUsd / hours;
  return { hours, buckets, totalUsd, ratePerHour, projected24h: ratePerHour * 24 };
}

/* ------------------------------------------------------------------------- *
 * Metric series
 *
 * Metrics used to live in their own tables and Notch read them back to check
 * its own arithmetic. There is no separate metric store now — the spans carry
 * every number the metrics were derived from, so the series are computed from
 * them directly. That removes a whole class of bug the old design had: a metric
 * and the spans it summarised could disagree, and nothing would say so.
 * ------------------------------------------------------------------------- */

export type MetricPoint = {
  /** Bucket start, epoch ms. */
  t: number;
  sum: number;
  avg: number;
  max: number;
  /** How many spans went into the bucket, so the UI can tell thin data from zero. */
  n: number;
};

export type MetricSeries = {
  metric: string;
  type: string;
  unit: string;
  temporality: string;
  /** The series' label set — here, the agent it belongs to. */
  labels: Record<string, string>;
  fingerprint: string;
  /** Which of sum/avg the UI should plot by default. */
  prefer: "sum" | "avg";
  points: MetricPoint[];
};

export type MetricQueryOpts = {
  sinceMs?: number;
  stepMs?: number;
};

export const NOTCH_METRIC_NAMES = [
  "notch.turns",
  "notch.cost.usd",
  "gen_ai.client.token.usage",
  "gen_ai.client.operation.duration",
];

/** How each metric is derived from one turn span, and how to read it. */
const METRIC_SPEC: Record<
  string,
  { value: (s: InsightSpan) => number; unit: string; type: string; prefer: "sum" | "avg" }
> = {
  "notch.turns": { value: () => 1, unit: "1", type: "Sum", prefer: "sum" },
  "notch.cost.usd": { value: (s) => s.cost, unit: "USD", type: "Sum", prefer: "sum" },
  "gen_ai.client.token.usage": {
    value: (s) => s.tin + s.tout,
    unit: "1",
    type: "Sum",
    prefer: "sum",
  },
  "gen_ai.client.operation.duration": {
    value: (s) => s.ms,
    unit: "ms",
    type: "Histogram",
    prefer: "avg",
  },
};

/** Every metric Notch can chart, with the names a caller may ask for. */
export function expandMetricNames(names: string[]): string[] {
  const known = new Set(Object.keys(METRIC_SPEC));
  const out = names.map((n) => String(n ?? "").trim()).filter((n) => known.has(n));
  return out.length ? [...new Set(out)] : [...known];
}

/** One series per (metric, agent), bucketed over the window. */
export async function fetchMetricSeries(
  store: TelemetryStore,
  names: string[],
  opts: MetricQueryOpts = {},
): Promise<MetricSeries[]> {
  const wanted = expandMetricNames(names);
  const since = opts.sinceMs ?? Date.now() - 24 * 3600_000;
  const stepMs = Math.max(60_000, opts.stepMs ?? 5 * 60_000);
  const spans = (await store.spans({ limit: 2000 })).filter(
    (s) => s.name === "gen_ai.agent.turn" && s.ts >= since,
  );

  const out: MetricSeries[] = [];
  for (const metric of wanted) {
    const spec = METRIC_SPEC[metric]!;
    const byAgent = new Map<string, Map<number, number[]>>();
    for (const s of spans) {
      const agent = s.agent || "unknown";
      const t = Math.floor(s.ts / stepMs) * stepMs;
      if (!byAgent.has(agent)) byAgent.set(agent, new Map());
      const series = byAgent.get(agent)!;
      if (!series.has(t)) series.set(t, []);
      series.get(t)!.push(spec.value(s));
    }
    for (const [agent, series] of byAgent) {
      const points: MetricPoint[] = [...series.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([t, vals]) => ({
          t,
          sum: vals.reduce((a, b) => a + b, 0),
          avg: vals.reduce((a, b) => a + b, 0) / vals.length,
          max: Math.max(...vals),
          n: vals.length,
        }));
      if (!points.length) continue;
      out.push({
        metric,
        type: spec.type,
        unit: spec.unit,
        temporality: "Delta",
        labels: { "gen_ai.agent.id": agent },
        fingerprint: `${metric}:${agent}`,
        prefer: spec.prefer,
        points,
      });
    }
  }
  return out;
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
