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
import { NotchTelemetry, resolveTelemetryConfig } from "./signoz.js";

let singleton: NotchTelemetry | null = null;

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
 * Record one live agent event. Best-effort and non-throwing: observability must
 * never break the agent loop. Only telemetry-worthy kinds emit a span.
 */
export function recordAgentEvent(event: LoomEvent, ctx: EventContext = {}): void {
  try {
    const t = telemetry();
    if (!t.enabled) return;
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
        t.span({
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
        });
        break;
      }
      case "tool_call": {
        t.span({
          name: "gen_ai.tool.call",
          ...nsWindow(event.ts, num(p.durationMs) ?? 0),
          attributes: {
            ...base,
            "gen_ai.tool.name": str(p.tool) || str(p.name) || "tool",
          },
        });
        break;
      }
      case "handoff": {
        t.span({
          name: "notch.baton.handoff",
          ...nsWindow(event.ts, 0),
          attributes: {
            ...base,
            "notch.handoff.to": str(p.to) || str(p.agent),
            "notch.handoff.from": str(p.from) || event.agentId,
          },
        });
        break;
      }
      case "route_started":
      case "route_step":
      case "route_paused":
      case "route_resumed":
      case "route_completed":
      case "route_failed": {
        t.span({
          name: `notch.route.${event.kind.slice("route_".length)}`,
          ...nsWindow(event.ts, num(p.durationMs) ?? 0),
          attributes: { ...base, "notch.route.id": str(p.routeId) || str(p.id) },
          error: event.kind === "route_failed" ? str(p.error) || "route failed" : undefined,
        });
        break;
      }
      case "memory_add":
      case "memory_update":
      case "memory_forget": {
        t.span({
          name: `notch.memory.${event.kind.slice("memory_".length)}`,
          ...nsWindow(event.ts, 0),
          attributes: {
            ...base,
            "notch.memory.kind": str(p.kind) || str(p.type),
            "notch.memory.scope": str(p.scope),
          },
        });
        break;
      }
      case "error": {
        t.span({
          name: "notch.error",
          ...nsWindow(event.ts, 0),
          attributes: base,
          error: str(p.message) || "error",
        });
        break;
      }
      default:
        break;
    }
  } catch {
    /* never let telemetry throw into the agent loop */
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
