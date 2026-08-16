/**
 * Agent self-triage: root-cause an agent from its own traces.
 *
 * The spans come out of HydraDB, so these write real spans to a real node and
 * read them back — nothing stubbed in the middle. The LLM phrasing step stays
 * off (`NOTCH_TRIAGE_NO_LLM`) so the deterministic root cause and fix are what
 * gets asserted.
 */

import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { parseAnthropicText, parseCliOutput, triageAgent } from "../src/observability/triage.js";
import { TelemetryStore } from "../src/hydra/telemetry.js";
import { projectGraph } from "../src/hydra/graph.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  process.env.NOTCH_TRIAGE_NO_LLM = "1"; // deterministic: heuristic only
  up = await hydraUp();
  if (!up) console.warn(`skipping triage span tests — ${HYDRA_SKIP_MESSAGE}`);
});
afterEach(() => vi.unstubAllGlobals());

async function storeFor(prefix: string): Promise<TelemetryStore> {
  const { loomDir } = isolatedProject(prefix);
  const graph = projectGraph(path.resolve(loomDir));
  await graph.open();
  return new TelemetryStore(graph);
}

/** Write spans and wait for them to be durable. */
async function withSpans(
  prefix: string,
  spans: Array<Partial<Parameters<TelemetryStore["recordSpan"]>[0]>>,
): Promise<TelemetryStore> {
  const s = await storeFor(prefix);
  for (const over of spans) {
    s.recordSpan({
      traceId: "t".repeat(32), spanId: "s".repeat(16), ts: Date.now(), name: "gen_ai.agent.turn",
      ms: 0, code: 0, msg: "", agent: "", ade: "", model: "", tin: 0, tout: 0, cost: 0,
      handoffFrom: "", handoffTo: "", ...over,
    });
  }
  await s.flush();
  return s;
}

describe("agent self-triage", () => {
  it("root-causes a timeout from its own spans, with the upstream handoff", async () => {
    if (!up) return;
    const now = Date.now();
    const store = await withSpans("triage-timeout", [
      { ts: now, name: "notch.error", code: 2, msg: "tool_call 'bash' timed out after 30s", agent: "claude-code" },
      { ts: now - 5000, name: "gen_ai.agent.turn", ms: 1200, agent: "claude-code", cost: 0.01, tin: 100, tout: 50 },
      { ts: now - 8000, name: "notch.baton.handoff", msg: "opencode -> claude-code", handoffFrom: "opencode", handoffTo: "claude-code" },
    ]);
    const r = await triageAgent(store, "claude-code");
    expect(r.from).toBe("hydradb");
    expect(r.errorCount).toBe(1);
    expect(r.source).toBe("heuristic");
    expect(r.rootCause).toMatch(/timed out/i);
    expect(r.rootCause).toMatch(/opencode/); // upstream surfaced
    expect(r.suggestedFix).toMatch(/timeout|timed out/i);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("falls back to the local event log when the agent has no spans yet", async () => {
    if (!up) return;
    const store = await storeFor("triage-fallback");
    const now = Date.now();
    const events: LoomEvent[] = [
      { id: 1, ts: now - 2000, kind: "handoff", payload: { from: "planner", to: "exec" } } as LoomEvent,
      { id: 2, ts: now - 1000, kind: "error", agentId: "exec", payload: { message: "401 unauthorized: not signed in" } } as LoomEvent,
    ];
    const r = await triageAgent(store, "exec", events);
    expect(r.from).toBe("local-log");
    expect(r.errorCount).toBe(1);
    expect(r.rootCause).toMatch(/401|unauthor/i);
    expect(r.suggestedFix).toMatch(/sign|auth|key|permission/i);
  });

  it("reports healthy when there are no error spans", async () => {
    if (!up) return;
    const store = await withSpans("triage-healthy", [
      { ts: Date.now(), name: "gen_ai.agent.turn", ms: 300, agent: "plannerbot", cost: 0.01, tin: 5, tout: 3 },
    ]);
    const r = await triageAgent(store, "plannerbot");
    expect(r.errorCount).toBe(0);
    expect(r.rootCause).toMatch(/healthy/i);
  });

  /**
   * The fallback path used to write `cost: 0` on every turn it derived from the
   * event log — not "we don't know", a measured-looking zero in the column where
   * the span path puts a real number. Nothing renders triage evidence costs
   * today, which is exactly why it survived: a fabricated figure that isn't
   * drawn yet is one render away from being believed. The log has the answer.
   */
  it("takes the turn's real cost from the log, not a zero", async () => {
    if (!up) return;
    const store = await storeFor("triage-cost");
    const now = Date.now();
    const events: LoomEvent[] = [
      { id: 1, ts: now - 3000, kind: "run_complete", agentId: "spender",
        payload: { durationMs: 4200, costUsd: 0.0731, inputTokens: 900, outputTokens: 120 } } as LoomEvent,
      { id: 2, ts: now - 1000, kind: "error", agentId: "spender",
        payload: { message: "tool_call 'bash' timed out after 30s" } } as LoomEvent,
    ];
    const r = await triageAgent(store, "spender", events);
    expect(r.from).toBe("local-log");
    const turn = r.evidence.find((s) => s.kind === "run_complete");
    expect(turn?.cost).toBe(0.0731);
  });

  it("returns no-data when there are no spans and no fallback", async () => {
    if (!up) return;
    const store = await storeFor("triage-empty");
    const r = await triageAgent(store, "ghost");
    expect(r.source).toBe("no-data");
    expect(r.from).toBe("none");
  });
});

describe("triage LLM prose via the Anthropic API (works headless, no CLI needed)", () => {
  it("uses the ANTHROPIC_API_KEY path and returns source=llm", async () => {
    if (!up) return;
    const prev = { key: process.env.ANTHROPIC_API_KEY, noLlm: process.env.NOTCH_TRIAGE_NO_LLM };
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.NOTCH_TRIAGE_NO_LLM; // allow the LLM path for this test
    // The spans are real; only the Anthropic call is stubbed, because asserting
    // "we called the model and used its prose" must not depend on a live key.
    const store = await withSpans("triage-llm", [
      { ts: Date.now(), name: "gen_ai.agent.turn", ms: 61000, code: 2, msg: "deadline exceeded", agent: "opencode", tin: 5 },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ content: [{ type: "text", text: "opencode timed out on turn 5; raise the deadline." }] }),
      }) as unknown as Response),
    );
    const r = await triageAgent(store, "opencode");
    expect(r.source).toBe("llm");
    expect(r.rootCause).toMatch(/timed out on turn 5/);
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.noLlm !== undefined) process.env.NOTCH_TRIAGE_NO_LLM = prev.noLlm;
  });
});

describe("parseAnthropicText — reading an Anthropic /v1/messages reply", () => {
  it("concatenates text blocks", () => {
    expect(parseAnthropicText({ content: [{ type: "text", text: "root " }, { type: "text", text: "cause." }] })).toBe("root cause.");
  });
  it("returns null when there is no text", () => {
    expect(parseAnthropicText({ content: [] })).toBeNull();
    expect(parseAnthropicText({})).toBeNull();
  });
});

describe("parseCliOutput — reading the claude CLI's print-mode reply", () => {
  it("pulls .result out of --output-format json", () => {
    const raw = JSON.stringify({ type: "result", is_error: false, result: "opencode crashed on turn 5; restart it." });
    expect(parseCliOutput(raw)).toBe("opencode crashed on turn 5; restart it.");
  });
  it("returns null for an empty result (the child-session case)", () => {
    expect(parseCliOutput(JSON.stringify({ is_error: false, result: "" }))).toBeNull();
  });
  it("returns null when the CLI reports an error", () => {
    expect(parseCliOutput(JSON.stringify({ is_error: true, result: "Not logged in" }))).toBeNull();
  });
  it("falls back to raw text for a non-JSON (older CLI) reply", () => {
    expect(parseCliOutput("  the agent timed out; raise the deadline.  ")).toBe("the agent timed out; raise the deadline.");
  });
  it("returns null for blank output", () => {
    expect(parseCliOutput("   ")).toBeNull();
  });
});
