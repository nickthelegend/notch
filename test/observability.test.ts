/**
 * The pure LoomEvent → span mapper (GenAI semantic conventions).
 *
 * The OTLP exporter and its env-driven config used to be tested here too. Both
 * are gone — spans are written into HydraDB now — so what remains is the part
 * that still decides anything: which event becomes which span, with which
 * attributes. That mapping is unchanged by the move, which is exactly why it
 * is worth keeping a test on.
 */

import { describe, expect, it } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { eventToSpan } from "../src/observability/index.js";

const ev = (
  kind: string,
  payload: Record<string, unknown> = {},
  extra: Partial<LoomEvent> = {},
): LoomEvent => ({ id: 1, ts: 1_000, kind: kind as LoomEvent["kind"], payload, ...extra });

describe("eventToSpan (LoomEvent -> OTel span)", () => {
  it("maps run_complete to gen_ai.agent.turn with cost, tokens, model, and a duration window", () => {
    const s = eventToSpan(
      ev(
        "run_complete",
        { durationMs: 1500, costUsd: 0.02, inputTokens: 100, outputTokens: 50, model: "claude-opus-4-8", adapter: "codex" },
        { agentId: "codex", chat: "main" },
      ),
      { project: "acme" },
    )!;
    expect(s.name).toBe("gen_ai.agent.turn");
    expect(s.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(s.attributes["gen_ai.system"]).toBe("codex");
    expect(s.attributes["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(s.attributes["gen_ai.usage.cost_usd"]).toBe(0.02);
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(s.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(s.attributes["notch.project"]).toBe("acme");
    expect(s.endNs - s.startNs).toBe(1500n * 1_000_000n);
  });

  it("reads tokensIn/tokensOut as an alias for input/output tokens", () => {
    const s = eventToSpan(ev("run_complete", { tokensIn: 7, tokensOut: 3 }))!;
    expect(s.attributes["gen_ai.usage.input_tokens"]).toBe(7);
    expect(s.attributes["gen_ai.usage.output_tokens"]).toBe(3);
  });

  it("maps handoff to notch.baton.handoff with from/to", () => {
    const s = eventToSpan(ev("handoff", { from: "planner", to: "exec" }))!;
    expect(s.name).toBe("notch.baton.handoff");
    expect(s.attributes["notch.handoff.from"]).toBe("planner");
    expect(s.attributes["notch.handoff.to"]).toBe("exec");
  });

  it("maps route_failed to an errored route span", () => {
    const s = eventToSpan(ev("route_failed", { routeId: "r1", error: "boom" }))!;
    expect(s.name).toBe("notch.route.failed");
    expect(s.attributes["notch.route.id"]).toBe("r1");
    expect(s.error).toBe("boom");
  });

  it("maps memory + tool + error kinds", () => {
    expect(eventToSpan(ev("memory_add", { kind: "fact" }))!.name).toBe("notch.memory.add");
    expect(eventToSpan(ev("tool_call", { tool: "grep" }))!.attributes["gen_ai.tool.name"]).toBe("grep");
    const e = eventToSpan(ev("error", { message: "nope" }))!;
    expect(e.name).toBe("notch.error");
    expect(e.error).toBe("nope");
  });

  it("returns null for non-telemetry kinds (message, status)", () => {
    expect(eventToSpan(ev("message", { text: "hi" }))).toBeNull();
    expect(eventToSpan(ev("status", { state: "turn_cost", costUsd: 0.001 }))).toBeNull();
  });
});
