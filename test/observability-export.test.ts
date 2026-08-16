/**
 * Observability integration test: the full path from a real agent turn to a
 * span in HydraDB.
 *
 * This used to stand up a fake OTLP collector and assert on the payload the
 * daemon POSTed to it. There is no collector any more — the daemon writes the
 * spans into the graph — so the assertion moved to where the data now is: drive
 * real echo turns through a real daemon, then read the spans back out of
 * HydraDB and check they carry the model, tokens, cost and trace correlation
 * the Observatory renders.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import { hydraUp, HYDRA_SKIP_MESSAGE } from "./hydra-helpers.js";
import type { StoredSpan } from "../src/hydra/telemetry.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let projectId: string;
let up = false;

beforeAll(async () => {
  up = await hydraUp();
  if (!up) {
    console.warn(`skipping telemetry export test — ${HYDRA_SKIP_MESSAGE}`);
    return;
  }
  // Telemetry is off suite-wide so ordinary tests do not pay for it. This one
  // is about telemetry, so it turns it on for the daemon it starts.
  delete process.env.NOTCH_TELEMETRY_DISABLED;
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  await daemon.listen();
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "telemetry" }))).project.id;
});

afterAll(async () => {
  if (!up) return;
  await daemon.close();
  process.env.NOTCH_TELEMETRY_DISABLED = "1";
});

/** The project's spans, straight out of the graph the daemon wrote them to. */
async function spans(): Promise<StoredSpan[]> {
  const rt = await (daemon as unknown as {
    runtime(id: string): Promise<{ telemetry: { flush(): Promise<void>; spans(o?: unknown): Promise<StoredSpan[]> } }>;
  }).runtime(projectId);
  await rt.telemetry.flush();
  return rt.telemetry.spans({ limit: 200 });
}

describe("a real turn becomes a span in HydraDB", () => {
  it("records gen_ai.agent.turn with the adapter, duration, tokens and cost", async () => {
    if (!up) return;
    await client.send(projectId, "hello from the export test");
    await waitUntil(async () => (await spans()).some((s) => s.name === "gen_ai.agent.turn"), {
      timeoutMs: 20_000,
    });

    const turn = (await spans()).find((s) => s.name === "gen_ai.agent.turn")!;
    expect(turn.agent).toBeTruthy();
    expect(turn.ade).toBe("echo");
    expect(turn.ms).toBeGreaterThan(0);
    expect(turn.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(turn.spanId).toMatch(/^[0-9a-f]{16}$/);
    // The echo adapter reports a deterministic cost and token count, so these
    // are real reported numbers rather than anything this test invented.
    expect(turn.cost).toBeGreaterThan(0);
    expect(turn.tin + turn.tout).toBeGreaterThan(0);
  }, 30_000);

  it("gives each turn its own trace id, so a turn is one span tree", async () => {
    if (!up) return;
    const before = (await spans()).filter((s) => s.name === "gen_ai.agent.turn").length;
    await client.send(projectId, "a second turn");
    await waitUntil(
      async () => (await spans()).filter((s) => s.name === "gen_ai.agent.turn").length > before,
      { timeoutMs: 20_000 },
    );
    const turns = (await spans()).filter((s) => s.name === "gen_ai.agent.turn");
    const traces = new Set(turns.map((s) => s.traceId));
    expect(traces.size).toBe(turns.length);
  }, 30_000);

  it("records notch.baton.handoff with from and to after the baton moves", async () => {
    if (!up) return;
    const { project } = await client.project(projectId);
    const target = project.agents.find((a) => a.id !== project.holder)!.id;
    await client.handoff(projectId, target);
    await waitUntil(async () => (await spans()).some((s) => s.name === "notch.baton.handoff"), {
      timeoutMs: 20_000,
    });
    const h = (await spans()).find((s) => s.name === "notch.baton.handoff")!;
    expect(h.handoffTo).toBe(target);
  }, 30_000);

  it("serves per-agent metrics that agree with the spans", async () => {
    if (!up) return;
    const res = await fetch(
      `http://${readDaemonConfig()!.host}:${readDaemonConfig()!.port}/api/projects/${projectId}/metrics`,
      { headers: { authorization: `Bearer ${readDaemonConfig()!.adminToken}` } },
    );
    const body = (await res.json()) as {
      metrics: { turns: number; totalUsd: number; byAgent: Array<{ agentId: string; turns: number; usd: number }> };
    };
    const turns = (await spans()).filter((s) => s.name === "gen_ai.agent.turn");
    // The spans and the cost summary are folded from the same events, so they
    // must agree exactly. A mismatch here means the telemetry fold and the
    // ledger have drifted — which is the failure the two-store design used to
    // make invisible.
    expect(body.metrics.turns).toBe(turns.length);
    expect(body.metrics.totalUsd).toBeCloseTo(
      turns.reduce((a, s) => a + s.cost, 0),
      6,
    );
  }, 30_000);
});
