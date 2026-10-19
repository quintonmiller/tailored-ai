import { describe, expect, it } from "vitest";
import { standsClear } from "./doors";
import { keeping, SPACING, STAND_OFF, standBy } from "./visits";

const room = { width: 8, depth: 6 };
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The way from `p` to `q`, as the walker keeps a facing. */
const toward = (p: [number, number], q: [number, number]) => Math.atan2(q[0] - p[0], q[1] - p[1]);

describe("standing with someone", () => {
  it("stands near enough to talk, on the side it comes from, facing the one it came to see", () => {
    const host: [number, number] = [1, -1];
    const door: [number, number] = [1, 2.6];
    const { at, facing } = standBy(room, [], host, { from: door });
    expect(dist(at, host)).toBeCloseTo(STAND_OFF, 2);
    // Between the host and the door it came in by.
    expect(at[0]).toBeCloseTo(1, 2);
    expect(at[1]).toBeGreaterThan(host[1]);
    expect(facing).toBeCloseTo(toward(at, host), 5);
  });

  it("goes round the furniture, and stays inside the walls", () => {
    const host: [number, number] = [0, 0];
    // A desk across the side it comes from.
    const desk = { minX: -1, maxX: 1, minZ: 0.4, maxZ: 1.4 };
    const { at } = standBy(room, [desk], host, { from: [0, 2.5] });
    expect(standsClear(room, [desk], at)).toBe(true);
    expect(dist(at, host)).toBeLessThan(STAND_OFF + 0.5);
    // In a corner, it still stands in the room.
    const corner: [number, number] = [3.7, 2.7];
    const there = standBy(room, [], corner, { from: [4, 3] });
    expect(standsClear(room, [], there.at)).toBe(true);
  });

  it("stands several visitors round one agent, never on top of each other", () => {
    const host: [number, number] = [0, -0.5];
    const door: [number, number] = [0, 2.6];
    const taken: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const { at, facing } = standBy(room, [], host, { from: door, others: taken });
      for (const o of taken) expect(dist(at, o)).toBeGreaterThanOrEqual(SPACING);
      expect(facing).toBeCloseTo(toward(at, host), 5);
      taken.push(at);
    }
    // The first came straight in; the next stood either side of it.
    expect(taken[0][0]).toBeCloseTo(0, 2);
    expect(Math.sign(taken[1][0])).toBe(-Math.sign(taken[2][0]));
  });

  it("finds somewhere even when nowhere is clear", () => {
    const host: [number, number] = [0, 0];
    const everything = { minX: -4, maxX: 4, minZ: -3, maxZ: 3 };
    const { at } = standBy(room, [everything], host, { from: [0, 2] });
    expect(at).toEqual([0, STAND_OFF]);
  });
});

describe("keeping company", () => {
  it("has a visitor face the one it came to see, and that one face the latest to come", () => {
    const here = new Set(["host", "guest", "other"]);
    expect(
      keeping(
        [
          ["guest", "host"],
          ["other", "host"],
        ],
        here,
      ),
    ).toEqual(
      new Map([
        ["guest", "host"],
        ["other", "host"],
        ["host", "other"],
      ]),
    );
  });

  it("keeps a visitor to the one it came to see, whoever comes to see it", () => {
    const here = new Set(["host", "guest", "third"]);
    // guest came to see host; third came to see guest.
    const kept = keeping(
      [
        ["guest", "host"],
        ["third", "guest"],
      ],
      here,
    );
    expect(kept.get("guest")).toBe("host");
    expect(kept.get("third")).toBe("guest");
    expect(kept.get("host")).toBe("guest");
  });

  it("leaves out whoever came to see someone who isn't here, or nobody", () => {
    expect(
      keeping(
        [
          ["guest", "away"],
          ["other", undefined],
        ],
        new Set(["guest", "other"]),
      ).size,
    ).toBe(0);
  });
});
