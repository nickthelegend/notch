/**
 * Agent self-triage: root-cause an agent from its own traces. We stub the
 * ClickHouse (SigNoz) fetch and force the deterministic heuristic path so the
 * root cause + fix are asserted without a model call.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { parseCliOutput, triageAgent } from "../src/observability/triage.js";

beforeAll(() => {
  process.env.NOTCH_TRIAGE_NO_LLM = "1"; // deterministic: heuristic only
});
afterEach(() => vi.unstubAllGlobals());

function stubCh(rows: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => rows.map((r) => JSON.stringify(r)).join("\n") }) as unknown as Response),
  );
}

describe("agent self-triage", () => {
  it("root-causes a timeout from SigNoz spans, with the upstream handoff", async () => {
    const now = Date.now();
    stubCh([
      { ts: now, name: "notch.error", ms: 0, code: 2, msg: "tool_call 'bash' timed out after 30s", kind: "error", cost: 0, tin: 0, tout: 0 },
      { ts: now - 5000, name: "gen_ai.agent.turn", ms: 1200, code: 1, msg: "", kind: "run_complete", cost: 0.01, tin: 100, tout: 50 },
      { ts: now - 8000, name: "notch.baton.handoff", ms: 0, code: 1, msg: "opencode -> claude-code", kind: "handoff", cost: 0, tin: 0, tout: 0 },
    ]);
    const r = await triageAgent("claude-code");
    expect(r.from).toBe("signoz");
    expect(r.errorCount).toBe(1);
    expect(r.source).toBe("heuristic");
    expect(r.rootCause).toMatch(/timed out/i);
    expect(r.rootCause).toMatch(/opencode/); // upstream surfaced
    expect(r.suggestedFix).toMatch(/timeout|timed out/i);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("falls back to the local event log when SigNoz is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const now = Date.now();
    const events: LoomEvent[] = [
      { id: 1, ts: now - 2000, kind: "handoff", payload: { from: "planner", to: "exec" } } as LoomEvent,
      { id: 2, ts: now - 1000, kind: "error", agentId: "exec", payload: { message: "401 unauthorized: not signed in" } } as LoomEvent,
    ];
    const r = await triageAgent("exec", events);
    expect(r.from).toBe("local-log");
    expect(r.errorCount).toBe(1);
    expect(r.rootCause).toMatch(/401|unauthor/i);
    expect(r.suggestedFix).toMatch(/sign|auth|key|permission/i);
  });

  it("reports healthy when there are no error spans", async () => {
    stubCh([{ ts: Date.now(), name: "gen_ai.agent.turn", ms: 300, code: 1, msg: "", kind: "run_complete", cost: 0.01, tin: 5, tout: 3 }]);
    const r = await triageAgent("plannerbot");
    expect(r.errorCount).toBe(0);
    expect(r.rootCause).toMatch(/healthy/i);
  });

  it("returns no-data when SigNoz is empty and there is no fallback", async () => {
    stubCh([]);
    const r = await triageAgent("ghost");
    expect(r.source).toBe("no-data");
    expect(r.from).toBe("none");
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
