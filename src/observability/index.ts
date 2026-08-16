/**
 * The Notch observability layer: folds LoomEvents into spans, metrics and log
 * lines, and writes them into **HydraDB** — the same graph the events, the
 * baton and the brain already live in.
 *
 * The fold below still uses the OpenTelemetry GenAI semantic conventions for
 * names and attributes; what is deliberate is where it lands. One store
 * instead of two means a span sits one hop from the event that produced it and
 * the memory that turn learned, nothing can be out of sync with anything, and
 * no view has to degrade because a second system is down.
 *
 * Mapping (LoomEvent → span, GenAI semantic conventions where they apply):
 *   run_complete            → gen_ai.agent.turn   (duration, cost, tokens, model)
 *   tool_call               → gen_ai.tool.call
 *   handoff                 → notch.baton.handoff
 *   route_*                 → notch.route.<phase>
 *   memory_add/update/forget→ notch.memory.<op>
 *   error                   → span with ERROR status
 *
 * Metrics (LoomEvent → datapoint, see ./metrics.ts for names and temporality):
 *   run_complete            → gen_ai.client.token.usage, gen_ai.client.operation.duration,
 *                             notch.turns, notch.cost.usd (only if reported)
 *   status turn_started     → notch.agents.active
 *   handoff                 → notch.handoffs
 *
 * Logs (LoomEvent → log record, see ./logs.ts): the event stream itself,
 * correlated to the turn's trace so a span links to what the agent said.
 *
 * One event can produce all three. Callers still only call recordAgentEvent().
 */

import crypto from "node:crypto";
import type { LoomEvent } from "../types.js";
import type { MetricAttributes } from "./metrics.js";
import { eventToLogRecord, SEVERITY } from "./logs.js";
import type { TelemetryStore } from "../hydra/telemetry.js";

/**
 * A span as the fold produces it, before it reaches a store.
 *
 * Nanosecond window and flat attribute bag, because that is the shape the
 * GenAI conventions describe and the shape the mapping tests assert on. The
 * store flattens it into graph properties.
 */
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
  return crypto.randomBytes(16).toString("hex");
}

// One trace per agent turn: minted when a turn starts, reused by every span in
// that turn (tool calls, the completion), cleared when it ends — so the
// waterfall shows a real span tree per turn instead of one orphan per event.
const turnTrace = new Map<string, string>();
/**
 * The trace of the turn that most recently CLOSED, per agent. The decision
 * miner runs off `run_complete` — i.e. after the turn's trace has been retired
 * — and still needs the id to link each decision to the spans it came out of.
 * One entry per agent, so this is bounded by the roster, not by history.
 */
const lastTurnTrace = new Map<string, string>();

/**
 * The trace id a span belongs to, advancing the per-agent turn as it goes.
 *
 * Also reports the turn boundary it just crossed, because the trace map is
 * already the one place that knows where an agent's turn begins and ends.
 * `opened` is true on the event that started a turn, `closed` on the one that
 * ended it — which is what the active-agents gauge counts.
 */
function traceIdFor(event: LoomEvent): { traceId: string; opened: boolean; closed: boolean } {
  const agent = event.agentId ?? "";
  const isTurnStart = event.kind === "status" && (event.payload as Record<string, unknown>)?.state === "turn_started";
  const opened = isTurnStart || !turnTrace.has(agent);
  if (opened) turnTrace.set(agent, newTraceId());
  const traceId = turnTrace.get(agent)!;
  // A turn ends when it completes — or when it dies. An adapter that throws
  // emits `error` and may never reach run_complete; treating only the happy
  // path as an ending would leave the trace (and the gauge) open forever.
  const closed = event.kind === "run_complete" || event.kind === "error";
  if (closed) {
    lastTurnTrace.set(agent, traceId);
    turnTrace.delete(agent); // this span closes the turn
  }
  return { traceId, opened, closed };
}

/**
 * The trace id of an agent's in-flight turn, or the one that just finished.
 *
 * Undefined when telemetry is off, because then no trace was ever minted and
 * there is no trace to link to. Callers must leave the field out
 * rather than substituting "" — an empty trace id renders as a link that opens
 * a search for nothing, which reads as a broken feature rather than an absent
 * one.
 */
export function turnTraceId(agentId: string): string | undefined {
  return turnTrace.get(agentId) ?? lastTurnTrace.get(agentId);
}

/**
 * Telemetry is off when `NOTCH_TELEMETRY_DISABLED=1`.
 *
 * Kept as a switch because the test suite needs one — writing a span per event
 * would triple every test's round trips to prove nothing about the test. It is
 * not a degradation path: with it unset, telemetry always lands, because the
 * store it lands in is the one the daemon already cannot run without.
 */
/** OTel severity number → the word the Logs view filters on. */
function severityName(n: number): string {
  if (n >= SEVERITY.ERROR) return "error";
  if (n >= SEVERITY.WARN) return "warn";
  if (n >= SEVERITY.INFO) return "info";
  return "debug";
}

export function telemetryEnabled(): boolean {
  return process.env.NOTCH_TELEMETRY_DISABLED !== "1";
}

const MS_TO_NS = 1_000_000n;

function nsWindow(endMs: number, durationMs: number): { startNs: bigint; endNs: bigint } {
  const end = BigInt(Math.max(0, Math.round(endMs)));
  const dur = BigInt(Math.max(0, Math.round(durationMs)));
  return { startNs: (end - dur) * MS_TO_NS, endNs: end * MS_TO_NS };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export type EventContext = { project?: string };

/**
 * Pure mapper: a LoomEvent → the span it should emit, or null for kinds that
 * aren't telemetry-worthy. Exported so the mapping is unit-testable without a
 * live exporter or collector.
 */
export function eventToSpan(event: LoomEvent, ctx: EventContext = {}): SpanInput | null {
  const p = event.payload ?? {};
  const base = {
    "notch.project": ctx.project,
    "notch.chat": event.chat,
    "notch.event.kind": event.kind,
    "gen_ai.agent.id": event.agentId,
  };
  switch (event.kind) {
    case "run_complete": {
      const durationMs = num(p.durationMs) ?? 0;
      return {
        name: "gen_ai.agent.turn",
        ...nsWindow(event.ts, durationMs),
        attributes: {
          ...base,
          "gen_ai.system": str(p.adapter) || str(p.system) || "notch",
          "gen_ai.operation.name": "chat",
          "gen_ai.request.model": str(p.model) || undefined,
          "gen_ai.usage.input_tokens": num(p.tokensIn) ?? num(p.inputTokens),
          "gen_ai.usage.output_tokens": num(p.tokensOut) ?? num(p.outputTokens),
          "gen_ai.usage.cost_usd": num(p.costUsd),
          "notch.turn.duration_ms": durationMs,
        },
        error: p.error ? str(p.error) : undefined,
      };
    }
    case "tool_call":
      return {
        name: "gen_ai.tool.call",
        ...nsWindow(event.ts, num(p.durationMs) ?? 0),
        attributes: { ...base, "gen_ai.tool.name": str(p.tool) || str(p.name) || "tool" },
      };
    case "handoff":
      return {
        name: "notch.baton.handoff",
        ...nsWindow(event.ts, 0),
        attributes: {
          ...base,
          "notch.handoff.to": str(p.to) || str(p.agent),
          "notch.handoff.from": str(p.from) || event.agentId,
        },
      };
    case "route_started":
    case "route_step":
    case "route_paused":
    case "route_resumed":
    case "route_completed":
    case "route_failed":
      return {
        name: `notch.route.${event.kind.slice("route_".length)}`,
        ...nsWindow(event.ts, num(p.durationMs) ?? 0),
        attributes: { ...base, "notch.route.id": str(p.routeId) || str(p.id) },
        error: event.kind === "route_failed" ? str(p.error) || "route failed" : undefined,
      };
    case "memory_add":
    case "memory_update":
    case "memory_forget":
      return {
        name: `notch.memory.${event.kind.slice("memory_".length)}`,
        ...nsWindow(event.ts, 0),
        attributes: {
          ...base,
          "notch.memory.kind": str(p.kind) || str(p.type),
          "notch.memory.scope": str(p.scope),
        },
      };
    case "error":
      return { name: "notch.error", ...nsWindow(event.ts, 0), attributes: base, error: str(p.message) || "error" };
    default:
      return null;
  }
}

/**
 * One metric write, as data. Returned by the pure mapper below so the
 * event → datapoint decisions can be unit-tested without an exporter — the same
 * reason `eventToSpan` exists.
 */
export type MetricOp =
  | { op: "count"; name: string; value: number; attributes: MetricAttributes; isInt: boolean }
  | { op: "histogram"; name: string; value: number; attributes: MetricAttributes };

/**
 * Pure mapper: a LoomEvent → the datapoints it should produce.
 *
 * The rule that governs every branch: a number goes out only if the event
 * carried it. An adapter that reports tokens but no cost produces token
 * datapoints and no cost datapoint — not a cost datapoint of 0. Codex is
 * exactly this case, and the reasoning is written out at the top of
 * src/adapters/codex.ts: a fake $0.001 presented as fact is worse than a blank.
 * On a counter it is worse still, because zeros are indistinguishable from real
 * cheap turns once summed, and the total then reads as authoritative.
 */
export function eventToMetrics(event: LoomEvent): MetricOp[] {
  const p = event.payload ?? {};
  const ops: MetricOp[] = [];

  if (event.kind === "run_complete") {
    const agent = event.agentId;
    const model = str(p.model) || undefined;
    const system = str(p.adapter) || str(p.system) || undefined;
    // The GenAI convention's dimensions. `gen_ai.operation.name` is "chat"
    // because that is what an agent turn is under the convention's vocabulary.
    const genai: MetricAttributes = {
      "gen_ai.agent.id": agent,
      "gen_ai.request.model": model,
      "gen_ai.system": system,
      "gen_ai.operation.name": "chat",
    };

    const tokensIn = num(p.tokensIn) ?? num(p.inputTokens);
    const tokensOut = num(p.tokensOut) ?? num(p.outputTokens);
    // > 0 rather than != null: adapters that don't track usage write a literal
    // 0 into these fields (see runtime.trackCost), and a 0-token turn is not a
    // thing that happens. Counting those would report a busy agent as free.
    if (tokensIn !== undefined && tokensIn > 0) {
      ops.push({ op: "count", name: "gen_ai.client.token.usage", value: tokensIn, isInt: true, attributes: { ...genai, "gen_ai.token.type": "input" } });
    }
    if (tokensOut !== undefined && tokensOut > 0) {
      ops.push({ op: "count", name: "gen_ai.client.token.usage", value: tokensOut, isInt: true, attributes: { ...genai, "gen_ai.token.type": "output" } });
    }

    const durationMs = num(p.durationMs);
    if (durationMs !== undefined && durationMs >= 0) {
      // The convention specifies seconds, not milliseconds. Notch measures in
      // ms everywhere else; convert here rather than shipping a metric that
      // says "s" and holds ms.
      ops.push({ op: "histogram", name: "gen_ai.client.operation.duration", value: durationMs / 1000, attributes: genai });
    }

    ops.push({
      op: "count",
      name: "notch.turns",
      value: 1,
      isInt: true,
      attributes: { "gen_ai.agent.id": agent, "gen_ai.request.model": model, "gen_ai.system": system, status: p.error ? "error" : "ok" },
    });

    const costUsd = num(p.costUsd);
    // Present, finite and positive — the three things that make it a real
    // reported spend rather than a placeholder. Anything else emits nothing.
    if (costUsd !== undefined && costUsd > 0) {
      ops.push({ op: "count", name: "notch.cost.usd", value: costUsd, isInt: false, attributes: { "gen_ai.agent.id": agent, "gen_ai.request.model": model, "gen_ai.system": system } });
    }
    return ops;
  }

  if (event.kind === "handoff") {
    ops.push({
      op: "count",
      name: "notch.handoffs",
      value: 1,
      isInt: true,
      attributes: {
        "notch.handoff.from": str(p.from) || event.agentId || undefined,
        "notch.handoff.to": str(p.to) || str(p.agent) || undefined,
      },
    });
  }
  return ops;
}

/**
 * Agents with a turn in flight.
 *
 * Driven by the turn boundaries `traceIdFor` already computes, NOT by the
 * `turn_started` status event. Only some adapters emit that status — codex,
 * grok, claude-code and the antigravity bridge do; echo, opencode and the
 * antigravity CLI never do — so a gauge keyed on it would read zero for half
 * the roster while those agents were demonstrably working. A turn's trace
 * opening is the one signal that holds for every adapter, because it is
 * derived from the events rather than announced by them.
 *
 * Held here rather than asked of the daemon because this module must not reach
 * into the runtime, and because the answer has to be derived from events for
 * the same reason every other number is.
 */
const activeAgents = new Set<string>();

/** Maintain the active set, returning true when it actually moved. */
function trackActive(agent: string | undefined, opened: boolean, closed: boolean): boolean {
  if (!agent) return false; // human and system events are nobody's turn
  if (closed) return activeAgents.delete(agent);
  if (opened && !activeAgents.has(agent)) {
    activeAgents.add(agent);
    return true;
  }
  return false;
}

/**
 * Record one live agent event, fanning it out to every enabled signal.
 *
 * Best-effort and non-throwing: observability must never break the agent loop.
 * The three signals are independent — logs off still means traces and metrics —
 * so each checks its own switch, and the shared trace id is minted once so a
 * log record can point at the span covering the same event.
 */
export function recordAgentEvent(
  event: LoomEvent,
  ctx: EventContext = {},
  store?: TelemetryStore,
): void {
  try {
    if (!store || !telemetryEnabled()) return;

    // Advance the per-agent turn trace for every event — it is the id logs
    // correlate on, not just a trace-exporter detail.
    const { traceId } = traceIdFor(event);

    const span = eventToSpan(event, ctx);
    if (span) {
      const a = span.attributes;
      const ms = Number(a["notch.turn.duration_ms"] ?? 0) ||
        Number((span.endNs - span.startNs) / 1_000_000n);
      store.recordSpan({
        traceId,
        spanId: crypto.randomBytes(8).toString("hex"),
        ts: Number(span.endNs / 1_000_000n),
        name: span.name,
        ms,
        // OTel status: 2 is error. Kept as the same number the fold always
        // produced so `healthScore` and the Triage prompt need no changes.
        code: span.error ? 2 : 0,
        msg: span.error ?? "",
        agent: String(a["gen_ai.agent.id"] ?? ""),
        ade: String(a["gen_ai.system"] ?? ""),
        model: String(a["gen_ai.request.model"] ?? ""),
        tin: Number(a["gen_ai.usage.input_tokens"] ?? 0),
        tout: Number(a["gen_ai.usage.output_tokens"] ?? 0),
        cost: Number(a["gen_ai.usage.cost_usd"] ?? 0),
        handoffFrom: String(a["notch.handoff.from"] ?? ""),
        handoffTo: String(a["notch.handoff.to"] ?? ""),
      });
    }

    const record = eventToLogRecord(event, ctx);
    if (record) {
      store.recordLog({
        ts: event.ts,
        level: severityName(record.severityNumber),
        agent: event.agentId ?? "",
        body: typeof record.body === "string" ? record.body : JSON.stringify(record.body ?? ""),
        traceId,
        kind: event.kind,
      });
    }
  } catch {
    /* never let telemetry throw into the agent loop */
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
