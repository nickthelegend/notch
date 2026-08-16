/**
 * Metric shapes and names.
 *
 * The OTLP exporter that used to live here is gone — metric series are derived
 * from the spans in HydraDB now (`observability/insights.ts`), which removes a
 * class of bug the two-store design had: a metric and the spans it summarised
 * could disagree and nothing would say so.
 *
 * What remains is the vocabulary: the names, units and attribute keys, which
 * are unchanged so the charts and their labels still mean what they meant.
 *
 * Every number here is derived from a LoomEvent that actually happened. There
 * is no periodic "emit 0 so the chart has a line" path, because a flat zero and
 * "nothing happened" look identical on a graph and only one of them is true.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * `gen_ai.*` names and attributes follow the OpenTelemetry GenAI semantic
 * conventions (semantic-conventions-genai, the GenAI metrics doc split out of
 * the main semconv repo): `gen_ai.client.token.usage` with a
 * `gen_ai.token.type` of `input`/`output`, `gen_ai.client.operation.duration`
 * in seconds, dimensioned by `gen_ai.operation.name`, `gen_ai.system` and
 * `gen_ai.request.model`. `notch.*` names are ours — nothing in the convention
 * covers batons, routes or a per-agent daily spend cap — and follow its style.
 *
 * One deliberate deviation: the convention models `gen_ai.client.token.usage`
 * as a *histogram* (a distribution of tokens-per-request). Notch emits it as a
 * monotonic sum. A histogram earns its keep when you want percentiles over many
 * requests; Notch reports exactly one input/output pair per turn, and what
 * anyone asks this data is "how many tokens did this agent burn today" — a sum
 * answers that exactly, and a histogram's `sum` field only approximates it once
 * you start dropping buckets. `gen_ai.client.operation.duration` stays a
 * histogram, as specified, because turn latency genuinely is a distribution.
 *
 * ── Temporality ─────────────────────────────────────────────────────────────
 * Delta, everywhere (AGGREGATION_TEMPORALITY_DELTA). Cumulative asks the
 * *client* to remember every counter's running total for the life of the
 * process and expects the backend to detect resets. Notch's daemon restarts
 * whenever you edit a config or upgrade the CLI, so cumulative would mean a
 * counter reset every few minutes — the exact case cumulative handles worst.
 * Delta makes each export self-contained: what happened since the last flush,
 * nothing remembered, nothing to reset.
 */

/**
 * An attribute value, as the GenAI conventions allow one.
 *
 * These types outlived the OTLP exporter that defined them: the fold still
 * produces convention-shaped attributes, so the mapping tests, span names and
 * attribute keys are all unchanged by the move to HydraDB.
 */
export type AttrValue = string | number | boolean | undefined | null;

/** A flat key/value attribute bag. */
export type KeyValue = Record<string, AttrValue>;



/** OTLP AggregationTemporality. 1 = CUMULATIVE, 2 = DELTA. See the header. */
const TEMPORALITY_DELTA = 2;

/** Flush window, matched to the trace exporter's so signals land together. */
const FLUSH_MS = 1500;

/** Hard cap on distinct series held between flushes; see `guardCardinality`. */
const MAX_SERIES = 512;

/**
 * Bucket boundaries for `gen_ai.client.operation.duration`, in seconds, as
 * specified by the GenAI metrics convention. Kept verbatim rather than tuned:
 * matching the convention is what lets a GenAI dashboard built for any
 * other instrumented service read Notch's turns too.
 */
const DURATION_BUCKETS_S = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
];

export type MetricAttributes = Record<string, AttrValue>;

/** A monotonic counter's accumulated delta for one attribute set. */
type SumSeries = { kind: "sum"; attributes: KeyValue[]; value: number; isInt: boolean };

/** A histogram's accumulated delta for one attribute set. */
type HistogramSeries = {
  kind: "histogram";
  attributes: KeyValue[];
  bounds: number[];
  counts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
};

/**
 * A gauge observation. Unlike the other two this is not accumulated — it is the
 * last value we actually observed, carried with the timestamp we observed it,
 * so the exported point is a real reading rather than a flush-time guess.
 */
type GaugeSeries = { kind: "gauge"; attributes: KeyValue[]; value: number; observedNs: bigint };

type Series = SumSeries | HistogramSeries | GaugeSeries;

/** Everything a caller needs to describe one metric. */
type MetricMeta = { unit: string; description: string };

const META: Record<string, MetricMeta> = {
  "gen_ai.client.token.usage": { unit: "{token}", description: "Tokens consumed by an agent turn, by token type." },
  "gen_ai.client.operation.duration": { unit: "s", description: "Duration of a completed agent turn." },
  "notch.turns": { unit: "{turn}", description: "Agent turns that reached completion, by outcome." },
  "notch.cost.usd": { unit: "USD", description: "Money an adapter reported spending on a turn." },
  "notch.agents.active": { unit: "{agent}", description: "Agents currently executing a turn." },
  "notch.handoffs": { unit: "{handoff}", description: "Baton handoffs between agents." },
};
