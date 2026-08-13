/**
 * Decision capture: LLM extraction (stubbed), the regex fallback, and the stats
 * rollup — all asserted without a live model.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionStats, extractDecisions, extractDecisionsRegex, parseDecisionsJson, type AgentDecision } from "../src/observability/decisions.js";

afterEach(() => vi.unstubAllGlobals());

const baseOpts = {
  agentId: "codex", agentRole: "builder", projectId: "p", chatId: "main",
  turnIndex: 3, traceId: "t", tokensUsed: 1200, costUsd: 0.02, durationMs: 4000, filesChanged: [] as string[],
};

describe("parseDecisionsJson", () => {
  it("parses a fenced JSON reply and normalizes fields", () => {
    const raw = "```json\n" + JSON.stringify({ decisions: [{ category: "architecture", title: "Event-sourced log", reasoning: "durable + auditable", confidence: 95, alternatives: ["PostgreSQL"], filesCreated: ["src/log.ts"], filesModified: [], artifactNames: ["EventLog"] }] }) + "\n```";
    const out = parseDecisionsJson(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "architecture", title: "Event-sourced log", confidence: 95, alternatives: ["PostgreSQL"] });
  });
  it("clamps confidence and defaults an unknown category to other", () => {
    const out = parseDecisionsJson(JSON.stringify({ decisions: [{ category: "wat", title: "x", reasoning: "y", confidence: 250 }] }));
    expect(out[0]).toMatchObject({ category: "other", confidence: 100 });
  });
  it("returns [] on junk", () => {
    expect(parseDecisionsJson("not json")).toEqual([]);
    expect(parseDecisionsJson("")).toEqual([]);
  });
});

describe("extractDecisionsRegex", () => {
  it("extracts an 'instead of X, I'll Y' decision with the alternative", () => {
    const out = extractDecisionsRegex("Instead of useState, I'll use React Query because it handles caching.");
    const withAlt = out.find((d) => d.alternatives.length);
    expect(withAlt?.alternatives).toContain("useState");
  });
  it("extracts an 'I'll use X because Y' decision", () => {
    const out = extractDecisionsRegex("I'll use SQLite because it ships with Node.");
    expect(out.some((d) => d.title.toLowerCase().includes("sqlite"))).toBe(true);
  });
});

describe("extractDecisions", () => {
  it("uses the Anthropic API when a key is present and returns AgentDecisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ text: JSON.stringify({ decisions: [
        { category: "design", title: "Purple-dark identity", reasoning: "brand", confidence: 91, alternatives: [], filesCreated: [], filesModified: [], artifactNames: [] },
        { category: "implementation", title: "React Query", reasoning: "caching", confidence: 86, alternatives: ["useState"], filesCreated: [], filesModified: [], artifactNames: [] },
      ] }) }] }),
    }) as unknown as Response));
    const out = await extractDecisions({ ...baseOpts, turnText: "x".repeat(200), anthropicApiKey: "sk-ant-test" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ agentId: "codex", agentRole: "builder", turnIndex: 3, tokensUsed: 1200, category: "design" });
    expect(out[0]!.id).toContain("p-main-t3");
  });

  it("falls back to regex when there is no API key", async () => {
    const out = await extractDecisions({ ...baseOpts, turnText: "Instead of Redux, I'll use Zustand because it is lighter. " + "x".repeat(120) });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.some((d) => d.alternatives.includes("Redux"))).toBe(true);
  });

  it("returns [] for a trivial turn", async () => {
    expect(await extractDecisions({ ...baseOpts, turnText: "ok, done." })).toEqual([]);
  });

  it("keeps only file claims the turn actually changed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ content: [{ text: JSON.stringify({ decisions: [
        { category: "fix", title: "Fix env", reasoning: "r", confidence: 80, alternatives: [], filesCreated: ["a.ts", "ghost.ts"], filesModified: [], artifactNames: [] },
      ] }) }] }),
    }) as unknown as Response));
    const out = await extractDecisions({ ...baseOpts, turnText: "x".repeat(200), filesChanged: ["a.ts"], anthropicApiKey: "k" });
    expect(out[0]!.filesCreated).toEqual(["a.ts"]);
  });
});

describe("decisionStats", () => {
  it("rolls up totals, avg confidence, and the critical path", () => {
    const d = (o: Partial<AgentDecision>): AgentDecision => ({
      id: "i", projectId: "p", chatId: "main", agentId: "a", agentRole: "r", timestamp: 0, turnIndex: 0, traceId: "",
      category: "other", title: "t", reasoning: "", confidence: 80, alternatives: [], filesCreated: [], filesModified: [],
      artifactNames: [], memoryKeys: [], upstreamDecisionIds: [], tokensUsed: 0, costUsd: 0, durationMs: 0, ...o,
    });
    const stats = decisionStats([
      d({ agentId: "planner", timestamp: 1, confidence: 90, category: "architecture", alternatives: ["X"] }),
      d({ agentId: "builder", timestamp: 2, confidence: 80, alternatives: ["X"] }),
      d({ agentId: "builder", timestamp: 3, confidence: 70 }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.avgConfidence).toBe(80);
    expect(stats.byAgent).toEqual({ planner: 1, builder: 2 });
    expect(stats.criticalPath).toEqual(["planner", "builder"]);
    expect(stats.topAlternatives).toContain("X");
  });
});
