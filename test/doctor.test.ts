import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diskVerdict, projectChecks } from "../src/cli/doctor.js";
import { writeProjectConfig, writeProjectState } from "../src/core/registry.js";
import type { ProjectConfig } from "../src/types.js";
import { makeProjectDir, tmpDir } from "./helpers.js";

function statusOf(checks: ReturnType<typeof projectChecks>, name: string) {
  return checks.filter((c) => c.name === name).map((c) => c.status);
}

describe("loom doctor — project checks", () => {
  it("healthy project: everything ok", () => {
    const dir = makeProjectDir({ routes: { ship: ["planner", "executor"] } } as Partial<ProjectConfig>);
    const checks = projectChecks(dir);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.find((c) => c.name === "routes")!.detail).toContain("ship");
  });

  it("accepts a role you made up — they're names, not a menu", () => {
    // Roles went free-form, but doctor kept a planner|executor|reviewer|general
    // whitelist and hard-failed anything else. Calling an agent "architect" is
    // the whole point; doctor must not tell you your project is broken for it.
    const dir = makeProjectDir({
      agents: [
        { id: "a", kind: "echo", role: "architect" },
        { id: "b", kind: "echo", role: "the one that writes docs" },
      ],
    } as Partial<ProjectConfig>);
    const checks = projectChecks(dir);
    expect(statusOf(checks, "agents")).not.toContain("fail");
  });

  it("fails on missing config, unknown kinds, bad roles, broken routes", () => {
    const empty = tmpDir("doc-empty");
    expect(statusOf(projectChecks(empty), "project")).toEqual(["fail"]);

    const dir = tmpDir("doc-bad");
    writeProjectConfig(dir, {
      name: "bad",
      agents: [
        { id: "a", kind: "no-such-kind", role: "planner" },
        { id: "b", kind: "echo", role: "" }, // blank: nothing can target it
        { id: "b", kind: "echo", role: "executor" }, // duplicate id
      ],
      defaultAgent: "ghost",
      routes: { broken: ["nobody"] },
    });
    const checks = projectChecks(dir);
    expect(statusOf(checks, "agents")).toContain("fail");
    expect(checks.some((c) => c.detail.includes('unknown kind "no-such-kind"'))).toBe(true);
    expect(checks.some((c) => c.detail.includes("has no role"))).toBe(true);
    expect(checks.some((c) => c.detail.includes('duplicate agent id "b"'))).toBe(true);
    expect(checks.some((c) => c.detail.includes('defaultAgent "ghost"'))).toBe(true);
    expect(checks.some((c) => c.name === "routes" && c.status === "fail")).toBe(true);
  });

  it("warns on a ghost baton holder", () => {
    const dir = makeProjectDir();
    writeProjectState(dir, { holder: "deleted-agent", agents: {} });
    const checks = projectChecks(dir);
    const baton = checks.find((c) => c.name === "baton")!;
    expect(baton.status).toBe("warn");
    expect(baton.detail).toContain("deleted-agent");
  });

  it("bridges don't count as baton-capable; adapter-less projects fail", () => {
    const dir = tmpDir("doc-bridge");
    writeProjectConfig(dir, {
      name: "bridges-only",
      agents: [{ id: "ag", kind: "antigravity", role: "general" }],
    });
    fs.mkdirSync(path.join(dir, ".loom"), { recursive: true });
    const checks = projectChecks(dir);
    expect(
      checks.some((c) => c.name === "agents" && c.status === "fail" && c.detail.includes("no full-duplex")),
    ).toBe(true);
  });
});

/**
 * The disk check exists because a full disk does not announce itself.
 *
 * On this machine it took out process spawning, the container runtime and the
 * test suite one after another, and every symptom pointed elsewhere — spawn
 * failures, a graph node that exited "cleanly", dozens of test failures whose
 * files all passed in isolation. `loom doctor` said nothing, because it never
 * looked. These assert the wording of both unhappy branches, which are the two
 * nobody sees until the day they matter.
 */
describe("disk pressure", () => {
  it("passes with room to spare", () => {
    const c = diskVerdict(50 * 1024 * 1024, "/System/Volumes/Data");
    expect(c.status).toBe("ok");
    expect(c.detail).toContain("50.0 GB free");
  });

  it("warns in the band where a test run will exhaust it", () => {
    const c = diskVerdict(1.4 * 1024 * 1024, "/System/Volumes/Data");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("1.4 GB free");
    // Naming the macOS trap is the point: pruning inside Docker looks like it
    // worked and returns nothing to the host.
    expect(c.detail).toMatch(/Docker/);
  });

  it("fails below the point where spawning a process breaks", () => {
    const c = diskVerdict(300 * 1024, "/System/Volumes/Data");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("300 MB free");
    expect(c.detail).toMatch(/spawning a process/);
  });
});
