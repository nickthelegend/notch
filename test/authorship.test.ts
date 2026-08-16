/**
 * Which agent gets credited for which file, in which commit.
 *
 * `attribute()` is pure, so these are exact rather than approximate: given
 * these turns and these commits, exactly this attribution. The case that
 * matters most is two agents committing minutes apart — the first version of
 * the join answered "the last turn before this commit, plus 120s of slack",
 * and that window reached over the *next* commit and handed every commit to
 * whoever had gone last. It was invisible with one agent, which is how it
 * survived.
 */

import { describe, expect, it } from "vitest";
import { attribute } from "../src/core/authorship.js";
import type { Commit } from "../src/core/git.js";
import type { LoomEvent } from "../src/types.js";

const T0 = 1_700_000_000_000;

function commit(sha: string, ts: number, subject = sha): Commit {
  return { sha, short: sha.slice(0, 7), subject, author: "you", relative: "just now", ts };
}

function turn(id: number, agentId: string, ts: number, files: string[]): LoomEvent {
  return {
    id,
    ts,
    kind: "turn_diff",
    agentId,
    payload: { files: files.map((path) => ({ path, status: "M" })) },
  } as LoomEvent;
}

describe("commit authorship", () => {
  it("credits each commit to the turn that produced it, not to whoever went last", () => {
    // claude-code's turn, then a commit; codex's turn, then a commit — eight
    // seconds apart, which is normal for a fleet and fatal for a slack window.
    const commits = [
      commit("bbbb", T0 + 20_000, "docs: comment the helper"),
      commit("aaaa", T0 + 10_000, "feat: add a twice helper"),
    ];
    const events = [
      turn(1, "claude-code", T0 + 9_000, ["src/index.ts"]),
      turn(2, "codex", T0 + 18_000, ["src/index.ts"]),
    ];
    const changed = new Map([
      ["aaaa", ["src/index.ts"]],
      ["bbbb", ["src/index.ts"]],
    ]);

    const out = attribute(commits, events, changed);
    const bySha = new Map(out.map((c) => [c.sha, c]));
    expect(bySha.get("aaaa")!.files[0]!.agent).toBe("claude-code");
    expect(bySha.get("bbbb")!.files[0]!.agent).toBe("codex");
    // And the event id is the hop back into the log, not a guess.
    expect(bySha.get("aaaa")!.files[0]!.eventId).toBe(1);
  });

  it("leaves a file no turn accounts for as a hand edit", () => {
    const commits = [commit("aaaa", T0 + 10_000)];
    const out = attribute(commits, [], new Map([["aaaa", ["README.md"]]]));
    expect(out[0]!.files[0]!.agent).toBeNull();
    expect(out[0]!.humanFiles).toBe(1);
    expect(out[0]!.agents).toEqual([]);
  });

  it("still credits a turn whose diff event landed just after the commit", () => {
    // turn_diff is appended asynchronously, so its timestamp can trail the
    // commit that contains its work. That is what the slack is for — and the
    // only thing it is for.
    const commits = [commit("aaaa", T0 + 10_000)];
    const events = [turn(1, "codex", T0 + 11_500, ["src/index.ts"])];
    const out = attribute(commits, events, new Map([["aaaa", ["src/index.ts"]]]));
    expect(out[0]!.files[0]!.agent).toBe("codex");
  });

  it("does not credit a turn that happened long after the last commit", () => {
    // Work in the tree that nobody has committed yet belongs to no commit.
    const commits = [commit("aaaa", T0 + 10_000)];
    const events = [turn(1, "codex", T0 + 10_000 + 200_000, ["src/index.ts"])];
    const out = attribute(commits, events, new Map([["aaaa", ["src/index.ts"]]]));
    expect(out[0]!.files[0]!.agent).toBeNull();
  });

  it("counts files per agent and keeps the busiest first", () => {
    const commits = [commit("aaaa", T0 + 10_000)];
    const events = [
      turn(1, "codex", T0 + 9_000, ["a.ts", "b.ts"]),
      turn(2, "claude-code", T0 + 9_500, ["c.ts"]),
    ];
    const out = attribute(commits, events, new Map([["aaaa", ["a.ts", "b.ts", "c.ts", "d.ts"]]]));
    expect(out[0]!.agents).toEqual([
      { agent: "codex", files: 2 },
      { agent: "claude-code", files: 1 },
    ]);
    expect(out[0]!.humanFiles).toBe(1);
  });

  it("keeps the caller's ordering, newest first", () => {
    const commits = [commit("bbbb", T0 + 20_000), commit("aaaa", T0 + 10_000)];
    const out = attribute(commits, [], new Map());
    expect(out.map((c) => c.sha)).toEqual(["bbbb", "aaaa"]);
  });
});
