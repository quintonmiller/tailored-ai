/**
 * Whether a generated floor can always be finished, and whether its gate is real.
 *
 * The baselines cannot see either of these, for the same reason they cannot see
 * a legibility defect: a stuck run is not a crash. It is forty ticks, no
 * exception, a metrics object full of zeroes and a number that lands quietly in
 * the distribution. Three of the six policies scored exactly 0 on seed 1018 and
 * the sweep reported it as a hard seed.
 *
 * Both invariants below are written in the generator's own comments already —
 * "never on the way to the stairs", "a locked loop is always optional", "or the
 * toll would be trivially walked around". They were not true. Measured over the
 * 300 seeds × 6 floors this file sweeps, before the fix:
 *
 *   8.2%   of floors put the stairs behind a toll or a locked door
 *  18.3%   had a room the party could walk into and then not reach the stairs from
 *  53.8%   of the tolls that were placed could simply be walked around
 *
 * Each expectation here was confirmed to fail against the reverted generator
 * before it was kept.
 */

import { describe, expect, it } from "vitest";
import { generateFloorMap } from "../sim/descent/content.js";
import { makeRng } from "../sim/rng.js";

type Floor = ReturnType<typeof generateFloorMap>;
type Route = Floor["routes"][number];

/**
 * The routes a party can always cross: no money, no key, no class skill.
 *
 * Deliberately restated here rather than imported. This file exists to check the
 * generator against the design, and a shared constant would let a change to what
 * counts as passable silently redefine the thing being asserted.
 */
const FREE = new Set<Route["kind"]>(["passage", "trap", "one-way"]);

function freelyReachable(routes: readonly Route[], from: string): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const here = queue.shift() as string;
    for (const route of routes) {
      if (!route.discovered || !FREE.has(route.kind)) continue;
      const next = route.from === here ? route.to : route.bidirectional && route.to === here ? route.from : undefined;
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Every floor of every seed in the sweep, generated the way the simulation does. */
function everyFloor(seeds = 300, floors = 6): Array<{ seed: number; floor: number; map: Floor }> {
  const all: Array<{ seed: number; floor: number; map: Floor }> = [];
  for (let seed = 1000; seed < 1000 + seeds; seed++) {
    // One `pathRng` walked across the floors in order, exactly as
    // `DescentSimulation` does, so floor 3 here is the floor 3 a run plays.
    const rng = makeRng(seed).fork("path");
    for (let floor = 1; floor <= floors; floor++) all.push({ seed, floor, map: generateFloorMap(floor, rng) });
  }
  return all;
}

describe("descent floor generation", () => {
  const sweep = everyFloor();

  it("gives every floor a way down", () => {
    const missing = sweep.filter(({ map }) => !map.rooms.some((room) => room.kind === "stairs"));
    expect(missing.map(({ seed, floor }) => `${seed}/${floor}`)).toEqual([]);
  });

  it("never puts the stairs behind a toll or a lock", () => {
    // A party with no gold and no key must still be able to finish the floor.
    // Before the fix this failed on 148 of 1800 floors — seed 1018 floor 1 among
    // them, where three baselines stood in two rooms for the whole run.
    const stranded = sweep.filter(({ map }) => {
      const stairs = map.rooms.find((room) => room.kind === "stairs");
      return stairs ? !freelyReachable(map.routes, "r0").has(stairs.id) : false;
    });
    expect(stranded.map(({ seed, floor }) => `${seed}/${floor}`)).toEqual([]);
  });

  it("never strands the party past a one-way drop", () => {
    // The weaker version of this invariant asked only whether the *entrance*
    // could still reach the stairs. A one-way drop can put the party on the far
    // side of the gate, where it cannot. 329 of 1800 floors had such a room.
    const trapped = sweep.flatMap(({ seed, floor, map }) => {
      const stairs = map.rooms.find((room) => room.kind === "stairs");
      if (!stairs) return [];
      const standable = freelyReachable(map.routes, "r0");
      const dead = [...standable].filter((room) => !freelyReachable(map.routes, room).has(stairs.id));
      return dead.length ? [`${seed}/${floor}: ${dead.join(",")}`] : [];
    });
    expect(trapped).toEqual([]);
  });

  it("makes every toll gate the only free way into the room it charges for", () => {
    // A gate with a way around it prices nothing. 599 of the 1113 tolls the old
    // generator placed could be walked around, because loops were added after
    // the toll was chosen.
    const porous = sweep.flatMap(({ seed, floor, map }) => {
      const tolls = map.routes.filter((route) => route.kind === "toll");
      return tolls.flatMap((toll) => {
        const free = freelyReachable(map.routes, "r0");
        const behind = free.has(toll.to) ? (free.has(toll.from) ? undefined : toll.from) : toll.to;
        return behind === undefined ? [`${seed}/${floor}: ${toll.id} gates nothing`] : [];
      });
    });
    expect(porous).toEqual([]);
  });

  it("still places a real gate on a useful share of floors", () => {
    // Both invariants above are trivially satisfiable by never placing a toll,
    // and a toll is the only barrier in this dungeon that five purses open
    // better than one — so the count is asserted, not just the safety.
    //
    // 28% at the time of writing. The old generator placed one on 62% of
    // floors, but 54% of those could be walked around, so the honest rate it
    // achieved was 28.6% — this is the same density of real gates, and none of
    // the decorative ones. The floor is set below the measurement rather than
    // at it, because this number moves whenever room kinds or loops are tuned
    // and the thing worth failing on is a gate that has quietly stopped
    // appearing.
    const withToll = sweep.filter(({ map }) => map.routes.some((route) => route.kind === "toll"));
    /*
     * 0.18, lowered from 0.25 on 2026-08-19, deliberately rather than quietly.
     *
     * A gate is only a gate on a room with a single free way in, so the rate
     * follows the number of *leaf* rooms — structural, not a probability
     * anybody can turn up. Cutting floors from 5–7 rooms to 5–6 took it from
     * roughly 27% of floors to 20%.
     *
     * The trade was taken with eyes open. Pace was the larger problem by some
     * distance: 47% of every round was spent walking, and three live runs in a
     * row ended around floor two to four with the economy never opening — so
     * draughts, merchants and the whole gold layer were being measured in a
     * regime no run reached. Fewer rooms moved the baseline from 3.0 floors a
     * run to 3.5 and raised every rung of the ladder.
     *
     * One floor in five still carries a gate: often enough to be a decision the
     * party meets, not so often that it is scenery. If the pooling mechanic
     * ever looks under-exercised in live runs, this is the first number to put
     * back.
     */
    expect(withToll.length / sweep.length).toBeGreaterThan(0.18);
  });

  it("generates the same floor twice from the same seed", () => {
    const once = generateFloorMap(3, makeRng(4242).fork("path"));
    const again = generateFloorMap(3, makeRng(4242).fork("path"));
    expect(JSON.stringify(again)).toEqual(JSON.stringify(once));
  });
});
