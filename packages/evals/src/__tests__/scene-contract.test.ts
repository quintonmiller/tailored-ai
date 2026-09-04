/**
 * The seam between the simulation and the page, checked by the compiler.
 *
 * The scene is declared twice: `DescentScene` in the simulation, and `Scene` in
 * `viewer/broadcast/src/types.ts` for the browser. That duplication is
 * deliberate — the page compiles with `lib: ["DOM"]` and `types: []`, and
 * importing the simulation to reach one interface would give the broadcast a
 * dependency on the thing it is only supposed to be watching.
 *
 * Duplication without a check is drift, though, and the drift is silent in the
 * worst possible way: rename a field on the server and the page reads
 * `undefined`, draws a health bar at zero, and reports no error anywhere. So the
 * two are pinned together here.
 *
 * The compile-time half is enforced in `src/sim/descent/scene-check.ts`, which
 * `tsc` does compile. This file covers what a type cannot: that the object the
 * simulation actually builds carries those fields, with the right kinds of
 * value in them.
 */

import { describe, expect, it } from "vitest";
import type { Scene } from "../broadcast-contract.js";
import type { DescentSimulation } from "../sim/descent/index.js";
import { createSimulation } from "../sim/index.js";

// The type-level half of this contract lives in `src/sim/descent/scene-check.ts`,
// not here. `tsconfig.json` excludes `__tests__`, so a compile-time assertion
// written in this file would check nothing at all while reading like a
// guarantee — which is worse than not having one. What is left below is the
// half a type cannot cover: that the object the simulation actually builds has
// the fields the type promises, with the right kinds of value in them.

describe("the scene the page is handed", () => {
  const scene = (): Scene => {
    const sim = createSimulation("descent", { seed: 11, days: 40, startFloor: 31 }) as DescentSimulation;
    sim.choosePath("guardian", sim.view().paths[0].id);
    sim.advance();
    return sim.scene();
  };

  it("has every field the browser type promises", () => {
    // A compile-time check proves the *types* agree; it cannot prove the object
    // was actually built with those keys, because `scene()` could return a
    // partially-filled object and still satisfy its own return type through a
    // cast somewhere. This walks the real thing.
    const s = scene() as unknown as Record<string, unknown>;
    for (const key of [
      "floor",
      "phase",
      "tick",
      "horizon",
      "dread",
      "level",
      "earnedXp",
      "party",
      "enemies",
      "paths",
      "floorMap",
      "pendingPath",
      "scouted",
      "stock",
      "loot",
      "beats",
      "beatsTick",
      "log",
    ]) {
      expect(s, `scene is missing ${key}`).toHaveProperty(key);
    }
  });

  it("describes all five of the party, alive or not", () => {
    const party = scene().party;
    expect(party.map((p) => p.id)).toEqual(["guardian", "mage", "rogue", "cleric", "ranger"]);
    for (const member of party) {
      expect(typeof member.hp).toBe("number");
      expect(typeof member.maxHp).toBe("number");
      expect(Array.isArray(member.statuses)).toBe(true);
      expect(Array.isArray(member.pack)).toBe(true);
      expect(typeof member.talentPoints).toBe("number");
      expect(Array.isArray(member.talents)).toBe(true);
      expect(typeof member.identity.displayName).toBe("string");
      expect(member.identity.traits).toHaveLength(5);
      expect(member.identity.traits.every((trait) => trait.score >= 1 && trait.score <= 100)).toBe(true);
      expect(typeof member.identity.secretGoal.title).toBe("string");
      expect(member.identity.secretGoal.revealed).toBe(false);
    }
  });

  it("stays inside the metrics contract it shares a snapshot with", () => {
    // `snapshot()` is read as a run's metrics by the live milestone scorer, so
    // the scene has to sit under one key and every other key has to stay a
    // number. A nested object loose in the snapshot would be scored as a metric.
    const sim = createSimulation("descent", { seed: 3, days: 40, startFloor: 31 });
    const snapshot = sim.snapshot();
    expect(snapshot).toHaveProperty("scene");
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === "scene") continue;
      expect(typeof value, `snapshot.${key} must stay flat for sim_metric`).toMatch(/number|string/);
    }
  });

  it("names the tick its beats belong to, so a renderer can dedupe them", () => {
    // The harness writes a snapshot per *turn*, so five scenes a round carry the
    // same beats. Without this field a viewer throws the same sword five times.
    const s = scene();
    expect(typeof s.beatsTick).toBe("number");
  });
});
