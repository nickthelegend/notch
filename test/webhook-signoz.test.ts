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
