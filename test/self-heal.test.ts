/**
 * Self-healing: HydraDB's own signals take a sick agent out of rotation.
 *
 * This suite used to POST an Alertmanager payload at a webhook and assert that
 * Notch reacted. That webhook is gone with the second telemetry store: the
 * spans and the fencing violations are in the same graph as the events, so
 * Notch reads its own evidence on a timer instead of waiting to be told. The
 * behaviour under test is unchanged — a failing agent is paused, the baton
 * fails over, the pause is enforced, and it lifts itself when the agent
 * recovers — but every input is now real. There is no synthetic alert to post:
 * the errors come from turns that genuinely failed, and the fenced write comes
 * from a real stale-epoch `assertWriter` call.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { HEAL_THRESHOLDS, LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";
import { hydraUp, HYDRA_SKIP_MESSAGE } from "./hydra-helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let token: string;
let up = false;

beforeAll(async () => {
  up = await hydraUp();
  if (!up) {
    console.warn(`skipping self-heal tests — ${HYDRA_SKIP_MESSAGE}`);
    return;
  }
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  // The evidence self-heal acts on IS the telemetry, so this suite pays for it.
  delete process.env.NOTCH_TELEMETRY_DISABLED;
  // The periodic watcher stays off: these tests drive evaluation explicitly so
  // a background pass cannot land in the middle of an assertion. The per-agent
  // recheck loop reads the same switch at quarantine time, and the one test
  // that wants it turns it on for itself.
  process.env.NOTCH_HEAL_DISABLED = "1";

  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  client = new DaemonClient(readDaemonConfig()!);
});

afterAll(async () => {
  if (!up) return;
  await daemon.close();
  delete process.env.NOTCH_HEAL_DISABLED;
  process.env.NOTCH_TELEMETRY_DISABLED = "1";
});

afterEach(() => {
  // Any test that enabled the recheck loop leaves it off again, whether it
  // passed or threw — a loop still running under the next test would hand a
  // baton back mid-assertion.
  process.env.NOTCH_HEAL_DISABLED = "1";
  delete process.env.NOTCH_HEAL_RECHECK_MS;
  delete process.env.NOTCH_HEAL_MAX_RETRIES;
});

/** A project of its own, so one test's quarantine cannot reach another's. */
async function project(name: string): Promise<string> {
  return (await client.addProject(makeProjectDir({ name }))).project.id;
}

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

type HealAction = { agent?: string; reason?: string; action?: string; errors?: number; fenced?: number };

async function evaluate(id: string): Promise<HealAction[]> {
  const r = await api(`/api/projects/${id}/heal/evaluate`, { method: "POST" });
  expect(r.status).toBe(200);
  return ((await r.json()) as { actions: HealAction[] }).actions;
}

async function health(id: string): Promise<{
  quarantine: Record<string, { reason: string; since: number; displaced: boolean }>;
  thresholds: typeof HEAL_THRESHOLDS;
  agents: Array<{ agent: string; errors: number; fenced: number; paused: boolean }>;
}> {
  const r = await api(`/api/projects/${id}/heal`);
  expect(r.status).toBe(200);
  return r.json() as never;
}

/** Drive a turn that genuinely fails, and wait for the error to be logged. */
async function failTurn(id: string, agentId: string, why: string): Promise<void> {
  const before = (await client.events(id, undefined, 300)).events.filter((e) => e.kind === "error").length;
  await client.send(id, `fail: ${why}`, agentId);
  await waitUntil(
    async () => (await client.events(id, undefined, 300)).events.filter((e) => e.kind === "error").length > before,
    { timeoutMs: 15_000 },
  );
}

/**
 * Poll evaluation until it acts on `agent`.
 *
 * The wait is for the span batch to reach HydraDB, not for the daemon to make
 * up its mind: `evaluateHealth` counts error spans with a `strong` read, and
 * the fold batches. Polling the real endpoint keeps the test on the public
 * surface rather than reaching in to flush the store.
 */
async function waitForAction(id: string, agent: string, re: RegExp): Promise<HealAction> {
  let last: HealAction | undefined;
  await waitUntil(async () => {
    last = (await evaluate(id)).find((a) => a.agent === agent && re.test(String(a.action ?? "")));
    return Boolean(last);
  }, { timeoutMs: 20_000, intervalMs: 250 });
  return last!;
}

describe("error spans in HydraDB pause an agent and move the baton", () => {
  it("counts real failed turns and quarantines over the threshold", async () => {
    if (!up) return;
    const id = await project("heal-errors");
    await client.handoff(id, "plannerbot");
    expect((await client.project(id)).project.holder).toBe("plannerbot");

    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `boom ${i}`);

    const acted = await waitForAction(id, "plannerbot", /quarantined; baton handed to/);
    expect(acted.reason).toMatch(/error\(s\) in 10m/);

    // The baton moved off the sick agent, and the move is in the log with the
    // reason — a pause nobody can explain afterwards is not an intervention.
    await waitUntil(async () => (await client.project(id)).project.holder === "execbot", { timeoutMs: 10_000 });
    const { events } = await client.events(id, undefined, 300);
    const intervention = events.find(
      (e) => e.kind === "status" && (e.payload as Record<string, unknown>).state === "heal_intervention",
    );
    expect(intervention).toBeTruthy();
    expect((intervention!.payload as Record<string, unknown>).fallback).toBe("execbot");
    expect(events.some((e) => e.kind === "handoff" && (e.payload as Record<string, unknown>).to === "execbot")).toBe(true);
  }, 90_000);

  it("stays quiet below the threshold", async () => {
    if (!up) return;
    const id = await project("heal-under");
    await failTurn(id, "plannerbot", "one-off");

    // One error is not a pattern. Evaluate repeatedly for as long as it takes
    // the span to land, and assert the verdict never becomes a quarantine.
    await waitUntil(async () => (await health(id)).agents.some((a) => a.agent === "plannerbot" && a.errors >= 1), {
      timeoutMs: 20_000,
      intervalMs: 250,
    });
    const actions = await evaluate(id);
    expect(actions.find((a) => a.agent === "plannerbot")?.action).toBe("healthy");
    expect((await health(id)).quarantine).toEqual({});
  }, 60_000);

  it("reports the counts and the thresholds it judged them against", async () => {
    if (!up) return;
    const id = await project("heal-report");
    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `bad ${i}`);
    await waitForAction(id, "plannerbot", /quarantined/);

    const h = await health(id);
    expect(h.thresholds).toEqual(HEAL_THRESHOLDS);
    const row = h.agents.find((a) => a.agent === "plannerbot")!;
    expect(row.errors).toBeGreaterThanOrEqual(HEAL_THRESHOLDS.errors);
    expect(row.paused).toBe(true);
    expect(h.quarantine["plannerbot"]?.reason).toMatch(/error\(s\)/);
    expect(h.agents.find((a) => a.agent === "execbot")?.paused).toBe(false);
  }, 90_000);
});

describe("a paused agent is actually refused work", () => {
  it("refuses the baton while paused, and takes it again once lifted", async () => {
    if (!up) return;
    const id = await project("heal-enforce");
    // The failing agent has to hold the baton to take turns at all, so the
    // quarantine also fails the baton over to execbot.
    await client.handoff(id, "plannerbot");
    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `sick ${i}`);
    await waitForAction(id, "plannerbot", /quarantined/);
    await waitUntil(async () => (await client.project(id)).project.holder === "execbot", { timeoutMs: 10_000 });

    // This is the bug the feature had when the pause was written to state and
    // nothing read it back: the agent kept taking work and the pause was
    // cosmetic.
    const refused = await api(`/api/projects/${id}/handoff`, {
      method: "POST",
      body: JSON.stringify({ to: "plannerbot" }),
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; agentId: string };
    expect(body.error).toBe("agent_quarantined");
    expect(body.agentId).toBe("plannerbot");

    // The operator override, for a threshold set too tight.
    const lifted = await api(`/api/projects/${id}/quarantine/plannerbot`, { method: "DELETE" });
    expect(lifted.status).toBe(200);
    expect((await health(id)).quarantine["plannerbot"]).toBeUndefined();
    const { events } = await client.events(id, undefined, 300);
    expect(
      events.some(
        (e) =>
          e.kind === "status" &&
          (e.payload as Record<string, unknown>).state === "heal_recovery" &&
          (e.payload as Record<string, unknown>).via === "manual",
      ),
    ).toBe(true);

    const ok = await api(`/api/projects/${id}/handoff`, { method: "POST", body: JSON.stringify({ to: "plannerbot" }) });
    expect(ok.status).toBe(200);
  }, 90_000);

  it("404s a lift for an agent that was never paused", async () => {
    if (!up) return;
    const id = await project("heal-nolift");
    const r = await api(`/api/projects/${id}/quarantine/plannerbot`, { method: "DELETE" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/not paused/);
  }, 30_000);
});

describe("a fenced write is enough on its own", () => {
  it("pauses an agent that wrote with a stale epoch", async () => {
    if (!up) return;
    const id = await project("heal-fence");
    await client.handoff(id, "plannerbot");

    // A real stale-epoch write through the same gate every baton-authorized
    // action goes through — not a synthesized violation row.
    const drill = await api(`/api/projects/${id}/graph/fence-drill`, {
      method: "POST",
      body: JSON.stringify({ agent: "plannerbot" }),
    });
    expect(drill.status).toBe(200);
    expect(((await drill.json()) as { fenced: boolean }).fenced).toBe(true);

    const acted = await waitForAction(id, "plannerbot", /quarantined/);
    expect(acted.reason).toMatch(/fenced write\(s\) in 10m/);
    expect((await health(id)).agents.find((a) => a.agent === "plannerbot")!.fenced).toBeGreaterThanOrEqual(
      HEAL_THRESHOLDS.fencing,
    );
  }, 60_000);
});

describe("the recheck loop puts a recovered agent back", () => {
  it("lifts the pause and hands the baton back when the errors stop", async () => {
    if (!up) return;
    const id = await project("heal-recheck");
    await client.handoff(id, "plannerbot");
    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `flap ${i}`);

    // Arm the loop only now, so it is created by *this* quarantine.
    //
    // The interval has to exceed *this test's own* round trip, not just the
    // daemon's. The failover is observed by polling `/heal/evaluate`, and one
    // evaluation is several `strong` reads against HydraDB — under a loaded
    // suite that can take longer than a second. At 900ms the recheck sometimes
    // handed the baton back before the test had looked, so the intermediate
    // state this test exists to observe was gone unseen and it failed roughly
    // one run in five. 4s is comfortably longer than a poll and still short
    // enough to watch.
    process.env.NOTCH_HEAL_RECHECK_MS = "4000";
    process.env.NOTCH_HEAL_MAX_RETRIES = "5";
    delete process.env.NOTCH_HEAL_DISABLED;

    await waitForAction(id, "plannerbot", /quarantined; baton handed to/);
    await waitUntil(async () => (await client.project(id)).project.holder === "execbot", { timeoutMs: 15_000 });

    // No new failures since the pause, so the next recheck releases it. Wait
    // for the *event*: the recovery line is appended after the hand-back
    // returns, so a holder that has already moved does not mean the record of
    // why has been written yet.
    await waitUntil(async () => (await client.project(id)).project.holder === "plannerbot", { timeoutMs: 30_000 });
    await waitUntil(
      async () =>
        (await client.events(id, undefined, 400)).events.some(
          (e) =>
            e.kind === "status" &&
            (e.payload as Record<string, unknown>).state === "heal_recovery" &&
            (e.payload as Record<string, unknown>).via === "recheck" &&
            (e.payload as Record<string, unknown>).retried === true,
        ),
      { timeoutMs: 10_000 },
    );
    expect((await health(id)).quarantine).toEqual({});
  }, 120_000);
});

describe("a release is a clean slate", () => {
  it("does not re-pause an agent on the same failures it was already released for", async () => {
    if (!up) return;
    const id = await project("heal-noflap");
    await client.handoff(id, "plannerbot");
    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `flap ${i}`);
    await waitForAction(id, "plannerbot", /quarantined/);

    // Lift it by hand. The errors are still well inside the 10m window, so a
    // watcher that judged on the window alone would pause it again on the very
    // next pass — a flap every interval until the window rolled off, and one
    // failure rendered as an episode per minute.
    const lifted = await api(`/api/projects/${id}/quarantine/plannerbot`, { method: "DELETE" });
    expect(lifted.status).toBe(200);

    const actions = await evaluate(id);
    expect(actions.find((a) => a.agent === "plannerbot")?.action).toBe("healthy");
    expect(actions.find((a) => a.agent === "plannerbot")?.errors).toBe(0);
    expect((await health(id)).quarantine).toEqual({});

    // A *new* failure after the release still counts, and still pauses it. The
    // quarantine failed the baton over, so hand it back before it can take a turn.
    await client.handoff(id, "plannerbot");
    for (let i = 0; i < HEAL_THRESHOLDS.errors; i++) await failTurn(id, "plannerbot", `again ${i}`);
    await waitForAction(id, "plannerbot", /quarantined/);
    expect((await health(id)).quarantine["plannerbot"]).toBeTruthy();
  }, 120_000);
});
