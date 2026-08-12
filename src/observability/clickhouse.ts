/**
 * The one place Notch talks to SigNoz's ClickHouse. Every read-back feature —
 * triage, span replay, burn rate, health score, the trace waterfall — goes
 * through here so the endpoint, the table, and the failure behaviour are shared.
 *
 * Reads are best-effort: an unreachable ClickHouse throws, and callers fall back
 * (to the local event log, or an empty view) rather than break the page.
 */

export const CH_URL = process.env.NOTCH_CLICKHOUSE_URL || "http://localhost:8123";

/** SigNoz's span index. Every Notch span carries service.name = 'notch'. */
export const SPAN_TABLE = "signoz_traces.distributed_signoz_index_v3";

/** Escape a value for a single-quoted ClickHouse string literal. */
export function chLiteral(v: string): string {
  return v.replace(/[^\w.\-:/ ]/g, "");
}

/** Run one SQL query, returning parsed JSONEachRow rows. Throws if unreachable. */
export async function chQuery(sql: string): Promise<Record<string, unknown>[]> {
  if (typeof globalThis.fetch !== "function") throw new Error("no fetch");
  const res = await fetch(`${CH_URL}/?default_format=JSONEachRow`, { method: "POST", body: sql });
  if (!res.ok) throw new Error(`clickhouse ${res.status}`);
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
