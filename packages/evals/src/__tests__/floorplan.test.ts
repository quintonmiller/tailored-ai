/**
 * Whether the floor map is a drawing of the floor.
 *
 * The old map was checked by looking at it, which is why it was wrong for
 * months in two ways nobody could see from one screenshot:
 *
 * 1. It positioned rooms from the `x`/`y` the generator stamps on them, and
 *    generation grows the tree with `x: parent.x + rng.int(-1, 1)` — so two
 *    rooms can be handed the same cell and draw exactly on top of each other.
 * 2. It drew a straight line between every pair of connected centres, so a loop
 *    or a one-way drop crossed the whole picture and passed *through* rooms it
 *    does not connect to.
 *
 * Both are properties, not opinions, so both are asserted here over every floor
 * of a hundred real seeds rather than argued about. Each claim was confirmed to
 * fail against the old coordinate-based layout before it was kept.
 */

import { describe, expect, it } from "vitest";
import {
  corridorsThroughRooms,
  insetPercent,
  insetViewBox,
  planFloor,
  ROOM_RADIUS,
  roomGates,
} from "../../viewer/broadcast/src/floorplan.js";
import { generateFloorMap } from "../sim/descent/content.js";
import { makeRng } from "../sim/rng.js";

/** Every floor of a hundred seeds, generated the way the simulation does. */
function floors(seeds = 100, deep = 6) {
  const all = [];
  for (let seed = 1000; seed < 1000 + seeds; seed++) {
    const rng = makeRng(seed).fork("path");
    for (let floor = 1; floor <= deep; floor++) all.push({ seed, floor, map: generateFloorMap(floor, rng) });
  }
  return all;
}

/**
 * What the party knows, at the moment it has walked the whole floor.
 *
 * The plan draws only corridors that appear in a room's `links`, which is how
 * the scene says "discovered". Generated maps start with the secret shortcut
 * undiscovered, so a test that used them raw would never exercise the case
 * where a secret *is* known — the one that produces the longest, most awkward
 * corridors and therefore the most crossings.
 */
function fullyExplored(map: ReturnType<typeof generateFloorMap>) {
  const links = new Map(map.rooms.map((room) => [room.id, new Set<string>()]));
  for (const route of map.routes) {
    links.get(route.from)?.add(route.to);
    if (route.bidirectional) links.get(route.to)?.add(route.from);
  }
  return {
    currentRoom: map.currentRoom,
    rooms: map.rooms.map((room) => ({ id: room.id, links: [...(links.get(room.id) ?? [])] })),
    routes: map.routes,
  };
}

describe("the floor plan", () => {
  const sweep = floors();

  it("gives every room a cell of its own", () => {
    const collisions: string[] = [];
    for (const { seed, floor, map } of sweep) {
      const plan = planFloor(fullyExplored(map));
      const seen = new Map<string, string>();
      for (const room of plan.rooms) {
        const cell = `${room.row}:${room.col}`;
        const other = seen.get(cell);
        if (other) collisions.push(`${seed}/${floor}: ${room.id} and ${other} both at ${cell}`);
        seen.set(cell, room.id);
      }
    }
    expect(collisions.slice(0, 10)).toEqual([]);
  });

  it("draws every room the floor has", () => {
    // A layout that silently dropped an unreachable room would look tidier and
    // be a worse map than one that draws it awkwardly.
    for (const { map } of sweep) {
      const plan = planFloor(fullyExplored(map));
      expect(plan.rooms.length).toBe(map.rooms.length);
    }
  });

  it("never runs a corridor through a room it does not connect", () => {
    const through: string[] = [];
    for (const { seed, floor, map } of sweep) {
      const bad = corridorsThroughRooms(planFloor(fullyExplored(map)));
      if (bad.length) through.push(`${seed}/${floor}: ${bad[0]}`);
    }
    expect(through.slice(0, 10)).toEqual([]);
  });

  it("keeps every corridor orthogonal", () => {
    // Diagonals are what made the old drawing unreadable: on a plan of a floor,
    // a line at an arbitrary angle does not look like a passage.
    const skew: string[] = [];
    for (const { seed, floor, map } of sweep) {
      for (const corridor of planFloor(fullyExplored(map)).routes) {
        for (let i = 0; i + 1 < corridor.points.length; i++) {
          const a = corridor.points[i];
          const b = corridor.points[i + 1];
          if (Math.abs(a.x - b.x) > 0.001 && Math.abs(a.y - b.y) > 0.001) {
            skew.push(`${seed}/${floor}: ${corridor.id} has a diagonal segment`);
          }
        }
      }
    }
    expect(skew.slice(0, 5)).toEqual([]);
  });

  /*
   * The map fills in; it does not transform.
   *
   * This replaces a test that asserted the opposite — that an undiscovered
   * corridor was left out of the plan. That was a defensible reading of "the
   * page shows the run" and it made the map unwatchable: the plan was computed
   * from the discovered subgraph and rooted at the party, so finding a corridor
   * changed the graph and walking through a door changed the root. Both
   * recomputed the layout, and the whole floor rearranged around rooms nobody
   * had touched.
   *
   * The map is viewer-facing and reaches no agent, so it draws the whole floor
   * and shades what is unknown. What that buys is this property: the same floor
   * lays out identically however much of it has been found and wherever the
   * party is standing.
   */
  it("lays a floor out the same way however much of it has been discovered", () => {
    for (const { seed, floor, map } of floors(40, 5)) {
      const whole = {
        currentRoom: map.currentRoom,
        rooms: map.rooms.map((room) => ({ id: room.id, links: room.links, kind: room.kind })),
        routes: map.routes,
      };
      const before = planFloor(whole);
      // The same floor, walked: the party is somewhere else entirely, and more
      // of it has been found. Neither may move a single room.
      for (const room of map.rooms) {
        const walked = planFloor({ ...whole, currentRoom: room.id });
        expect(
          walked.rooms.map((r) => `${r.id}@${r.row},${r.col}`).join("|"),
          `seed ${seed} floor ${floor}: the map moved when the party stood in ${room.id}`,
        ).toBe(before.rooms.map((r) => `${r.id}@${r.row},${r.col}`).join("|"));
      }
      const fully = planFloor(fullyExplored(map));
      expect(
        fully.rooms.map((r) => `${r.id}@${r.row},${r.col}`).join("|"),
        `seed ${seed} floor ${floor}: the map moved as the floor was explored`,
      ).toBe(before.rooms.map((r) => `${r.id}@${r.row},${r.col}`).join("|"));
    }
  });

  it("draws every corridor the floor has, discovered or not", () => {
    // The renderer shades an undiscovered way; it is not omitted here, because
    // omitting it is what made the layout move when one was found.
    const map = sweep.find(({ map: m }) => m.routes.some((r) => r.kind === "secret"))?.map;
    expect(map, "no seed in the sweep generated a secret route").toBeDefined();
    if (!map) return;
    const plan = planFloor({
      currentRoom: map.currentRoom,
      rooms: map.rooms.map((room) => ({ id: room.id, links: room.links, kind: room.kind })),
      routes: map.routes,
    });
    expect(plan.routes.some((r) => r.kind === "secret")).toBe(true);
    expect(plan.routes.length).toBe(map.routes.length);
  });

  it("draws the same floor the same way twice", () => {
    // A layout that shuffled between polls would be unreadable however few
    // lines crossed, and the store re-renders on a 700ms timer.
    const { map } = sweep[17];
    const once = planFloor(fullyExplored(map));
    const again = planFloor(fullyExplored(map));
    expect(JSON.stringify(again)).toEqual(JSON.stringify(once));
  });

  it("puts the entrance at the top and the stairs below it", () => {
    for (const { map } of sweep.slice(0, 40)) {
      const plan = planFloor(fullyExplored(map));
      const at = new Map(plan.rooms.map((room) => [room.id, room.row]));
      const entrance = map.rooms.find((room) => room.kind === "entrance");
      const stairs = map.rooms.find((room) => room.kind === "stairs");
      if (!entrance || !stairs) continue;
      expect(at.get(entrance.id)).toBe(0);
      expect(at.get(stairs.id) ?? 0).toBeGreaterThan(0);
    }
  });

  /*
   * The property every room *name* depends on.
   *
   * Rows are centred against the widest one, and a fractional indent puts rows
   * of different parity on interleaved grids — a row of two against a row of
   * three lands half a cell across, and rooms on neighbouring rows end up a
   * quarter of a cell apart. Measured before the fix: the space a name had to
   * print in was 9% of the map's width, about 28 pixels, on a five-room floor.
   * Rounding the indent costs half a cell of centring and is what makes a label
   * legible at all.
   */
  it("puts every room on one grid, so a name has a whole cell to print in", () => {
    for (const { seed, floor, map } of floors(60, 5)) {
      const plan = planFloor({ currentRoom: map.currentRoom, rooms: map.rooms, routes: map.routes });
      if (plan.rooms.length < 2) continue;
      const cols = plan.rooms.map((room) => room.col);
      for (const col of cols) {
        expect(Number.isInteger(col), `seed ${seed} floor ${floor}: room at fractional column ${col}`).toBe(true);
      }
      if (Number.isFinite(plan.minGapX)) {
        expect(plan.minGapX, `seed ${seed} floor ${floor}: rooms closer than a cell`).toBeGreaterThanOrEqual(
          plan.cell.w - 1e-9,
        );
      }
    }
  });

  it("reports the narrowest gap it actually has, not the cell size", () => {
    // `minGapX` is what a label is sized against, so it has to be measured from
    // the placed rooms rather than assumed from the grid. A single-column floor
    // has no gap at all and says so.
    for (const { map } of floors(20, 4)) {
      const plan = planFloor({ currentRoom: map.currentRoom, rooms: map.rooms, routes: map.routes });
      const xs = [...new Set(plan.rooms.map((r) => r.x))].sort((a, b) => a - b);
      const expected = xs.length < 2 ? Number.POSITIVE_INFINITY : Math.min(...xs.slice(1).map((x, i) => x - xs[i]));
      expect(plan.minGapX).toBeCloseTo(expected, 6);
    }
  });

  describe("which rooms are still shut", () => {
    const plan = (routes: Array<{ id: string; from: string; to: string; kind: string }>) =>
      planFloor({
        currentRoom: "a",
        rooms: [{ id: "a", links: routes.map((r) => r.to) }, ...routes.map((r) => ({ id: r.to, links: ["a"] }))],
        routes: routes.map((r) => ({ ...r, bidirectional: true })),
      });

    it("marks a room whose only way in is locked", () => {
      const gates = roomGates(plan([{ id: "r1", from: "a", to: "b", kind: "locked" }]), new Set());
      expect(gates.get("b")).toBe("locked");
    });

    it("does not mark a room that also has an open corridor", () => {
      // One way in is enough. A room reachable on foot is not shut, whatever
      // else happens to touch it.
      const gates = roomGates(
        plan([
          { id: "r1", from: "a", to: "b", kind: "locked" },
          { id: "r2", from: "a", to: "b", kind: "passage" },
        ]),
        new Set(),
      );
      expect(gates.has("b")).toBe(false);
    });

    it("stops marking it once the door has been opened", () => {
      const p = plan([{ id: "r1", from: "a", to: "b", kind: "locked" }]);
      expect(roomGates(p, new Set()).get("b")).toBe("locked");
      expect(roomGates(p, new Set(["r1"])).has("b")).toBe(false);
    });

    it("names the toll when that is what is in the way", () => {
      expect(roomGates(plan([{ id: "r1", from: "a", to: "b", kind: "toll" }]), new Set()).get("b")).toBe("toll");
    });

    it("names a secret way only when every way in is one", () => {
      expect(roomGates(plan([{ id: "r1", from: "a", to: "b", kind: "secret" }]), new Set()).get("b")).toBe("secret");
      const mixed = roomGates(
        plan([
          { id: "r1", from: "a", to: "b", kind: "secret" },
          { id: "r2", from: "a", to: "b", kind: "locked" },
        ]),
        new Set(),
      );
      expect(mixed.get("b")).toBe("locked");
    });
  });

  /*
   * The two coordinate systems the map draws in must land in the same place.
   *
   * Rooms are HTML positioned by percentage; corridors are one SVG with a
   * viewBox. They disagreed once, and nothing caught it because each had its own
   * copy of the arithmetic — the corridors drew a quarter of the way down the
   * page, through the legend and the panels below. This asserts they agree for
   * every room of every floor, which is the property, rather than asserting the
   * formula, which is the mistake that was made.
   */
  it("puts a corridor's end exactly where the room it joins is drawn", () => {
    const PAD_X = 11;
    const PAD_TOP = 6;
    const PAD_BOTTOM = 20;
    for (const { seed, floor, map } of floors(40, 5)) {
      const plan = planFloor({ currentRoom: map.currentRoom, rooms: map.rooms, routes: map.routes });
      const box = insetViewBox(plan, PAD_X, PAD_TOP, PAD_BOTTOM);
      for (const room of plan.rooms) {
        // Where the SVG puts a point at this room's centre, as a percentage of
        // the canvas — the same conversion the browser does for the viewBox.
        const svgX = ((room.x - box.x) / box.w) * 100;
        const svgY = ((room.y - box.y) / box.h) * 100;
        expect(svgX, `seed ${seed} floor ${floor} ${room.id}: x disagrees`).toBeCloseTo(
          insetPercent(room.x, plan.width, PAD_X),
          6,
        );
        expect(svgY, `seed ${seed} floor ${floor} ${room.id}: y disagrees`).toBeCloseTo(
          insetPercent(room.y, plan.height, PAD_TOP, PAD_BOTTOM),
          6,
        );
      }
    }
  });

  it("keeps every corridor inside the padded box", () => {
    // With `overflow: visible` on the corridor layer, anything outside the box
    // draws over the rest of the page rather than being clipped.
    const PAD_X = 11;
    const PAD_TOP = 6;
    const PAD_BOTTOM = 20;
    for (const { seed, floor, map } of floors(40, 5)) {
      const plan = planFloor({ currentRoom: map.currentRoom, rooms: map.rooms, routes: map.routes });
      const box = insetViewBox(plan, PAD_X, PAD_TOP, PAD_BOTTOM);
      for (const corridor of plan.routes) {
        for (const point of corridor.points) {
          const px = ((point.x - box.x) / box.w) * 100;
          const py = ((point.y - box.y) / box.h) * 100;
          expect(px, `seed ${seed} floor ${floor} ${corridor.id} left the box`).toBeGreaterThanOrEqual(-0.001);
          expect(px).toBeLessThanOrEqual(100.001);
          expect(py, `seed ${seed} floor ${floor} ${corridor.id} left the box`).toBeGreaterThanOrEqual(-0.001);
          expect(py).toBeLessThanOrEqual(100.001);
        }
      }
    }
  });

  it("leaves room for a room to be drawn at all", () => {
    // The radius the corridor check uses has to be smaller than half a cell, or
    // "no corridor through a room" would be satisfied by a plan whose rooms are
    // drawn too small to read.
    expect(ROOM_RADIUS).toBeLessThan(5);
    expect(ROOM_RADIUS).toBeGreaterThan(2);
  });
});
