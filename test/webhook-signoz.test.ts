/**
 * Self-healing: a SigNoz alert firing for an agent posts to the webhook, and
 * Notch forces the baton off that agent onto a fallback. Metric → intervention.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir, waitUntil } from "./helpers.js";

let daemon: LoomDaemon;
let client: DaemonClient;
let baseUrl: string;
let projectId: string;

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  delete process.env.NOTCH_WEBHOOK_SECRET;
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  client = new DaemonClient(readDaemonConfig()!);
  projectId = (await client.addProject(makeProjectDir({ name: "heal" }))).project.id;
});

afterAll(async () => {
  await daemon.close();
});

describe("SigNoz alert -> baton intervention", () => {
  it("forces the baton off the failing agent onto a fallback", async () => {
    // give the failing agent the baton first (it starts unassigned)
    await client.handoff(projectId, "plannerbot");
    const holder0 = (await client.project(projectId)).project.holder;
    expect(holder0).toBe("plannerbot");

    const res = await fetch(`${baseUrl}/api/webhooks/signoz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "firing",
        alerts: [{ status: "firing", labels: { alertname: "AgentErrorRateHigh", "notch.project": "heal", "gen_ai.agent.id": holder0 } }],
      }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; actions: Array<{ action?: string }> };
    expect(j.ok).toBe(true);
    expect(j.actions[0]?.action).toMatch(/baton handed to/);

    await waitUntil(async () => (await client.project(projectId)).project.holder !== holder0, { timeoutMs: 6000 });
    const after = (await client.project(projectId)).project.holder;
    expect(after).not.toBe(holder0);

    const { events } = await client.events(projectId, undefined, 100);
    expect(events.some((e) => e.kind === "handoff" && e.payload.to === after)).toBe(true);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "signoz_intervention")).toBe(true);
  });

  it("retries the original agent when the alert resolves (pause → failover → restore)", async () => {
    await client.handoff(projectId, "plannerbot");
    expect((await client.project(projectId)).project.holder).toBe("plannerbot");

    const post = (status: string) =>
      fetch(`${baseUrl}/api/webhooks/signoz`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ alerts: [{ status, labels: { alertname: "AgentErrorRateHigh", "notch.project": "heal", "gen_ai.agent.id": "plannerbot" } }] }),
      }).then((r) => r.json() as Promise<{ actions: Array<{ action?: string }> }>);

    // firing: plannerbot is quarantined and the baton fails over
    const fired = await post("firing");
    expect(fired.actions[0]?.action).toMatch(/quarantined; baton handed to/);
    await waitUntil(async () => (await client.project(projectId)).project.holder !== "plannerbot", { timeoutMs: 6000 });
    const failedOverTo = (await client.project(projectId)).project.holder;
    expect(failedOverTo).not.toBe("plannerbot");

    // resolved: the baton is handed back to plannerbot (retry)
    const resolved = await post("resolved");
    expect(resolved.actions[0]?.action).toMatch(/baton handed back to plannerbot/);
    await waitUntil(async () => (await client.project(projectId)).project.holder === "plannerbot", { timeoutMs: 6000 });
    expect((await client.project(projectId)).project.holder).toBe("plannerbot");

    const { events } = await client.events(projectId, undefined, 100);
    expect(events.some((e) => e.kind === "status" && e.payload.state === "signoz_recovery" && e.payload.retried === true)).toBe(true);
  });

  it("a resolved alert for an agent that was never quarantined is a no-op", async () => {
    const r = await fetch(`${baseUrl}/api/webhooks/signoz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ alerts: [{ status: "resolved", labels: { "notch.project": "heal", "gen_ai.agent.id": "reviewbot" } }] }),
    });
    const j = (await r.json()) as { actions: Array<{ action?: string }> };
    expect(j.actions[0]?.action).toMatch(/was not quarantined/);
  });

  it("enforces the shared-secret gate when configured", async () => {
    process.env.NOTCH_WEBHOOK_SECRET = "s3cret";
    const res = await fetch(`${baseUrl}/api/webhooks/signoz`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    delete process.env.NOTCH_WEBHOOK_SECRET;
  });
});
