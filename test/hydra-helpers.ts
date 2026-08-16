/**
 * Test support for the HydraDB suites.
 *
 * These tests run against a **real** `graph-node`. There is no in-memory
 * double, and there deliberately isn't one: everything they assert — the
 * commit-sequence total order, `strong` re-verification against object
 * storage, `algo.MSpaths` traversal semantics — is behaviour of the storage
 * engine. A fake would only prove that the fake agrees with itself, and the
 * two most valuable findings in this port (that `MATCH ... WHERE ... SET` is
 * not a compare-and-swap, and that a list parameter is only accepted as
 * `UNWIND` input) are exactly the kind a double would have hidden.
 *
 * Each test gets its own project key, so its slot, ids and event sequence are
 * disjoint from every other test's even though they share one graph.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hydra } from "../src/hydra/client.js";
import { ProjectGraph } from "../src/hydra/graph.js";
import { tmpDir } from "./helpers.js";

/** Is a node listening and answering? Suites skip themselves when not. */
export async function hydraUp(): Promise<boolean> {
  const { ok } = await hydra().ping();
  return ok;
}

export const HYDRA_SKIP_MESSAGE =
  "needs a running HydraDB node — see docs/SETUP.md (`just hydra-up`, or the docker run in the README)";

/**
 * A project directory whose graph nobody else is writing to.
 *
 * The `.loom` name matters: `EventLog.open` and `BatonManager.open` both key
 * the graph off it, so a test that invented a different directory name would
 * quietly put the log and the baton on two different project slots and stop
 * testing the thing it thinks it is testing. The isolation comes from the
 * temp directory being unique, not from renaming `.loom`.
 */
export function isolatedProject(prefix: string): { dir: string; loomDir: string } {
  const dir = path.join(tmpDir(prefix), crypto.randomBytes(4).toString("hex"));
  const loomDir = path.join(dir, ".loom");
  fs.mkdirSync(loomDir, { recursive: true });
  return { dir, loomDir };
}

export async function freshGraph(prefix: string): Promise<ProjectGraph> {
  const { loomDir } = isolatedProject(prefix);
  const g = new ProjectGraph(path.resolve(loomDir));
  await g.open();
  return g;
}
