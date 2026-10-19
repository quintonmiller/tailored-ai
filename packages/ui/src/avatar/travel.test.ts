/**
 * Getting round on a visit: the speed for the keys you hold, the walk the
 * body plays at a pace and how fast, and a camera that keeps up.
 */
import { describe, expect, it } from "vitest";
import { FLY_SPEED, gait, heldMove, keepUp, RUN_FACTOR, travelSpeed, WALK_SPEED } from "./travel";

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
