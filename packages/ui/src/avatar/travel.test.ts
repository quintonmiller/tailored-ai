/**
 * Getting round on a visit: the speed for the keys you hold, the walk the
 * body plays at a pace and how fast, and a camera that keeps up and zooms.
 */
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_WALKED,
  Arrival,
  clampReach,
  ease,
  FLY_BEYOND,
  FLY_FLOOR,
  FLY_INSET,
  FLY_NOTCH_SECONDS,
  FLY_SKY,
  FLY_SPEED,
  flyBounds,
  flyPinchStep,
  flyWheelStep,
  followDistance,
  gait,
  heldMove,
  keepUp,
  keptIn,
  OUTDOOR_PACE,
  pinchReach,
  REACH,
  RUN_FACTOR,
  reachAt,
  SHORT_STRIP,
  takeOff,
  travelSpeed,
  WALK_SPEED,
  wheelPixels,
  wheelReach,
  widestReach,
} from "./travel";

describe("heldMove", () => {
  it("adds up the keys held, and opposite keys cancel", () => {
    expect(heldMove(["KeyW", "KeyD"])).toEqual({ right: 1, forward: 1, up: 0, running: false });
    expect(heldMove(["KeyW", "ArrowDown"])).toEqual({ right: 0, forward: 0, up: 0, running: false });
    expect(heldMove(["KeyE"])).toEqual({ right: 0, forward: 0, up: 1, running: false });
  });

  it("runs while either Shift is held, and ignores keys that move nothing", () => {
    expect(heldMove(["ShiftLeft", "KeyW"]).running).toBe(true);
    expect(heldMove(["ShiftRight", "ArrowLeft"])).toEqual({ right: -1, forward: 0, up: 0, running: true });
    expect(heldMove(["KeyZ", "Space"])).toEqual({ right: 0, forward: 0, up: 0, running: false });
  });
});

describe("travelSpeed", () => {
  it("walks briskly, runs at twice that with Shift, and flies faster again", () => {
    expect(travelSpeed("walk", false)).toBe(WALK_SPEED);
    expect(WALK_SPEED).toBeGreaterThanOrEqual(2.5);
    expect(WALK_SPEED).toBeLessThanOrEqual(3);
    expect(travelSpeed("walk", true)).toBe(WALK_SPEED * RUN_FACTOR);
    expect(RUN_FACTOR).toBe(2);
    expect(travelSpeed("fly", false)).toBe(FLY_SPEED);
    expect(FLY_SPEED).toBeGreaterThan(WALK_SPEED * RUN_FACTOR);
    expect(travelSpeed("fly", true)).toBe(FLY_SPEED * RUN_FACTOR);
  });

  it("walks faster outdoors, where the streets are long, and flies as it always does", () => {
    expect(travelSpeed("walk", false, true)).toBe(WALK_SPEED * OUTDOOR_PACE);
    expect(travelSpeed("walk", true, true)).toBe(WALK_SPEED * OUTDOOR_PACE * RUN_FACTOR);
    expect(OUTDOOR_PACE).toBeGreaterThan(1);
    // A run across the square and a lane or two takes seconds, not a minute: 60 m in under 8 s.
    expect(60 / travelSpeed("walk", true, true)).toBeLessThan(8);
    expect(travelSpeed("fly", false, true)).toBe(FLY_SPEED);
  });
});

describe("flyWheelStep", () => {
  it("flies you back as the wheel rolls toward you and on as it rolls away, a moment's flying a notch", () => {
    expect(flyWheelStep(100)).toBeCloseTo(-FLY_SPEED * FLY_NOTCH_SECONDS);
    expect(flyWheelStep(-100)).toBeCloseTo(FLY_SPEED * FLY_NOTCH_SECONDS);
    // A notch goes a couple of metres: far enough to feel, never across the town.
    expect(Math.abs(flyWheelStep(100))).toBeGreaterThan(1);
    expect(Math.abs(flyWheelStep(100))).toBeLessThan(5);
    expect(flyWheelStep(0)).toBeCloseTo(0);
  });
});

describe("flyPinchStep", () => {
  it("flies you on as the fingers spread and back as they close, 100 pixels of it a notch of the wheel", () => {
    expect(flyPinchStep(100, 200)).toBeCloseTo(flyWheelStep(-100));
    expect(flyPinchStep(200, 100)).toBeCloseTo(flyWheelStep(100));
    expect(flyPinchStep(100, 200)).toBeGreaterThan(0);
    expect(flyPinchStep(150, 150)).toBeCloseTo(0);
  });
});

describe("where you can fly", () => {
  const home = { width: 6, depth: 5, height: 3 };
  it("keeps you inside a room: over the floor, under the ceiling, within its walls", () => {
    const b = flyBounds(home);
    expect(b.min).toEqual([-3 + FLY_INSET, FLY_FLOOR, -2.5 + FLY_INSET]);
    expect(b.max).toEqual([3 - FLY_INSET, 3 - FLY_INSET, 2.5 - FLY_INSET]);
    // Held Q for a while: as low as the floor lets you, and no lower.
    expect(keptIn([0, -6, 0], b)).toEqual([0, FLY_FLOOR, 0]);
    // Held E: up to the ceiling. Flown out of the open front, or the wheel run on: back at the edge of the room.
    expect(keptIn([1, 15, 0], b)[1]).toBe(3 - FLY_INSET);
    expect(keptIn([9, 2, 12], b)).toEqual([3 - FLY_INSET, 2, 2.5 - FLY_INSET]);
    // Anywhere inside is yours.
    expect(keptIn([1, 1.5, -1], b)).toEqual([1, 1.5, -1]);
  });

  it("keeps you over the town outdoors, from just above the ground to the sky, a little past its edges", () => {
    const b = flyBounds({ width: 200, depth: 160, height: 3, town: {} });
    expect(b.min).toEqual([-100 - FLY_BEYOND, FLY_FLOOR, -80 - FLY_BEYOND]);
    expect(b.max).toEqual([100 + FLY_BEYOND, FLY_SKY, 80 + FLY_BEYOND]);
    expect(keptIn([0, 400, 0], b)[1]).toBe(FLY_SKY);
    expect(keptIn([0, -1, 0], b)[1]).toBe(FLY_FLOOR);
  });

  it("never gives a room so small it has no inside", () => {
    const b = flyBounds({ width: 0.2, depth: 0.2, height: 0.2 });
    for (const i of [0, 1, 2]) expect(b.max[i]).toBeGreaterThanOrEqual(b.min[i]);
  });

  it("takes off from your head a step back, inside the room, whichever way you look", () => {
    const b = flyBounds(home);
    // Facing into the room from its middle: a step behind your head, a little higher.
    expect(takeOff([0, 1.5, 0], [0, -1], b)).toEqual([0, 1.8, 1.2]);
    // Standing at the front with the camera behind you: the step back stops at the room's edge.
    expect(takeOff([0, 1.5, 2], [0, -1], b)).toEqual([0, 1.8, 2.5 - FLY_INSET]);
  });
});

describe("gait", () => {
  it("plays the walk as made at the pace it was made for", () => {
    expect(gait(1.2, 1.2, { walk: 1.2 })).toEqual({ role: "walk", rate: 1 });
  });

  it("plays the walk faster for a brisker pace, so the feet keep up with the ground", () => {
    expect(gait(2.75, 2.75, { walk: 1.1 })).toEqual({ role: "walk", rate: 2.5 });
  });

  it("runs past the body's own walking speed when there is a run to play, at the run's own rate", () => {
    expect(gait(5.5, 2.75, { walk: 1.1, run: 2.75 })).toEqual({ role: "run", rate: 2 });
    // A walking pace walks, even with a run to play.
    expect(gait(2.75, 2.75, { walk: 1.1, run: 2.75 }).role).toBe("walk");
  });

  it("plays the walk faster again for a run when there is no run to play", () => {
    expect(gait(5.5, 2.75, { walk: 2.2 })).toEqual({ role: "walk", rate: 2.5 });
    expect(gait(5.5, 2.75, { walk: 2.2, run: 2.75 }, false).role).toBe("walk");
  });

  it("runs as made with a run clip whose pace isn't known", () => {
    expect(gait(5.5, 2.75, { walk: 1.1 }, true)).toEqual({ role: "run", rate: 1 });
  });

  it("never plays a clip absurdly fast or slow, and plays one of unknown pace as made", () => {
    expect(gait(20, 2.75, { walk: 1 }).rate).toBe(4);
    expect(gait(0.01, 1, { walk: 1 }).rate).toBe(0.25);
    expect(gait(3, 1, {})).toEqual({ role: "walk", rate: 1 });
  });
});

describe("keepUp", () => {
  it("moves the camera exactly as far as you walked, so it never trails behind", () => {
    // Already looking at you; you walk 9 cm this frame at a run.
    const aim: [number, number, number] = [0, 1, 0];
    const head: [number, number, number] = [0.09, 1, 0];
    expect(keepUp(aim, head, [0.09, 0, 0], 1 / 60)).toEqual([0.09, 0, 0]);
  });

  it("closes a gap walking didn't make smoothly over a fraction of a second, without overshooting", () => {
    let aim: [number, number, number] = [0, 1, 0];
    const head: [number, number, number] = [2, 1, 0];
    const first = keepUp(aim, head, [0, 0, 0], 1 / 60);
    expect(first[0]).toBeGreaterThan(0);
    expect(first[0]).toBeLessThan(0.2);
    for (let i = 0; i < 90; i++) {
      const step = keepUp(aim, head, [0, 0, 0], 1 / 60);
      aim = [aim[0] + step[0], aim[1] + step[1], aim[2] + step[2]];
      expect(aim[0]).toBeLessThanOrEqual(2);
    }
    // A second and a half later it is as good as there.
    expect(aim[0]).toBeGreaterThan(1.99);
  });
});

describe("the walking camera's reach", () => {
  const lobby = { width: 14, depth: 10 };
  const home = { width: 6, depth: 5 };

  it("starts wide enough to see a good part of the room, and opens out to the whole of a big one", () => {
    expect(REACH.start).toBeGreaterThanOrEqual(4);
    expect(widestReach(lobby)).toBe(8);
    // A small room is never wider than the start; a huge one stops at the widest there is.
    expect(widestReach(home)).toBe(REACH.start);
    expect(widestReach({ width: 60, depth: 40 })).toBe(REACH.far);
    // Outdoors, a good part of the town; and you start further back there than in a room.
    expect(widestReach({ width: 160, depth: 150, town: {} })).toBe(REACH.outdoors);
    expect(REACH.outdoors).toBeGreaterThan(REACH.far);
    expect(REACH.outdoorStart).toBeGreaterThan(REACH.start);
    expect(REACH.outdoorStart).toBeLessThan(REACH.outdoors);
  });

  it("keeps a reach between close behind you and the widest worth seeing", () => {
    expect(clampReach(0.2, 8)).toBe(REACH.near);
    expect(clampReach(30, 8)).toBe(8);
    expect(clampReach(5, 8)).toBe(5);
    // A room too small for even the closest view still lets you come in close.
    expect(clampReach(5, 0.5)).toBe(REACH.near);
  });

  it("takes in more as the wheel turns toward you, less away, by the same share each notch", () => {
    const out = wheelReach(4, 100, 12);
    const back = wheelReach(out, -100, 12);
    expect(out).toBeGreaterThan(4);
    expect(back).toBeCloseTo(4, 9);
    // Two half notches are one notch, so a trackpad's small steps add up to the same.
    expect(wheelReach(wheelReach(4, 50, 12), 50, 12)).toBeCloseTo(out, 9);
    expect(wheelReach(4, 10_000, 8)).toBe(8);
    expect(wheelReach(4, -10_000, 8)).toBe(REACH.near);
  });

  it("counts a wheel that turns in lines or pages in pixels", () => {
    expect(wheelPixels({ deltaY: 100, deltaMode: 0 })).toBe(100);
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 })).toBe(99);
    expect(wheelPixels({ deltaY: -1, deltaMode: 2 })).toBe(-400);
  });

  it("comes in as fingers spread and goes out as they pinch", () => {
    expect(pinchReach(4, 100, 200, 12)).toBe(2);
    expect(pinchReach(4, 200, 100, 12)).toBe(8);
    expect(pinchReach(4, 0, 100, 12)).toBe(4);
  });

  it("frames the reach in the part of the stage that can be seen, so a narrow strip backs off further", () => {
    const fov = 35;
    const tan = Math.tan((fov * Math.PI) / 360);
    // Wider than tall: the height is the narrower way.
    expect(followDistance(4, 1.6, fov)).toBeCloseTo(4 / tan, 9);
    // Half the stage under the chat: narrower than tall, so the width decides, and it backs off.
    const narrow = followDistance(4, 0.8, fov);
    expect(narrow).toBeCloseTo(4 / (tan * 0.8), 9);
    expect(narrow).toBeGreaterThan(followDistance(4, 1.6, fov));
    // Either way, 4 m either side of you fills the narrower way of what can be seen.
    expect(narrow * tan * 0.8).toBeCloseTo(4, 9);
  });

  it("backs off further when a phone's chat covers the lower part of the stage, by the share it covers", () => {
    const fov = 35;
    // Only 40% of the stage's height above the chat: the same 4 m round you, fitted into that strip.
    expect(followDistance(4, 1.3, fov, 0.4)).toBeCloseTo(followDistance(4, 1.3, fov) / 0.4, 9);
  });

  it("eases toward a new distance over a fraction of a second, without overshooting", () => {
    let d = 10;
    const first = ease(d, 20, 1 / 60, 0.18);
    expect(first).toBeGreaterThan(10);
    expect(first).toBeLessThan(11);
    for (let i = 0; i < 60; i++) {
      d = ease(d, 20, 1 / 60, 0.18);
      expect(d).toBeLessThanOrEqual(20);
    }
    // Within a few centimetres after a second, and settled exactly soon after, rather than creeping forever.
    expect(d).toBeGreaterThan(19.9);
    for (let i = 0; i < 60; i++) d = ease(d, 20, 1 / 60, 0.18);
    expect(d).toBe(20);
  });
});

describe("reachAt", () => {
  it("is followDistance the other way round, for any shape of what can be seen", () => {
    for (const [aspect, tall] of [
      [1.6, 1],
      [0.5, 1],
      [2.4, 0.4],
    ])
      for (const reach of [1.4, 4.5, 11])
        expect(reachAt(followDistance(reach, aspect, 35, tall), aspect, 35, tall)).toBeCloseTo(reach, 6);
  });
});

describe("the shot of a room on the way in", () => {
  const widest = 6;

  it("backs off to show the room while you stand where you came in, and is fitted again as what can be seen changes", () => {
    const shot = new Arrival();
    shot.begin([-3, 2]);
    shot.fit(5.5, REACH.start, 1, widest);
    expect(shot.reach).toBe(5.5);
    // A panel opened: the shot needs more again.
    shot.fit(6.5, REACH.start, 1, widest);
    expect(shot.reach).toBe(widest);
    // Needing less than your own reach on a whole stage, it keeps yours.
    shot.fit(3, REACH.start, 1, widest);
    expect(shot.reach).toBeUndefined();
  });

  it("is over once you zoom: a refit or someone coming in after doesn't put the shot back over your zoom", () => {
    const shot = new Arrival();
    shot.begin([-3, 2]);
    shot.fit(5.5, REACH.start, 1, widest);
    shot.zoomed();
    expect(shot.holds).toBe(false);
    expect(shot.reach).toBeUndefined();
    // The chat closes, a body comes in: fitted again, still yours.
    shot.fit(6, 2, 1, widest);
    shot.fit(5.5, 2, 0.3, widest);
    expect(shot.reach).toBeUndefined();
  });

  it("is over once you walk off, and eases back to your reach", () => {
    const shot = new Arrival();
    shot.begin([0, 0]);
    shot.fit(5.5, REACH.start, 1, widest);
    shot.moved([ARRIVAL_WALKED * 0.8, 0]);
    expect(shot.holds).toBe(true);
    shot.settle(REACH.start, 0.1, 0.7);
    expect(shot.reach).toBe(5.5);
    shot.moved([ARRIVAL_WALKED * 1.2, 0]);
    expect(shot.holds).toBe(false);
    shot.settle(REACH.start, 0.1, 0.7);
    expect(shot.reach).toBeLessThan(5.5);
    expect(shot.reach).toBeGreaterThan(REACH.start);
    for (let i = 0; i < 100; i++) shot.settle(REACH.start, 0.1, 0.7);
    expect(shot.reach).toBeUndefined();
    // With motion reduced, back at once.
    shot.begin([0, 0]);
    shot.fit(5.5, REACH.start, 1, widest);
    shot.moved([2, 0]);
    shot.settle(REACH.start, 0.016, 0);
    expect(shot.reach).toBeUndefined();
    // Flown off, or brought to stand before someone: over at once.
    shot.begin([0, 0]);
    shot.fit(5.5, REACH.start, 1, widest);
    shot.drop();
    expect([shot.holds, shot.reach]).toEqual([false, undefined]);
  });

  it("comes in closer in a short strip, where your reach would draw the room as a sliver, never nearer than close behind", () => {
    const shot = new Arrival();
    shot.begin([0, 0]);
    shot.fit(2.6, REACH.start, SHORT_STRIP - 0.2, widest);
    expect(shot.reach).toBe(2.6);
    shot.fit(0.5, REACH.start, SHORT_STRIP - 0.2, widest);
    expect(shot.reach).toBe(REACH.near);
    // On a taller part of the stage it leaves your reach be.
    shot.fit(2.6, REACH.start, SHORT_STRIP + 0.2, widest);
    expect(shot.reach).toBeUndefined();
  });
});
