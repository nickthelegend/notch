/**
 * The Logs view's read-back — out of HydraDB.
 *
 * This is the one view with **no local fallback**, and that is deliberate. A
 * span can be reconstructed from the event log because it summarises an event
 * the daemon already holds; a log line cannot — its severity, body and trace
 * correlation only exist once the record was built. Rebuilding something
 * log-shaped from the event log would be inventing data, so an unreachable
 * store is reported rather than rendered as an empty list that reads as a quiet
 * run.
 *
 * Filtering is expressed against the store rather than built into a query
 * string, which is why there is no escaping function here: nothing is
 * interpolated.
 */

import type { TelemetryStore } from "../hydra/telemetry.js";

export type InsightLog = {
  ts: number;
  severity: string;
  /** OTel severity_number (1–24). Kept so the UI can sort/threshold without parsing text. */
  severityNumber: number;
  body: string;
  traceId: string;
  spanId: string;
  agent: string;
  /** Which event produced the line (run_complete, status, message, …). */
  kind: string;
  /** The conversation the line belongs to. */
  chat: string;
};

export type FetchLogsOpts = {
  agent?: string;
  /** One or more severity words, comma-separated and case-insensitive ("error,warn"). */
  severity?: string;
  /** Pin to a single trace — the log side of the Trace Waterfall. */
  traceId?: string;
  /** Case-insensitive substring match on the body. */
  search?: string;
  limit?: number;
};

const SEVERITY_NUMBER: Record<string, number> = { debug: 5, info: 9, warn: 13, error: 17 };

/** Parse "error,warn" into the set the store filters on. */
export function parseSeverities(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "all" && s in SEVERITY_NUMBER);
}

export async function fetchLogs(
  store: TelemetryStore,
  opts: FetchLogsOpts = {},
): Promise<InsightLog[]> {
  const wanted = parseSeverities(opts.severity);
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 200));

  // One severity is pushed into the query; several are filtered after, because
  // HydraDB's WHERE has no `IN`. Both paths over-fetch so the cap still returns
  // a full page once the filters have been applied.
  const rows = await store.logs({
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(wanted.length === 1 ? { level: wanted[0]! } : {}),
    ...(opts.search?.trim() ? { contains: opts.search.trim() } : {}),
    limit: wanted.length > 1 || opts.traceId ? limit * 4 : limit,
  });

  let out = rows;
  if (wanted.length > 1) out = out.filter((l) => wanted.includes(l.level));
  if (opts.traceId) out = out.filter((l) => l.traceId === opts.traceId);

  return out.slice(0, limit).map((l) => ({
    ts: l.ts,
    severity: l.level.toUpperCase(),
    severityNumber: SEVERITY_NUMBER[l.level] ?? 9,
    body: l.body,
    traceId: l.traceId,
    // Log lines carry the trace they belong to, not a span id: a line is
    // emitted by an event, and only some events produce a span. An invented
    // span id would render as a link to nothing.
    spanId: "",
    agent: l.agent,
    kind: l.kind,
    chat: "",
  }));
}
