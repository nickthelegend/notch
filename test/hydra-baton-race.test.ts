/**
 * The baton, under contention, against a real node.
 *
 * This is the suite the old file-based lock could not have: with no epoch and
 * no ordering primitive there was nothing to race *on*, so "two agents both
 * think they hold it" was untestable and therefore untested. Every assertion
 * here is about a property of HydraDB's commit order, which is why it runs
 * against `graph-node` rather than a double.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { BatonManager, NotHolderError, StaleEpochError } from "../src/core/baton.js";
import { EventLog } from "../src/core/eventlog.js";
import { hydraUp, HYDRA_SKIP_MESSAGE, isolatedProject } from "./hydra-helpers.js";

let up = false;
beforeAll(async () => {
  up = await hydraUp();
  if (!up) console.warn(`skipping hydra baton tests — ${HYDRA_SKIP_MESSAGE}`);
});

async function setup(prefix = "baton") {
  const { dir, loomDir } = isolatedProject(prefix);
  const log = await EventLog.open(loomDir);
  const baton = await BatonManager.open(dir, log, undefined);
  return { dir, loomDir, log, baton };
}

/** A second, independent manager over the same project — a rival daemon. */
async function rival(dir: string, loomDir: string): Promise<BatonManager> {
  const log = await EventLog.open(loomDir);
  return BatonManager.open(dir, log, undefined);
}

describe("baton — election over HydraDB's commit order", () => {
  it("starts unheld, acquires, and records the epoch", async () => {
    if (!up) return;
    const { baton, log } = await setup();
    expect(baton.holder()).toBeNull();
    expect(baton.epoch()).toBe(0);

    await baton.acquire("plannerbot");
    expect(baton.holder()).toBe("plannerbot");
    expect(baton.epoch()).toBe(1);

    await log.flush();
    const handoffs = log.list({ kinds: ["handoff"] });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ from: null, to: "plannerbot", epoch: 1 });
  });

  it("acquire is idempotent for the holder and exclusive across agents", async () => {
    if (!up) return;
    const { baton } = await setup();
    await baton.acquire("plannerbot");
    await baton.acquire("plannerbot"); // no-op, no new epoch
    expect(baton.epoch()).toBe(1);
    await expect(baton.acquire("execbot")).rejects.toBeInstanceOf(NotHolderError);
  });

  it("handoff moves the baton and every other client sees it", async () => {
    if (!up) return;
    const { baton, dir, loomDir } = await setup();
    await baton.acquire("plannerbot");
    const { from } = await baton.handoff("execbot");
    expect(from).toBe("plannerbot");
    expect(baton.holder()).toBe("execbot");

    const other = await rival(dir, loomDir);
    expect(other.holder()).toBe("execbot");
    expect(other.epoch()).toBe(baton.epoch());
  });

  /**
   * The load-bearing one. Eight independent managers stand at once on a free
   * baton; exactly one may come away holding it, and everyone must agree who.
   *
   * A `MATCH ... WHERE epoch = $n SET epoch = $n+1` compare-and-swap fails this
   * test — the predicate is evaluated against a pinned snapshot with no
   * write-write conflict detection, so several writers match and several
   * "win". That is why the baton is an election over commit sequences instead.
   */
  it("elects exactly one winner from eight concurrent claimants", async () => {
    if (!up) return;
    const { dir, loomDir } = await setup("race");
    const managers = await Promise.all(
      Array.from({ length: 8 }, () => rival(dir, loomDir)),
    );

    const outcomes = await Promise.all(
      managers.map(async (m, i) => {
        try {
          await m.acquire(`racer-${i}`);
          return { i, won: true };
        } catch (err) {
          if (err instanceof NotHolderError) return { i, won: false };
          throw err;
        }
      }),
    );

    const winners = outcomes.filter((o) => o.won);
    expect(winners).toHaveLength(1);

    // And the whole fleet agrees, without having talked to each other.
    const observers = await Promise.all(Array.from({ length: 4 }, () => rival(dir, loomDir)));
    const holders = new Set(observers.map((o) => o.holder()));
    expect(holders.size).toBe(1);
    expect([...holders][0]).toBe(`racer-${winners[0]!.i}`);
  });

  it("records every contender at a contested epoch, winner first by sequence", async () => {
    if (!up) return;
    const { dir, loomDir } = await setup("ballots");
    const managers = await Promise.all(Array.from({ length: 5 }, () => rival(dir, loomDir)));
    await Promise.all(
      managers.map((m, i) => m.acquire(`cand-${i}`).catch(() => undefined)),
    );

    const observer = await rival(dir, loomDir);
    const history = await observer.history();
    expect(history.length).toBeGreaterThan(0);

    const contested = history.find((h) => h.contenders.length > 1);
    expect(contested, "at least one epoch should have been contested").toBeTruthy();
    // Sequences are assigned at commit and strictly increase, so the ballot
    // list is sorted and the winner is the minimum.
    const seqs = contested!.contenders.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(contested!.seq).toBe(seqs[0]);
    expect(new Set(seqs).size).toBe(seqs.length); // no two ballots share a sequence
  });
});

describe("baton — fencing", () => {
  it("refuses a displaced writer and records the violation", async () => {
    if (!up) return;
    const { baton } = await setup("fence");
    await baton.acquire("alpha");
    const alphaEpoch = baton.epoch();

    await baton.handoff("beta");
    await expect(
      baton.assertWriter("alpha", alphaEpoch, "file_edit", "src/core/baton.ts"),
    ).rejects.toBeInstanceOf(StaleEpochError);

    const violations = await baton.violations();
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      agent: "alpha",
      staleEpoch: alphaEpoch,
      currentHolder: "beta",
      op: "file_edit",
    });
  });

  /**
   * The epoch counter moves when a contender stands and loses. That must not
   * fence the agent who never lost the baton — being fenced means *displaced*,
   * not "the number went up while you were working".
   */
  it("does not fence a holder whose tenure was never broken", async () => {
    if (!up) return;
    const { dir, loomDir, baton } = await setup("tenure");
    await baton.acquire("alpha");
    const startEpoch = baton.epoch();

    const contender = await rival(dir, loomDir);
    await contender.acquire("beta").catch(() => undefined); // loses

    await baton.refresh("strong");
    expect(baton.holder()).toBe("alpha");
    expect(await baton.canWrite("alpha", startEpoch)).toBe(true);
    await expect(baton.assertWriter("alpha", startEpoch, "file_edit")).resolves.toBeUndefined();
  });

  it("release leaves the baton unheld, and assertHolder guards writes", async () => {
    if (!up) return;
    const { baton } = await setup("release");
    await baton.acquire("plannerbot");
    await baton.release("plannerbot");
    expect(baton.holder()).toBeNull();
    expect(() => baton.assertHolder("plannerbot")).toThrow(NotHolderError);
  });
});
