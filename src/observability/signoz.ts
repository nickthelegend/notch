/**
 * Notch → SigNoz observability.
 *
 * A self-contained OTLP/HTTP (JSON) trace exporter — no OpenTelemetry SDK
 * dependency, just `fetch`. Notch's agent lifecycle is already a stream of
 * LoomEvents (turns, routes, baton handoffs, memory folds); this maps the
 * notable ones to spans using the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*`) so they land in SigNoz's LLM/GenAI monitoring views.
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
type KeyValue = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };

export type NotchTelemetryConfig = {
  /** Collector base URL, e.g. http://localhost:4318. */
  endpoint: string;
  /** Logical service name in SigNoz. */
  serviceName: string;
  /** Optional headers (SigNoz Cloud ingestion key → signoz-access-token). */
  headers: Record<string, string>;
  enabled: boolean;
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
  return {
    endpoint,
    serviceName: env.NOTCH_SERVICE_NAME || "notch",
    headers,
    enabled: !optedOut,
  };
}

function truthy(v: string | undefined): boolean {
  return v === "1" || v === "true" || v === "yes";
}

/** 16-byte trace id / 8-byte span id as lowercase hex (no crypto dep needed). */
function hexId(bytes: number): string {
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
    this.resourceAttributes = [
      kv("service.name", cfg.serviceName),
      kv("service.namespace", "notch"),
      kv("telemetry.sdk.name", "notch-otlp"),
      kv("telemetry.sdk.language", "nodejs"),
    ];
  }

  get enabled(): boolean {
    return this.cfg.enabled && typeof globalThis.fetch === "function";
  }

  /** Emit one span. No-op when disabled. */
  span(input: SpanInput): void {
    if (!this.enabled) return;
    const attrs: KeyValue[] = [];
    for (const [k, v] of Object.entries(input.attributes)) {
      if (v === undefined || v === null || v === "") continue;
      attrs.push(kv(k, v));
    }
    this.buffer.push({
      traceId: input.traceId ?? hexId(16),
      spanId: hexId(8),
      name: input.name,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: input.startNs.toString(),
      endTimeUnixNano: input.endNs.toString(),
      attributes: attrs,
      status: input.error
        ? { code: STATUS_ERROR, message: input.error }
        : { code: STATUS_OK },
    });
    if (this.buffer.length >= 64) this.drain();
    else this.ensureTimer();
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
    void Promise.resolve()
      .then(() =>
        globalThis.fetch(this.tracesUrl, {
          method: "POST",
          headers: this.cfg.headers,
          body: JSON.stringify(payload),
        }),
      )
      .catch(() => {
        /* best-effort: an unreachable collector must never surface */
      });
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.drain();
  }
}

function kv(key: string, v: string | number | boolean): KeyValue {
  if (typeof v === "number") {
    return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
  }
  if (typeof v === "boolean") return { key, value: { boolValue: v } };
  return { key, value: { stringValue: str(v) } };
}
