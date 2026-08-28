/**
 * The half of the stage's zone theming that can be checked without pixels.
 *
 * A canvas renderer cannot be asserted on directly — nobody has agreed what the
 * Ash Foundry should look like to the byte — but the decisions *behind* the
 * pixels are ordinary data: which theme a zone name resolves to, which prop a
 * room kind gets, and whether the palettes still differ in the ways a viewer
 * actually reads. Those are what break silently, and those are what is here.
 *
 * The load-bearing test is the first one: the zone names live in the
 * simulation's content tables and the themes live in the viewer, and nothing at
 * compile time connects the two. A renamed zone would fall back to grey stone
 * on every floor of that band and nothing else would complain.
 */

import { describe, expect, it } from "vitest";
import {
  currentRoom,
  hash,
  jitter,
  NEUTRAL_ZONE,
  NO_STAGING,
  roomSeed,
  stagingFor,
  themeForZone,
  ZONE_THEMES,
} from "../../viewer/broadcast/src/zones.js";
import { generateFloorMap, ROOM_ENVIRONMENTS } from "../sim/descent/content.js";
import { makeRng } from "../sim/rng.js";

/** Every kind the simulation's `RoomKind` union admits, spelled out so a new one shows up here. */
const ROOM_KINDS = ["entrance", "empty", "combat", "elite", "boss", "market", "cache", "shrine", "stairs"] as const;

describe("zone themes", () => {
  it("covers every zone the simulation actually generates", () => {
    // Fifteen floors is one full cycle of the five zones, and the maps come from
    // the simulation rather than from a copy of its names.
    const seen = new Set<string>();
    for (let floor = 1; floor <= 15; floor++) {
      const map = generateFloorMap(floor, makeRng(floor * 977));
      seen.add(map.zone);
      expect(themeForZone(map.zone).id, `floor ${floor} zone "${map.zone}"`).not.toBe(NEUTRAL_ZONE.id);
    }
    expect(seen.size).toBe(ZONE_THEMES.length);
  });

  it("falls back to a neutral room rather than throwing", () => {
    for (const missing of [null, undefined, "", "   ", "The Sixth Zone", "sunken"]) {
      expect(themeForZone(missing).id).toBe(NEUTRAL_ZONE.id);
    }
    // The names arrive over the wire, so matching is on a normalised form.
    expect(themeForZone("  the sunken gate ").id).toBe("sunken-gate");
    expect(themeForZone("Sunken Gate").id).toBe("sunken-gate");
  });

  it("keeps the five apart in the ways a viewer reads them", () => {
    const ids = new Set(ZONE_THEMES.map((z) => z.id));
    const rigs = new Set(ZONE_THEMES.map((z) => z.rig));
    const dressings = new Set(ZONE_THEMES.map((z) => z.dressing));
    expect(ids.size).toBe(ZONE_THEMES.length);
    // Light and material are what carry recognition when the caption is covered,
    // so no two zones may share either.
    expect(rigs.size).toBe(ZONE_THEMES.length);
    expect(dressings.size).toBe(ZONE_THEMES.length);

    const foundry = themeForZone("The Ash Foundry");
    const catacombs = themeForZone("The Crystal Catacombs");
    const chapel = themeForZone("The Null Chapel");
    const gate = themeForZone("The Sunken Gate");

    // Warm against cold, measured on the pool the key light lays on the floor.
    const [fr, , fb] = foundry.pool.rgb.split(",").map(Number);
    const [cr, , cb] = catacombs.pool.rgb.split(",").map(Number);
    expect(fr).toBeGreaterThan(fb);
    expect(cb).toBeGreaterThan(cr);

    // The Null Chapel is the zone light gives up in, and the only one with no air.
    expect(chapel.motes).toBeNull();
    expect(chapel.falloff).toBeGreaterThan(catacombs.falloff);
    for (const zone of ZONE_THEMES) expect(zone.falloff).toBeLessThanOrEqual(1);

    // Only the drowned zone has weather; only the forge has haze.
    expect(gate.caustics).toBeGreaterThan(0);
    expect(foundry.shimmer).toBeGreaterThan(0);
    expect(ZONE_THEMES.filter((z) => z.caustics > 0)).toHaveLength(1);
    expect(ZONE_THEMES.filter((z) => z.shimmer > 0)).toHaveLength(1);
  });

  it("keeps every ambient particle budget in the tens", () => {
    // A thousand small moving things is noise at a streaming bitrate, and this
    // array is walked twice a frame in a spore room.
    for (const zone of ZONE_THEMES) {
      if (!zone.motes) continue;
      expect(zone.motes.count).toBeGreaterThan(0);
      expect(zone.motes.count).toBeLessThanOrEqual(60);
      expect(zone.motes.alpha).toBeLessThan(0.5);
    }
  });
});

describe("room staging", () => {
  it("stages every room kind the simulation can produce", () => {
    for (const kind of ROOM_KINDS) {
      const staged = stagingFor({ id: "r1", kind, label: kind }, 3);
      expect(staged.prop, kind).not.toBe("none");
    }
  });

  it("stages every environment the simulation can produce", () => {
    for (const kind of Object.keys(ROOM_ENVIRONMENTS)) {
      const staged = stagingFor({ id: "r1", kind: "empty", environment: { kind } }, 3);
      expect(staged.floor, kind).not.toBe("none");
    }
  });

  it("degrades to bare stone rather than throwing on anything unknown", () => {
    expect(stagingFor(null, 1)).toBe(NO_STAGING);
    expect(stagingFor(undefined, 1)).toBe(NO_STAGING);
    const odd = stagingFor({ id: "r1", kind: "vault", environment: { kind: "lava" } }, 1);
    expect(odd.prop).toBe("none");
    expect(odd.floor).toBe("none");
    // A room object with nothing on it at all — an old trace — still answers.
    expect(stagingFor({}, 1).key).toBeTruthy();
  });

  it("gives the same room on two floors two different looks", () => {
    // Every floor has an `r0`. Seeding on the id alone would give floor 1 and
    // floor 40 identical rubble, which is the one thing a viewer notices.
    expect(roomSeed("r0", 1)).not.toBe(roomSeed("r0", 2));
    expect(stagingFor({ id: "r0", kind: "combat" }, 1).seed).not.toBe(stagingFor({ id: "r0", kind: "combat" }, 2).seed);
  });

  it("rebuilds the baked room only when something in it changed", () => {
    const room = { id: "r2", kind: "elite", label: "hammer vault", environment: { kind: "flooded" }, cleared: false };
    expect(stagingFor(room, 7).key).toBe(stagingFor({ ...room }, 7).key);
    // Clearing an elite room leaves its arena and its scarring, but the canvas
    // still has to be repainted, so `cleared` belongs in the key.
    expect(stagingFor(room, 7).key).not.toBe(stagingFor({ ...room, cleared: true }, 7).key);
    expect(stagingFor(room, 7).key).not.toBe(stagingFor({ ...room, kind: "market" }, 7).key);
  });

  it("finds the room the party is standing in, or says there is none", () => {
    const rooms = [{ id: "r0" }, { id: "r1" }];
    expect(currentRoom({ currentRoom: "r1", rooms })?.id).toBe("r1");
    expect(currentRoom({ currentRoom: "r9", rooms })).toBeNull();
    expect(currentRoom(null)).toBeNull();
    expect(currentRoom(undefined)).toBeNull();
    expect(currentRoom({ currentRoom: "r0" })).toBeNull();
  });
});

describe("deterministic jitter", () => {
  it("gives one seed one sequence, every frame and every replay", () => {
    const first = Array.from({ length: 8 }, jitter(roomSeed("r3", 12)));
    const again = Array.from({ length: 8 }, jitter(roomSeed("r3", 12)));
    expect(first).toEqual(again);
    expect(new Set(first).size).toBeGreaterThan(1);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("hashes to a bounded number for anything, including the empty string", () => {
    for (const s of ["", "r0", "The Null Chapel", "hollow-choir"]) {
      expect(hash(s)).toBeGreaterThanOrEqual(0);
      expect(hash(s)).toBeLessThanOrEqual(1);
    }
    expect(hash("r0")).not.toBe(hash("r1"));
  });
});
