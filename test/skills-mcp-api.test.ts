/**
 * The composer's backend surface, over a real daemon: skills enable + injection,
 * MCP persistence, and that AUTO mode drives the dynamic router.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDaemonConfig, readProjectConfig } from "../src/core/registry.js";
import { DaemonClient } from "../src/daemon/client.js";
import { LoomDaemon } from "../src/daemon/server.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

let daemon: LoomDaemon;
let baseUrl: string;
let token: string;
let projectId: string;
let projectDir: string;

const H = () => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

beforeAll(async () => {
  process.env.LOOM_HOME = tmpDir("home");
  process.env.LOOM_NO_NOTIFY = "1";
  daemon = new LoomDaemon({ host: "127.0.0.1", port: 0 });
  const { host, port } = await daemon.listen();
  baseUrl = `http://${host}:${port}`;
  token = readDaemonConfig()!.adminToken;
  const client = new DaemonClient(readDaemonConfig()!);
  projectDir = makeProjectDir({ name: "composer" });
  projectId = (await client.addProject(projectDir)).project.id;
});
afterAll(async () => { await daemon.close(); });

describe("skills API", () => {
  it("lists the bundled skills and enables one, persisting to config.json", async () => {
    const list = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills`, { headers: H() })).json()) as { skills: Array<{ id: string; enabled: boolean }> };
    expect(list.skills.length).toBeGreaterThan(0);
    const id = list.skills[0]!.id;
    expect(list.skills[0]!.enabled).toBe(false); // off by default

    const put = await fetch(`${baseUrl}/api/projects/${projectId}/skills/${id}`, { method: "PUT", headers: H(), body: JSON.stringify({ enabled: true }) });
    expect(put.status).toBe(200);

    const after = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills`, { headers: H() })).json()) as { skills: Array<{ id: string; enabled: boolean }> };
    expect(after.skills.find((s) => s.id === id)!.enabled).toBe(true);
    expect(readProjectConfig(projectDir)!.skills?.[id]).toBe(true);
  });

  it("suggests a disabled skill from a keyword in the message", async () => {
    // suggestions only surface skills that are OFF, so make sure the triage skill is off.
    const list = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills`, { headers: H() })).json()) as { skills: Array<{ id: string }> };
    const triage = list.skills.find((s) => /triage/.test(s.id))!;
    await fetch(`${baseUrl}/api/projects/${projectId}/skills/${triage.id}`, { method: "PUT", headers: H(), body: JSON.stringify({ enabled: false }) });
    const r = (await (await fetch(`${baseUrl}/api/projects/${projectId}/skills?suggest=${encodeURIComponent("why is my agent failing")}`, { headers: H() })).json()) as { suggestion: { id: string } | null };
    expect(r.suggestion?.id).toMatch(/triage/);
  });
});

describe("MCP API", () => {
  it("returns the built-ins and persists an upserted server", async () => {
    const list = (await (await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { headers: H() })).json()) as { mcps: Array<{ name: string; url?: string }> };
    expect(list.mcps.map((m) => m.name)).toEqual(expect.arrayContaining(["GitHub", "SigNoz", "Slack"]));

    const patch = await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { method: "PATCH", headers: H(), body: JSON.stringify({ mcp: { name: "SigNoz", url: "http://localhost:8000/mcp", enabledForSession: true } }) });
    expect(patch.status).toBe(200);

    const after = (await (await fetch(`${baseUrl}/api/projects/${projectId}/mcps`, { headers: H() })).json()) as { mcps: Array<{ name: string; url?: string }> };
    expect(after.mcps.find((m) => m.name === "SigNoz")!.url).toBe("http://localhost:8000/mcp");
    expect(readProjectConfig(projectDir)!.mcps?.some((m) => m.name === "SigNoz" && m.url)).toBe(true);
  });
});

describe("AUTO mode routing", () => {
  it("starting a route with spec 'auto' runs the dynamic router", async () => {
    const res = await fetch(`${baseUrl}/api/projects/${projectId}/route`, { method: "POST", headers: H(), body: JSON.stringify({ task: "add a health endpoint with tests", spec: "auto" }) });
    expect(res.status).toBe(200);
    const { route } = (await res.json()) as { route: { name?: string; mode?: string; status?: string } };
    expect(route.name).toBe("auto"); // the dynamic router, not a named pipeline
  });
});
