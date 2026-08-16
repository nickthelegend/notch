/**
 * The pure LoomEvent → metric and → log-record mappers, plus the end-to-end
 * path from one event to a span and a log line in HydraDB.
 *
 * The OTLP exporter blocks that used to sit between them are gone with the
 * exporters. What is left is the part that still makes decisions — which event
 * becomes which datapoint, at which severity — and one test that the whole
 * fold really lands in the graph, run against a real node like the rest of the
 * suite.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { LoomEvent } from "../src/types.js";
import { eventToMetrics, recordAgentEvent } from "../src/observability/index.js";
import { eventToLogRecord, SEVERITY, truncate } from "../src/observability/logs.js";
import { TelemetryStore } from "../src/hydra/telemetry.js";
import { projectGraph } from "../src/hydra/graph.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";
import path from "node:path";

const ev = (
  kind: string,
  payload: Record<string, unknown> = {},
  extra: Partial<LoomEvent> = {},
): LoomEvent => ({ id: 1, ts: 1_000, kind: kind as LoomEvent["kind"], payload, ...extra });

describe("eventToMetrics (LoomEvent -> datapoints)", () => {
  const find = (ops: ReturnType<typeof eventToMetrics>, name: string) => ops.filter((o) => o.name === name);

  it("splits token usage into input/output series per the GenAI convention", () => {
    const ops = eventToMetrics(
      ev("run_complete", { durationMs: 2000, inputTokens: 900, outputTokens: 120, model: "gpt-5-codex", adapter: "codex" }, { agentId: "codex" }),
    );
    const tokens = find(ops, "gen_ai.client.token.usage");
    expect(tokens).toHaveLength(2);
    const input = tokens.find((t) => t.attributes["gen_ai.token.type"] === "input")!;
    const output = tokens.find((t) => t.attributes["gen_ai.token.type"] === "output")!;
    expect(input.value).toBe(900);
    expect(output.value).toBe(120);
    expect(input.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(input.attributes["gen_ai.request.model"]).toBe("gpt-5-codex");
    expect(input.attributes["gen_ai.operation.name"]).toBe("chat");
  });

  it("records turn duration as a histogram in seconds, not milliseconds", () => {
    const ops = eventToMetrics(ev("run_complete", { durationMs: 2500 }, { agentId: "a" }));
    const d = find(ops, "gen_ai.client.operation.duration")[0]!;
    expect(d.op).toBe("histogram");
    expect(d.value).toBe(2.5);
  });

  it("counts a completed turn with an ok/error status", () => {
    const ok = find(eventToMetrics(ev("run_complete", { durationMs: 1 }, { agentId: "a" })), "notch.turns")[0]!;
    expect(ok.value).toBe(1);
    expect(ok.attributes.status).toBe("ok");
    const bad = find(eventToMetrics(ev("run_complete", { durationMs: 1, error: "boom" }, { agentId: "a" })), "notch.turns")[0]!;
    expect(bad.attributes.status).toBe("error");
  });

  it("emits cost only when an adapter actually reported one", () => {
    const withCost = find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: 0.031 }, { agentId: "cc" })), "notch.cost.usd");
    expect(withCost).toHaveLength(1);
    expect(withCost[0]!.value).toBeCloseTo(0.031);
    expect(withCost[0]!.op === "count" && withCost[0]!.isInt).toBe(false); // money is not an integer
  });

  it("emits NO cost datapoint for adapters that report none — absent is not zero", () => {
    // codex reports tokens and deliberately never a dollar figure.
    const codex = ev("run_complete", { durationMs: 1200, inputTokens: 52831, outputTokens: 120, adapter: "codex" }, { agentId: "codex" });
    expect(find(eventToMetrics(codex), "notch.cost.usd")).toHaveLength(0);
    // and an explicit zero is still not a spend worth counting
    expect(find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: 0 })), "notch.cost.usd")).toHaveLength(0);
    expect(find(eventToMetrics(ev("run_complete", { durationMs: 1, costUsd: null })), "notch.cost.usd")).toHaveLength(0);
  });

  it("emits no token datapoints when the adapter tracked no usage", () => {
    // antigravity reports duration and model only; runtime.ts writes 0s.
    const agy = ev("run_complete", { durationMs: 15000, model: "gemini-flash", inputTokens: 0, outputTokens: 0 }, { agentId: "antigravity" });
    const ops = eventToMetrics(agy);
    expect(find(ops, "gen_ai.client.token.usage")).toHaveLength(0);
    expect(find(ops, "gen_ai.client.operation.duration")).toHaveLength(1); // duration is real, though
    expect(find(ops, "notch.turns")).toHaveLength(1);
  });

  it("counts a baton handoff with from/to", () => {
    const op = eventToMetrics(ev("handoff", { from: "planner", to: "coder" }, { agentId: "planner" }))[0]!;
    expect(op.name).toBe("notch.handoffs");
    expect(op.value).toBe(1);
    expect(op.attributes["notch.handoff.from"]).toBe("planner");
    expect(op.attributes["notch.handoff.to"]).toBe("coder");
  });

  it("produces nothing for events that carry no measurement", () => {
    expect(eventToMetrics(ev("message", { text: "hi" }))).toEqual([]);
    expect(eventToMetrics(ev("file_edit", { path: "/a.ts" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// NotchMetrics — the OTLP wire shapes
// ---------------------------------------------------------------------------

describe("eventToLogRecord (LoomEvent -> OTLP log record)", () => {
  it("maps an agent message to INFO with the text as the body", () => {
    const r = eventToLogRecord(ev("message", { text: "shipping the fix" }, { agentId: "codex", chat: "main" }), { project: "acme" })!;
    expect(r.severityNumber).toBe(SEVERITY.INFO);
    expect(r.body).toBe("shipping the fix");
    expect(r.attributes["gen_ai.agent.id"]).toBe("codex");
    expect(r.attributes["notch.project"]).toBe("acme");
    expect(r.attributes["notch.chat"]).toBe("main");
    expect(r.attributes["notch.event.kind"]).toBe("message");
    expect(r.timeUnixNano).toBe(1_000_000_000n); // ts 1000ms -> ns
  });

  it("tags reasoning so it can be filtered out of what the agent actually said", () => {
    const r = eventToLogRecord(ev("message", { text: "hmm", reasoning: true }, { agentId: "a" }))!;
    expect(r.attributes["notch.message.reasoning"]).toBe(true);
  });

  it("maps tool calls and file edits with their own attributes", () => {
    const tool = eventToLogRecord(ev("tool_call", { tool: "Bash", command: "ls" }, { agentId: "a" }))!;
    expect(tool.severityNumber).toBe(SEVERITY.INFO);
    expect(tool.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(tool.body).toContain("Bash");

    const edit = eventToLogRecord(ev("file_edit", { path: "/repo/a.ts", tool: "agy" }, { agentId: "a" }))!;
    expect(edit.attributes["notch.file.path"]).toBe("/repo/a.ts");
    expect(edit.body).toContain("/repo/a.ts");
  });

  it("maps a decision and a route step", () => {
    const d = eventToLogRecord(ev("decision", { text: "use delta temporality" }, { agentId: "a" }))!;
    expect(d.body).toContain("use delta temporality");
    const s = eventToLogRecord(ev("route_step", { routeId: "r1", step: "review" }))!;
    expect(s.severityNumber).toBe(SEVERITY.INFO);
    expect(s.attributes["notch.route.id"]).toBe("r1");
    expect(s.attributes["notch.route.phase"]).toBe("step");
  });

  it("maps severity honestly: error ERROR, notice WARN, message INFO, chatter DEBUG", () => {
    expect(eventToLogRecord(ev("error", { message: "agy exited 1" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.ERROR);
    expect(eventToLogRecord(ev("route_failed", { routeId: "r1", error: "no" }))!.severityNumber).toBe(SEVERITY.ERROR);
    expect(eventToLogRecord(ev("run_complete", { durationMs: 5, error: "boom" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.ERROR);

    expect(eventToLogRecord(ev("needs_input", { question: "which one?" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.WARN);
    expect(eventToLogRecord(ev("route_paused", { routeId: "r1" }))!.severityNumber).toBe(SEVERITY.WARN);

    expect(eventToLogRecord(ev("message", { text: "hi" }))!.severityNumber).toBe(SEVERITY.INFO);
    expect(eventToLogRecord(ev("handoff", { from: "a", to: "b" }))!.severityNumber).toBe(SEVERITY.INFO);
    expect(eventToLogRecord(ev("run_complete", { durationMs: 5 }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.INFO);

    expect(eventToLogRecord(ev("status", { state: "turn_started" }, { agentId: "a" }))!.severityNumber).toBe(SEVERITY.DEBUG);
  });

  it("surfaces a budget pause at WARN with the real numbers", () => {
    const r = eventToLogRecord(ev("status", { state: "budget_exceeded", budgetUsd: 5, spentTodayUsd: 5.4 }, { agentId: "cc" }))!;
    expect(r.severityNumber).toBe(SEVERITY.WARN);
    expect(r.body).toContain("$5.40");
    expect(r.body).toContain("$5.00");
    expect(r.attributes["notch.budget.usd"]).toBe(5);
    expect(r.attributes["notch.budget.spent_today_usd"]).toBe(5.4);
    expect(eventToLogRecord(ev("status", { state: "budget_recovered", pausedMs: 60_000 }, { agentId: "cc" }))!.severityNumber).toBe(SEVERITY.INFO);
  });

  it("truncates an enormous body with a marker instead of shipping it whole", () => {
    const huge = "x".repeat(200_000);
    const r = eventToLogRecord(ev("message", { text: huge }, { agentId: "a" }))!;
    expect(r.body.length).toBeLessThan(9_000);
    expect(r.body).toMatch(/… \[truncated \d+ chars\]$/);
    expect(truncate("short", 100)).toBe("short"); // untouched when it fits
  });

  it("returns null for events with nothing a human would read", () => {
    expect(eventToLogRecord(ev("message", { text: "" }))).toBeNull();
    expect(eventToLogRecord(ev("agent_join", { id: "a" }))).toBeNull();
    expect(eventToLogRecord(ev("turn_diff", { files: 2 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NotchLogs — the OTLP wire shape
// ---------------------------------------------------------------------------


describe("recordAgentEvent — one event becomes a span and a log in HydraDB", () => {
  let up = false;
  beforeAll(async () => {
    up = await hydraUp();
    if (!up) console.warn(`skipping telemetry write test — ${HYDRA_SKIP_MESSAGE}`);
  });

  it("writes a turn span with its model, tokens and cost, and a log correlated to the same trace", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("telemetry");
    const graph = projectGraph(path.resolve(loomDir));
    await graph.open();
    const store = new TelemetryStore(graph);

    // Telemetry is disabled suite-wide so an ordinary test does not pay for it;
    // this one is about telemetry, so it turns it back on for the call.
    const was = process.env.NOTCH_TELEMETRY_DISABLED;
    delete process.env.NOTCH_TELEMETRY_DISABLED;
    try {
      recordAgentEvent(
        {
          id: 7,
          ts: Date.now(),
          kind: "run_complete",
          agentId: "funnel-a",
          payload: {
            durationMs: 1500,
            model: "m1",
            adapter: "echo",
            costUsd: 0.002,
            inputTokens: 80,
            outputTokens: 20,
          },
        },
        { project: "acme" },
        store,
      );
      await store.flush();
    } finally {
      if (was != null) process.env.NOTCH_TELEMETRY_DISABLED = was;
    }

    const spans = await store.spans({ limit: 20 });
    const turn = spans.find((s) => s.name === "gen_ai.agent.turn");
    expect(turn).toBeTruthy();
    expect(turn!.agent).toBe("funnel-a");
    expect(turn!.model).toBe("m1");
    expect(turn!.ade).toBe("echo");
    expect(turn!.tin).toBe(80);
    expect(turn!.tout).toBe(20);
    expect(turn!.cost).toBeCloseTo(0.002, 6);
    expect(turn!.ms).toBe(1500);
    expect(turn!.code).toBe(0);

    // The log points at the same trace — that is the link that makes a span
    // clickable through to what the agent actually said.
    const logs = await store.logs({ limit: 20 });
    const line = logs.find((l) => l.agent === "funnel-a");
    expect(line).toBeTruthy();
    expect(line!.traceId).toBe(turn!.traceId);
    expect(line!.body).toContain("completed a turn in 1500ms");
    expect(line!.kind).toBe("run_complete");
  });

  it("records an errored turn with span status 2, so health scoring counts it", async () => {
    if (!up) return;
    const { loomDir } = isolatedProject("telemetry-err");
    const graph = projectGraph(path.resolve(loomDir));
    await graph.open();
    const store = new TelemetryStore(graph);

    const was = process.env.NOTCH_TELEMETRY_DISABLED;
    delete process.env.NOTCH_TELEMETRY_DISABLED;
    try {
      recordAgentEvent(
        { id: 9, ts: Date.now(), kind: "error", agentId: "sick", payload: { message: "boom" } },
        { project: "acme" },
        store,
      );
      await store.flush();
    } finally {
      if (was != null) process.env.NOTCH_TELEMETRY_DISABLED = was;
    }

    const spans = await store.spans({ limit: 20 });
    const err = spans.find((s) => s.name === "notch.error");
    expect(err?.code).toBe(2);
    expect(err?.msg).toBe("boom");
    expect(await store.errorsSince("sick", 0)).toBeGreaterThanOrEqual(1);
  });
});
