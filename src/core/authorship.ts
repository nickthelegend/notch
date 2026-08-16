/**
 * Which agent changed what, per commit.
 *
 * Git knows a commit touched `src/auth/session.ts`. It does not know that
 * `codex` wrote that hunk at 14:02 and `claude-code` rewrote it at 14:19 — git
 * records the human who ran `commit`, and on a fleet that is the same name for
 * every line. The information exists, though: Notch already logs a `turn_diff`
 * per agent turn, listing exactly which files that turn changed. So authorship
 * is a **join**, not a guess.
 *
 * The join, precisely: a file in a commit is credited to the last agent whose
 * `turn_diff` touched that same path at or before the commit's timestamp, and
 * after the previous commit that touched it. A file no turn ever touched is
 * yours — you edited it by hand — and says so rather than being attributed to
 * whoever happened to be holding the baton.
 *
 * This is what makes the history a time machine rather than a log: every commit
 * can be read back as "these three files, by these two agents, out of these
 * turns", and each turn is one hop from the memory it produced.
 */

import { log as gitLog, type Commit } from "./git.js";
import type { LoomEvent } from "../types.js";

export interface FileAuthorship {
  path: string;
  /** The agent whose turn last touched this file before the commit, or null for a human edit. */
  agent: string | null;
  /** The event id of the turn_diff that credited it — the hop back into the log. */
  eventId: number | null;
  /** When that turn landed. */
  at: number | null;
}

export interface AuthoredCommit extends Commit {
  files: FileAuthorship[];
  /** Distinct agents with at least one file in this commit, most files first. */
  agents: Array<{ agent: string; files: number }>;
  /** Files nobody's turn accounts for — hand edits. */
  humanFiles: number;
}

/** The paths one `turn_diff` event touched, in whatever shape it was stored. */
function pathsOf(e: LoomEvent): string[] {
  const raw = (e.payload.files as Array<string | { path?: string }> | undefined) ?? [];
  return raw
    .map((f) => (typeof f === "string" ? f : (f?.path ?? "")))
    .map((p) => String(p).trim())
    .filter(Boolean);
}

/**
 * Attribute every file of every commit to the agent turn that produced it.
 *
 * `changedFiles` is injected rather than shelled out to here so the caller can
 * batch one `git show` per commit — this function stays pure and testable.
 */
export function attribute(
  commits: Commit[],
  events: LoomEvent[],
  changedFiles: Map<string, string[]>,
): AuthoredCommit[] {
  // Turns that changed files, oldest first, flattened to (path, agent, ts).
  const touches: Array<{ path: string; agent: string; at: number; id: number }> = [];
  for (const e of events) {
    if (e.kind !== "turn_diff" || !e.agentId) continue;
    for (const path of pathsOf(e)) {
      touches.push({ path, agent: e.agentId, at: e.ts, id: e.id });
    }
  }
  touches.sort((a, b) => a.at - b.at);

  const ordered = [...commits].sort((a, b) => a.ts - b.ts);

  // Which commits, oldest first, contain each path. A turn's work lands in the
  // *first* commit after it, so this is the list that has to be searched.
  const commitsFor = new Map<string, Array<{ sha: string; ts: number }>>();
  for (const c of ordered) {
    for (const path of changedFiles.get(c.sha) ?? []) {
      const list = commitsFor.get(path) ?? [];
      list.push({ sha: c.sha, ts: c.ts });
      commitsFor.set(path, list);
    }
  }

  /**
   * Assign every turn to exactly one commit: the first one at or after it.
   *
   * Going the other way — asking each commit for "the last turn before me" —
   * is what the first version did, and it is wrong whenever two commits land
   * close together. With a slack window on the upper bound, an *earlier*
   * commit's window still reaches over the later commit and swallows a turn
   * that had not happened yet, so the newest agent gets credited for
   * everything. Measured: two agents, four commits eight seconds apart, and
   * all four came back attributed to whoever went last.
   *
   * The slack is still needed, but only at the tail: `turn_diff` is appended
   * asynchronously, so its timestamp can land a moment *after* the commit that
   * contains its work. That case is "no commit at or after this turn" — and
   * only then does the last commit claim it.
   */
  const creditedBy = new Map<string, { agent: string; id: number; at: number }>();
  const key = (sha: string, path: string) => `${sha}\u0000${path}`;
  for (const t of touches) {
    const list = commitsFor.get(t.path);
    if (!list || !list.length) continue;
    let target = list.find((c) => c.ts >= t.at);
    if (!target) {
      const last = list[list.length - 1]!;
      if (t.at - last.ts > 120_000) continue; // committed long before this turn
      target = last;
    }
    // Later turn wins the same slot: it is the state the commit captured.
    creditedBy.set(key(target.sha, t.path), { agent: t.agent, id: t.id, at: t.at });
  }

  const out = new Map<string, AuthoredCommit>();

  for (const c of ordered) {
    const paths = changedFiles.get(c.sha) ?? [];
    const files: FileAuthorship[] = paths.map((path) => {
      const hit = creditedBy.get(key(c.sha, path));
      return {
        path,
        agent: hit ? hit.agent : null,
        eventId: hit ? hit.id : null,
        at: hit ? hit.at : null,
      };
    });

    const byAgent = new Map<string, number>();
    for (const f of files) if (f.agent) byAgent.set(f.agent, (byAgent.get(f.agent) ?? 0) + 1);

    out.set(c.sha, {
      ...c,
      files,
      agents: [...byAgent.entries()]
        .map(([agent, n]) => ({ agent, files: n }))
        .sort((a, b) => b.files - a.files),
      humanFiles: files.filter((f) => !f.agent).length,
    });
  }

  // Back to newest-first, which is how a history reads.
  return commits.map((c) => out.get(c.sha)).filter(Boolean) as AuthoredCommit[];
}

/** Convenience: read the log and attribute it in one call. */
export async function authoredHistory(
  dir: string,
  events: LoomEvent[],
  limit: number,
  filesFor: (sha: string) => Promise<string[]>,
): Promise<AuthoredCommit[]> {
  const commits = await gitLog(dir, limit);
  const changed = new Map<string, string[]>();
  for (const c of commits) changed.set(c.sha, await filesFor(c.sha));
  return attribute(commits, events, changed);
}
