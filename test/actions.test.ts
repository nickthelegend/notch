/**
 * Saved actions, against a real node.
 *
 * The one behaviour worth defending here is that actions are **global**. Every
 * other store in this codebase is reached through a `HAS_*` edge from a project
 * and would be wrong if it leaked across projects; this one is the opposite —
 * an action saved in one workspace that did not appear in the next would be the
 * bug. So the test writes with one store and reads with a second, independently
 * constructed one, because a per-instance cache would pass a same-object test
 * and fail the real thing.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { hydra } from "../src/hydra/client.js";
import { ActionStore } from "../src/hydra/actions.js";
import { hydraUp, HYDRA_SKIP_MESSAGE } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  up = await hydraUp();
  if (!up) console.warn(`skipping action tests — ${HYDRA_SKIP_MESSAGE}`);
});

/** A name no other run can collide with — every test here shares one graph. */
const tag = () => `t-${crypto.randomBytes(4).toString("hex")}`;

describe("saved actions", () => {
  it("round-trips a shell action through the graph", async () => {
    if (!up) return;
    const store = new ActionStore(hydra());
    const name = tag();
    const saved = await store.save({ name, kind: "shell", body: "npm test -- --run" });
    expect(saved.id).toMatch(/^[0-9a-f]{12}$/);
    expect(saved.runs).toBe(0);

    const back = await store.get(saved.id);
    expect(back?.name).toBe(name);
    expect(back?.kind).toBe("shell");
    expect(back?.body).toBe("npm test -- --run");

    expect(await store.remove(saved.id)).toBe(true);
    expect(await store.get(saved.id)).toBeNull();
  });

  it("is visible to a store that never wrote it", async () => {
    if (!up) return;
    const writer = new ActionStore(hydra());
    const name = tag();
    const saved = await writer.save({ name, kind: "prompt", body: "review the diff" });

    // A second store, constructed independently — this is the "any workspace"
    // claim, and it is the reason actions are not hung off a project edge.
    const reader = new ActionStore(hydra());
    const list = await reader.list();
    const hit = list.filter((a) => a.id === saved.id)[0];
    expect(hit).toBeDefined();
    expect(hit.kind).toBe("prompt");

    await writer.remove(saved.id);
  });

  it("counts runs and orders the busiest first", async () => {
    if (!up) return;
    const store = new ActionStore(hydra());
    const quiet = await store.save({ name: tag(), kind: "shell", body: "echo quiet" });
    const busy = await store.save({ name: tag(), kind: "shell", body: "echo busy" });
    await store.recordRun(busy.id);
    await store.recordRun(busy.id);

    const list = await store.list();
    const mine = list.filter((a) => a.id === busy.id || a.id === quiet.id);
    expect(mine.map((a) => a.id)).toEqual([busy.id, quiet.id]);
    expect(mine[0].runs).toBe(2);
    expect(mine[1].runs).toBe(0);

    await store.remove(busy.id);
    await store.remove(quiet.id);
  });

  it("edits in place rather than minting a second row", async () => {
    if (!up) return;
    const store = new ActionStore(hydra());
    const saved = await store.save({ name: tag(), kind: "shell", body: "npm run build" });
    await store.recordRun(saved.id);
    const renamed = await store.save({ id: saved.id, name: "built", kind: "shell", body: "npm run build -- --watch" });

    expect(renamed.id).toBe(saved.id);
    // The run count survives an edit — you renamed the action, you did not
    // create a new one, and the toolbar's ordering should not forget that.
    expect(renamed.runs).toBe(1);
    const all = await store.list();
    expect(all.filter((a) => a.id === saved.id).length).toBe(1);

    await store.remove(saved.id);
  });

  it("refuses an action with nothing to run", async () => {
    if (!up) return;
    const store = new ActionStore(hydra());
    await expect(store.save({ name: "empty", kind: "shell", body: "   " })).rejects.toThrow(/something to run/);
    await expect(store.save({ name: "  ", kind: "shell", body: "ls" })).rejects.toThrow(/needs a name/);
  });

  it("reports a missing action rather than pretending it removed one", async () => {
    if (!up) return;
    const store = new ActionStore(hydra());
    expect(await store.remove("ffffffffffff")).toBe(false);
  });
});
