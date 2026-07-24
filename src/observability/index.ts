/**
 * The Notch observability layer: folds LoomEvents into OpenTelemetry spans and
 * ships them to SigNoz. One process-wide exporter, resolved from the env.
 *
 * Mapping (LoomEvent → span, GenAI semantic conventions where they apply):
 *   run_complete            → gen_ai.agent.turn   (duration, cost, tokens, model)
 *   tool_call               → gen_ai.tool.call
 *   handoff                 → notch.baton.handoff
 *   route_*                 → notch.route.<phase>
 *   memory_add/update/forget→ notch.memory.<op>
 *   error                   → span with ERROR status
 */

import type { LoomEvent } from "../types.js";
import { NotchTelemetry, newTraceId, resolveTelemetryConfig, type SpanInput } from "./signoz.js";

let singleton: NotchTelemetry | null = null;

// One trace per agent turn: minted when a turn starts, reused by every span in
// that turn (tool calls, the completion), cleared when it ends — so SigNoz shows
// a real span tree per turn instead of one orphan span per event.
const turnTrace = new Map<string, string>();

/** The trace id a span belongs to, advancing the per-agent turn as it goes. */
function traceIdFor(event: LoomEvent): string {
  const agent = event.agentId ?? "";
  const isTurnStart = event.kind === "status" && (event.payload as Record<string, unknown>)?.state === "turn_started";
  if (isTurnStart || !turnTrace.has(agent)) turnTrace.set(agent, newTraceId());
  const id = turnTrace.get(agent)!;
  if (event.kind === "run_complete") turnTrace.delete(agent); // this span closes the turn
  return id;
}

export function telemetry(): NotchTelemetry {
  if (!singleton) singleton = new NotchTelemetry(resolveTelemetryConfig());
  return singleton;
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
 * Record one live agent event. Best-effort and non-throwing: observability must
 * never break the agent loop. Only telemetry-worthy kinds emit a span.
 */
export function recordAgentEvent(event: LoomEvent, ctx: EventContext = {}): void {
  try {
    const t = telemetry();
    if (!t.enabled) return;
    const traceId = traceIdFor(event); // advance the per-agent turn trace for every event
    const span = eventToSpan(event, ctx);
    if (span) t.span({ ...span, traceId });
  } catch {
    /* never let telemetry throw into the agent loop */
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
