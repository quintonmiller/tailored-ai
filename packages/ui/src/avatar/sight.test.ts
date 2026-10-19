/**
 * Seeing past the furniture: a tall thing between the camera and a body is
 * named so it can fade, one beside the line is not, and a wall the camera
 * went round behind is named too.
 */
import { describe, expect, it } from "vitest";
import { blockers, blocks, type Solid, type Vec3, wallOf, wallsBehind } from "./sight";

/** A palm at the front right of a meeting room, 1.9 m tall. */
const palm: Solid = { min: [3.4, 0, 2.45], max: [3.95, 1.9, 3.0] };
/** The camera, out past the front right, above. */
const eye: Vec3 = [8, 6, 12];

describe("blocks", () => {
  it("names a palm standing on the line from the camera to a head behind it", () => {
    // A body just behind the palm, as seen from the camera.
    const head: Vec3 = [3.0, 1.0, 1.6];
    expect(blocks(palm, eye, head)).toBe(true);
  });

  it("leaves a palm beside the line alone", () => {
    expect(blocks(palm, eye, [-1, 1, -1])).toBe(false);
    expect(blocks(palm, eye, [0, 1, 0])).toBe(false);
  });

  it("leaves something behind the body alone, however it lines up", () => {
    // The body stands between the camera and the palm.
    expect(blocks(palm, [3.7, 1.0, 10], [3.7, 1.0, 5])).toBe(false);
  });

  it("never names what the body is inside, like the umbrella over it", () => {
    const umbrella: Solid = { min: [-1, 0, -1], max: [1, 2, 1] };
    expect(blocks(umbrella, eye, [0, 1, 0])).toBe(false);
  });

  it("handles a line straight down an axis", () => {
    const shelf: Solid = { min: [-0.5, 0, 1], max: [0.5, 2, 1.4] };
    expect(blocks(shelf, [0, 1, 6], [0, 1, 0])).toBe(true);
    expect(blocks(shelf, [2, 1, 6], [2, 1, 0])).toBe(false);
  });
});

describe("blockers", () => {
  it("names each thing in the way of any of the targets, once", () => {
    const lamp: Solid = { min: [-2.2, 0, 2], max: [-1.8, 1.7, 2.4] };
    const named = blockers([palm, lamp], eye, [
      [3.0, 1.0, 1.6],
      [3.0, 0.6, 1.6],
      [-6, 1, -6],
    ]);
    expect([...named]).toEqual([0]);
  });
});

describe("wallsBehind", () => {
  const room = { width: 8, depth: 6.5 };

  it("names no wall from the front and right, where the room is open", () => {
    expect(wallsBehind(room, [6, 5, 10]).size).toBe(0);
  });

  it("names the back wall once the camera has gone round behind it, and the left once round that", () => {
    expect([...wallsBehind(room, [2, 4, -9])]).toEqual(["back"]);
    expect([...wallsBehind(room, [-9, 4, 2])]).toEqual(["left"]);
    expect(wallsBehind(room, [-9, 4, -9])).toEqual(new Set(["back", "left"]));
  });
});

describe("wallOf", () => {
  const room = { width: 8, depth: 6.5 };

  it("puts what hangs near the back on the back wall, near the left on the left, and nothing else on either", () => {
    expect(wallOf(room, [1, -3.2])).toBe("back");
    expect(wallOf(room, [-3.95, 0.5])).toBe("left");
    expect(wallOf(room, [-3.9, -3.2])).toBe("back");
    expect(wallOf(room, [0, 0])).toBeUndefined();
  });
});
