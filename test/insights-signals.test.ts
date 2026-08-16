/**
 * Log and metric read-back, against a real HydraDB node.
 *
 * This file used to test the *SQL* these functions built — the WHERE clause
 * where a missing project filter would be a leak, and the escaping that stopped
 * a search term becoming a LIKE wildcard. There is no SQL any more: the logs
 * and metrics come out of the graph through parameterised Cypher, and the
 * filtering that used to be string-built is now either a query parameter or a
 * plain array filter.
 *
 * So the tests moved with the code. What they check is unchanged in spirit —
 * a query must never cross project boundaries, filters must only apply when
 * asked for, limits must be clamped — but they check it by writing real rows
 * and reading them back rather than by asserting on a string.
 */

import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { projectGraph } from "../src/hydra/graph.js";
import { TelemetryStore } from "../src/hydra/telemetry.js";
import { fetchLogs, parseSeverities } from "../src/observability/logs-query.js";
import { expandMetricNames, fetchMetricSeries, burnSeries } from "../src/observability/insights.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  up = await hydraUp();
  if (!up) console.warn(`skipping insights tests — ${HYDRA_SKIP_MESSAGE}`);
});

async function storeFor(prefix: string): Promise<TelemetryStore> {
  const { loomDir } = isolatedProject(prefix);
  const graph = projectGraph(path.resolve(loomDir));
  await graph.open();
  return new TelemetryStore(graph);
}

/** A turn span with sensible defaults, so a test only states what it cares about. */
function turn(store: TelemetryStore, over: Partial<Parameters<TelemetryStore["recordSpan"]>[0]>) {
  store.recordSpan({
    traceId: "t".repeat(32),
    spanId: "s".repeat(16),
    ts: Date.now(),
    name: "gen_ai.agent.turn",
    ms: 1000,
    code: 0,
    msg: "",
    agent: "a1",
    ade: "echo",
    model: "m1",
    tin: 100,
    tout: 10,
    cost: 0.01,
    handoffFrom: "",
    handoffTo: "",
    ...over,
  });
}

describe("parseSeverities", () => {
  it("keeps only real severity words, case-insensitively", () => {
    expect(parseSeverities("Error, WARN")).toEqual(["error", "warn"]);
  });

  it("treats absent, empty and 'all' as no filter", () => {
    expect(parseSeverities(undefined)).toEqual([]);
    expect(parseSeverities("")).toEqual([]);
    expect(parseSeverities("all")).toEqual([]);
  });

  it("drops values that are not severities, so a typo cannot widen the query", () => {
    expect(parseSeverities("error,bogus,'; DROP")).toEqual(["error"]);
  });
});

describe("fetchLogs", () => {
  it("returns this project's lines and nobody else's", async () => {
    if (!up) return;
    const mine = await storeFor("logs-mine");
    const theirs = await storeFor("logs-theirs");
    mine.recordLog({ ts: Date.now(), level: "info", agent: "a1", body: "mine", traceId: "x", kind: "message" });
    theirs.recordLog({ ts: Date.now(), level: "info", agent: "a1", body: "theirs", traceId: "y", kind: "message" });
    await Promise.all([mine.flush(), theirs.flush()]);

    const rows = await fetchLogs(mine);
    expect(rows.map((r) => r.body)).toContain("mine");
    expect(rows.map((r) => r.body)).not.toContain("theirs");
  });

  it("filters by severity, by agent, and by substring — only when asked", async () => {
    if (!up) return;
    const s = await storeFor("logs-filter");
    const now = Date.now();
    s.recordLog({ ts: now, level: "error", agent: "a1", body: "disk on fire", traceId: "t1", kind: "error" });
    s.recordLog({ ts: now, level: "info", agent: "a1", body: "all quiet", traceId: "t1", kind: "message" });
    s.recordLog({ ts: now, level: "info", agent: "a2", body: "other agent", traceId: "t2", kind: "message" });
    await s.flush();

    expect((await fetchLogs(s)).length).toBe(3);
    expect((await fetchLogs(s, { severity: "error" })).map((r) => r.body)).toEqual(["disk on fire"]);
    expect((await fetchLogs(s, { agent: "a2" })).map((r) => r.body)).toEqual(["other agent"]);
    expect((await fetchLogs(s, { search: "FIRE" })).map((r) => r.body)).toEqual(["disk on fire"]);
    expect((await fetchLogs(s, { traceId: "t2" })).map((r) => r.body)).toEqual(["other agent"]);
  });

  it("accepts several severities at once", async () => {
    if (!up) return;
    const s = await storeFor("logs-multi");
    const now = Date.now();
    s.recordLog({ ts: now, level: "error", agent: "a", body: "e", traceId: "", kind: "error" });
    s.recordLog({ ts: now, level: "warn", agent: "a", body: "w", traceId: "", kind: "status" });
    s.recordLog({ ts: now, level: "info", agent: "a", body: "i", traceId: "", kind: "message" });
    await s.flush();

    const rows = await fetchLogs(s, { severity: "error,warn" });
    expect(rows.map((r) => r.body).sort()).toEqual(["e", "w"]);
  });

  it("clamps the limit into 1..1000 and defaults to 200", async () => {
    if (!up) return;
    const s = await storeFor("logs-limit");
    for (let i = 0; i < 5; i++) {
      s.recordLog({ ts: Date.now() + i, level: "info", agent: "a", body: `l${i}`, traceId: "", kind: "message" });
    }
    await s.flush();
    expect((await fetchLogs(s, { limit: 2 })).length).toBe(2);
    expect((await fetchLogs(s, { limit: 0 })).length).toBeGreaterThan(0);
    expect((await fetchLogs(s, { limit: 99_999 })).length).toBe(5);
  });

  it("carries severity, trace and kind through, and never invents a span id", async () => {
    if (!up) return;
    const s = await storeFor("logs-shape");
    s.recordLog({ ts: Date.now(), level: "warn", agent: "a1", body: "careful", traceId: "abc", kind: "status" });
    await s.flush();
    const [row] = await fetchLogs(s);
    expect(row!.severity).toBe("WARN");
    expect(row!.severityNumber).toBe(13);
    expect(row!.traceId).toBe("abc");
    expect(row!.kind).toBe("status");
    // A log line is emitted by an event; only some events produce a span. An
    // invented span id would render as a link to nothing.
    expect(row!.spanId).toBe("");
  });
});

describe("expandMetricNames", () => {
  it("keeps only metrics that can actually be derived from a turn span", () => {
    expect(expandMetricNames(["notch.turns", "not.a.metric"])).toEqual(["notch.turns"]);
  });

  it("falls back to every known metric when nothing valid was asked for", () => {
    const all = expandMetricNames([]);
    expect(all).toContain("notch.turns");
    expect(all).toContain("notch.cost.usd");
    expect(all).toContain("gen_ai.client.token.usage");
  });
});

describe("fetchMetricSeries", () => {
  it("derives one series per metric per agent, from the turn spans themselves", async () => {
    if (!up) return;
    const s = await storeFor("metrics");
    turn(s, { agent: "a1", cost: 0.02, tin: 100, tout: 10, ms: 1000 });
    turn(s, { agent: "a1", cost: 0.03, tin: 200, tout: 20, ms: 3000 });
    turn(s, { agent: "a2", cost: 0.05, tin: 50, tout: 5, ms: 500 });
    await s.flush();

    const series = await fetchMetricSeries(s, ["notch.turns", "notch.cost.usd"]);
    const turnsA1 = series.find((x) => x.metric === "notch.turns" && x.labels["gen_ai.agent.id"] === "a1");
    const costA1 = series.find((x) => x.metric === "notch.cost.usd" && x.labels["gen_ai.agent.id"] === "a1");
    const costA2 = series.find((x) => x.metric === "notch.cost.usd" && x.labels["gen_ai.agent.id"] === "a2");

    expect(turnsA1!.points.reduce((a, p) => a + p.sum, 0)).toBe(2);
    expect(costA1!.points.reduce((a, p) => a + p.sum, 0)).toBeCloseTo(0.05, 6);
    expect(costA2!.points.reduce((a, p) => a + p.sum, 0)).toBeCloseTo(0.05, 6);
  });

  it("marks a duration metric as one to average rather than sum", async () => {
    if (!up) return;
    const s = await storeFor("metrics-prefer");
    turn(s, { agent: "a1", ms: 1000 });
    turn(s, { agent: "a1", ms: 3000 });
    await s.flush();
    const [dur] = await fetchMetricSeries(s, ["gen_ai.client.operation.duration"]);
    expect(dur!.prefer).toBe("avg");
    expect(dur!.points[0]!.avg).toBe(2000);
    expect(dur!.points[0]!.max).toBe(3000);
    expect(dur!.points[0]!.n).toBe(2);
  });

  it("returns nothing rather than a flat zero line when there are no turns", async () => {
    if (!up) return;
    const s = await storeFor("metrics-empty");
    expect(await fetchMetricSeries(s, ["notch.turns"])).toEqual([]);
  });
});

describe("burnSeries", () => {
  it("buckets real per-agent cost and projects a 24h rate", async () => {
    if (!up) return;
    const s = await storeFor("burn");
    turn(s, { agent: "a1", cost: 0.25 });
    turn(s, { agent: "a2", cost: 0.75 });
    await s.flush();

    const burn = await burnSeries(s, { hours: 24, buckets: 12 });
    expect(burn.totalUsd).toBeCloseTo(1.0, 6);
    expect(burn.ratePerHour).toBeCloseTo(1.0 / 24, 6);
    expect(burn.projected24h).toBeCloseTo(1.0, 6);
    const agents = burn.buckets.flatMap((b) => Object.keys(b.byAgent));
    expect(new Set(agents)).toEqual(new Set(["a1", "a2"]));
  });
});
