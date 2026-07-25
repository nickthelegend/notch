/**
 * Notch → SigNoz observability.
 *
 * A self-contained OTLP/HTTP (JSON) trace exporter — no OpenTelemetry SDK
 * dependency, just `fetch`. Notch's agent lifecycle is already a stream of
 * LoomEvents (turns, routes, baton handoffs, memory folds); this maps the
 * notable ones to spans using the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*`) so they land in SigNoz's LLM/GenAI monitoring views.
 *
 * This module owns traces plus the pieces every signal shares: the resolved
 * config, the resource attributes, and the OTLP attribute encoding. The
 * metrics (`./metrics.ts`) and logs (`./logs.ts`) exporters import those rather
 * than growing their own copy, so a service.name change lands on all three at
 * once and a span, a datapoint and a log line always agree about who emitted
 * them.
 *
 * Egress is best-effort and consent-gated: if no collector is reachable the
 * POST fails silently and never surfaces in the instrumented operation. Turn
 * it off with DO_NOT_TRACK=1 or NOTCH_TELEMETRY_DISABLED=1.
 */

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// OTLP/JSON encodes int64 as a string (proto3 JSON mapping); trace/span ids are
// the documented hex exception. Keeping intValue a string works on self-hosted
// and SigNoz Cloud alike.
export type KeyValue = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };

/** Anything we know how to put on an OTLP attribute. */
export type AttrValue = string | number | boolean | undefined | null;

export type NotchTelemetryConfig = {
  /** Collector base URL, e.g. http://localhost:4318. */
  endpoint: string;
  /** Logical service name in SigNoz. */
  serviceName: string;
  /** Optional headers (SigNoz Cloud ingestion key → signoz-access-token). */
  headers: Record<string, string>;
  enabled: boolean;
  /**
   * Per-signal switches, ANDed with `enabled`.
   *
   * The consent opt-outs (DO_NOT_TRACK, NOTCH_TELEMETRY_DISABLED, NOTCH_OTEL=0)
   * kill everything — consent is not per-signal. These two are a different
   * thing: volume control for someone who wants traces but not the log firehose
   * (Notch ships every agent message as a log record, which is the point, and
   * also a lot of bytes). Off means off for that signal only.
   */
  metricsEnabled: boolean;
  logsEnabled: boolean;
};

/** Resolve config from the environment; disabled under standard opt-outs. */
export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): NotchTelemetryConfig {
  const optedOut =
    truthy(env.DO_NOT_TRACK) ||
    truthy(env.NOTCH_TELEMETRY_DISABLED) ||
    env.NOTCH_OTEL === "0";
  const endpoint = (
    env.NOTCH_OTEL_ENDPOINT ||
    env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    env.SIGNOZ_ENDPOINT ||
    "http://localhost:4318"
  ).replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = env.SIGNOZ_INGESTION_KEY || env.SIGNOZ_ACCESS_TOKEN;
  if (key) headers["signoz-access-token"] = key;
  const enabled = !optedOut;
  return {
    endpoint,
    serviceName: env.NOTCH_SERVICE_NAME || "notch",
    headers,
    enabled,
    metricsEnabled: enabled && env.NOTCH_OTEL_METRICS !== "0",
    logsEnabled: enabled && env.NOTCH_OTEL_LOGS !== "0",
  };
}

/**
 * The `resource` block every signal carries. Identical across traces, metrics
 * and logs on purpose: SigNoz keys a service off `service.name`, so a mismatch
 * here is what makes a trace and its own logs look like two different apps.
 */
export function resourceAttributes(cfg: NotchTelemetryConfig): KeyValue[] {
  return [
    kv("service.name", cfg.serviceName),
    kv("service.namespace", "notch"),
    kv("telemetry.sdk.name", "notch-otlp"),
    kv("telemetry.sdk.language", "nodejs"),
  ];
}

/**
 * Encode an attribute bag, dropping empties.
 *
 * Absent is not the same as zero or "": a datapoint tagged
 * `gen_ai.request.model=""` claims we know the model and it is the empty
 * string. Leaving the key off says we don't know, which is the truth for
 * adapters that never report one.
 */
export function encodeAttributes(attributes: Record<string, AttrValue>): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === "") continue;
    out.push(kv(k, v));
  }
  return out;
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/** 16-byte trace id / 8-byte span id as lowercase hex (no crypto dep needed). */
export function hexId(bytes: number): string {
  let s = "";
  for (let i = 0; i < bytes; i++) s += ((Math.random() * 256) | 0).toString(16).padStart(2, "0");
  return s;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
}

export type SpanInput = {
  name: string;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, string | number | boolean | undefined | null>;
  error?: string;
  /** Correlate related spans (a turn + its tool calls) under one trace. */
  traceId?: string;
};

/** A fresh 16-byte trace id — used to group a turn's spans into one trace. */
export function newTraceId(): string {
  return hexId(16);
}

/**
 * The exporter. Batches spans in a short window and POSTs OTLP/HTTP JSON.
 * Failures are swallowed by design so tracing never breaks the app.
 */
export class NotchTelemetry {
  private buffer: Record<string, unknown>[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly tracesUrl: string;
  private readonly resourceAttributes: KeyValue[];

  constructor(private readonly cfg: NotchTelemetryConfig) {
    this.tracesUrl = `${cfg.endpoint}/v1/traces`;
    this.resourceAttributes = resourceAttributes(cfg);
  }

  get enabled(): boolean {
    return this.cfg.enabled && typeof globalThis.fetch === "function";
  }

  /**
   * Emit one span, returning the span id it was given — or undefined when
   * telemetry is off and no span exists.
   *
   * The id goes back to the caller so a log record covering the same event can
   * carry the same `spanId` and be clickable from that exact span in SigNoz,
   * rather than only from the trace as a whole. Undefined rather than "" for
   * the same reason turnTraceId() is: an empty span id is a link to nothing.
   */
  span(input: SpanInput): string | undefined {
    if (!this.enabled) return undefined;
    const spanId = hexId(8);
    this.buffer.push({
      traceId: input.traceId ?? hexId(16),
      spanId,
      name: input.name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: input.startNs.toString(),
      endTimeUnixNano: input.endNs.toString(),
      attributes: encodeAttributes(input.attributes),
      status: input.error
        ? { code: STATUS_ERROR, message: input.error }
        : { code: STATUS_OK },
    });
    if (this.buffer.length >= 64) this.drain();
    else this.ensureTimer();
    return spanId;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, 1500);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private drain(): void {
    if (this.buffer.length === 0) return;
    const spans = this.buffer;
    this.buffer = [];
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: this.resourceAttributes },
          scopeSpans: [{ scope: { name: "notch" }, spans }],
        },
      ],
    };
    postOtlp(this.tracesUrl, this.cfg.headers, payload);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
  }
}

/**
 * Fire one OTLP/HTTP JSON payload at the collector and forget about it.
 *
 * Deliberately not awaited and deliberately swallowing everything: telemetry is
 * a side channel, and a collector that is down, slow or returning 400 must not
 * become an unhandled rejection in an agent turn. Shared by all three signals
 * so they fail the same silent way.
 */
export function postOtlp(url: string, headers: Record<string, string>, payload: unknown): void {
  void Promise.resolve()
    .then(async () => {
      const res = await globalThis.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      // Drain the response even though we don't care what it says. undici keeps
      // a pooled socket checked out until its body is consumed, so a fire-and-
      // forget POST that never reads the reply holds a connection open until
      // GC. One signal got away with that; three signals on a busy event stream
      // exhaust the pool and start queueing — which shows up as the *agent*
      // getting slower, i.e. exactly the thing telemetry must never do.
      await res.arrayBuffer().catch(() => undefined);
    })
    .catch(() => {
      /* best-effort: an unreachable collector must never surface */
    });
}

export function kv(key: string, v: string | number | boolean): KeyValue {
  if (typeof v === "number") {
    return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  }
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  return { key, value: { stringValue: str(v) } };
}
