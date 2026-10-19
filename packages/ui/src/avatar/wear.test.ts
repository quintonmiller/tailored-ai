/**
 * What a body wears: put on and taken off one to a place, said in words, and
 * sized to the body it is on, measured from the points on its skin. A hat
 * sits on the head however big the head is, glasses sit on the face at the
 * eyes, a belt goes round the hips, and each thing is fixed to the bone of
 * the part it is on.
 */
import { describe, expect, it } from "vitest";
import {
  type BodyFit,
  type BodyPoints,
  fitFrom,
  type Piece,
  toggleWear,
  type V3,
  WEAR,
  wearPieces,
  wearTop,
  wearWords,
} from "./wear";

/** Points round a box, as a part of a body measures. */
function block(min: V3, max: V3): V3[] {
  const out: V3[] = [];
  for (const x of [min[0], (min[0] + max[0]) / 2, max[0]])
    for (const y of [min[1], (min[1] + max[1]) / 2, max[1]])
      for (const z of [min[2], (min[2] + max[2]) / 2, max[2]]) out.push([x, y, z]);
  return out;
}

/** A small robot with a big head, like the model the world ships with, `k` times its size. */
function robot(k = 1): BodyPoints {
  const s = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k];
  return {
    head: block(s([-0.2, 0.7, -0.17]), s([0.2, 1.06, 0.18])),
    neck: block(s([-0.05, 0.64, -0.05]), s([0.05, 0.7, 0.05])),
    chest: block(s([-0.15, 0.48, -0.1]), s([0.15, 0.66, 0.11])),
    hips: block(s([-0.13, 0.38, -0.09]), s([0.13, 0.48, 0.09])),
  };
}

const fit = fitFrom(robot()) as BodyFit;
const top = (p: Piece) => p.at[1] + p.size[1] / 2;
/** The lowest point of a piece: a dome and an arc rise from where they are put; the rest are put by their middle. */
const bottom = (p: Piece) => (p.shape === "dome" || p.shape === "arc" ? p.at[1] : p.at[1] - p.size[1] / 2);

describe("putting things on and taking them off", () => {
  it("puts a thing on, and takes it off again", () => {
    expect(toggleWear([], "glasses")).toEqual(["glasses"]);
    expect(toggleWear(["glasses", "scarf"], "glasses")).toEqual(["scarf"]);
  });

  it("wears one thing to a place: a cap goes on in place of a beret", () => {
    expect(toggleWear(["beret", "glasses"], "cap")).toEqual(["glasses", "cap"]);
    expect(toggleWear(["headset"], "wizard hat")).toEqual(["wizard hat"]);
  });

  it("wears no more than a body can, and nothing it can't", () => {
    expect(toggleWear(["cap", "glasses", "scarf", "lanyard"], "satchel")).toEqual([
      "glasses",
      "scarf",
      "lanyard",
      "satchel",
    ]);
    expect(toggleWear(["cap"], "crown")).toEqual(["cap"]);
  });

  it("says what is worn in words", () => {
    expect(wearWords([])).toBe("nothing");
    expect(wearWords(["glasses", "tool belt"])).toBe("glasses and a tool belt");
    expect(wearWords(["adventurer hat", "satchel", "scarf"])).toBe("an adventurer hat, a satchel and a scarf");
  });
});

describe("measuring a body for what it wears", () => {
  it("finds the head, the face at the eyes, the neck, the chest and the hips", () => {
    expect(fit.head).toEqual({ min: [-0.2, 0.7, -0.17], max: [0.2, 1.06, 0.18] });
    expect(fit.face.y).toBeCloseTo(0.7 + 0.36 * 0.52);
    expect(fit.face.z).toBeCloseTo(0.18);
    expect(fit.neck.y).toBeCloseTo(0.64);
    expect(fit.collar.y).toBeLessThan(fit.chest.max[1]);
    expect(fit.hips.max[1]).toBeCloseTo(0.48);
  });

  it("takes the eyes from the model when it says where they are", () => {
    expect(fitFrom(robot(), [0, 0.9, 0.1])?.face.y).toBe(0.9);
  });

  it("has nothing for a model with no head, and reckons a missing torso from the head", () => {
    expect(fitFrom({ head: [], neck: [], chest: [], hips: [] })).toBeUndefined();
    const headOnly = fitFrom({ head: robot().head, neck: [], chest: [], hips: [] }) as BodyFit;
    expect(headOnly.chest.max[1]).toBeCloseTo(0.7);
    expect(headOnly.hips.max[1]).toBeCloseTo(headOnly.chest.min[1]);
  });
});

describe("what each thing is made of", () => {
  it("makes every thing a body can wear, each piece fixed to the bone of the part it is on", () => {
    const bones: Record<string, string[]> = {
      headset: ["head"],
      glasses: ["head"],
      beret: ["head"],
      cap: ["head"],
      "wizard hat": ["head"],
      "adventurer hat": ["head"],
      scarf: ["chest"],
      "bow tie": ["chest"],
      lanyard: ["chest"],
      satchel: ["chest", "hips"],
      "tool belt": ["hips"],
    };
    expect(Object.keys(bones).sort()).toEqual(Object.keys(WEAR).sort());
    for (const thing of Object.keys(WEAR)) {
      const pieces = wearPieces(thing, fit);
      expect(pieces.length, thing).toBeGreaterThanOrEqual(2);
      expect(pieces.length, thing).toBeLessThanOrEqual(12);
      expect([...new Set(pieces.map((p) => p.bone))].sort(), thing).toEqual(bones[thing].sort());
      for (const p of pieces) for (const n of [...p.at, ...p.size]) expect(Number.isFinite(n), thing).toBe(true);
    }
    expect(wearPieces("crown", fit)).toEqual([]);
  });

  it("sits a hat on top of the head, as wide as the head", () => {
    for (const hat of ["beret", "cap", "wizard hat", "adventurer hat"]) {
      const [first, ...rest] = wearPieces(hat, fit);
      const lowest = Math.min(...[first, ...rest].map(bottom));
      // On the top of the head, not floating over it nor sunk to the eyes.
      expect(lowest, hat).toBeGreaterThan(fit.face.y);
      expect(lowest, hat).toBeLessThan(fit.head.max[1]);
      expect(Math.max(...[first, ...rest].map((p) => p.size[0])), hat).toBeGreaterThanOrEqual(0.4);
    }
    expect(wearTop(wearPieces("wizard hat", fit))).toBeGreaterThan(fit.head.max[1] + 0.3);
  });

  it("puts glasses on the face at the eyes, in front of it, either side of the middle", () => {
    const rims = wearPieces("glasses", fit).filter((p) => p.shape === "hoop");
    expect(rims).toHaveLength(2);
    for (const rim of rims) {
      expect(rim.at[1]).toBeCloseTo(fit.face.y);
      expect(rim.at[2]).toBeGreaterThan(fit.face.z);
    }
    expect(rims[0].at[0]).toBeCloseTo(-rims[1].at[0]);
  });

  it("puts a headset's ear cups at the sides of the head, and its band over the top", () => {
    const pieces = wearPieces("headset", fit);
    const cups = pieces.filter((p) => p.shape === "cyl" && p.tone === "main");
    for (const cup of cups) expect(Math.abs(cup.at[0])).toBeGreaterThanOrEqual(0.2);
    expect(wearTop(pieces)).toBeGreaterThanOrEqual(fit.head.max[1]);
  });

  it("goes round the neck, round the hips, and on the front of the chest", () => {
    const [scarf] = wearPieces("scarf", fit);
    expect(scarf.size[0]).toBeGreaterThan(fit.neck.radius * 2);
    expect(scarf.at[1]).toBeGreaterThanOrEqual(fit.neck.y);
    const [belt] = wearPieces("tool belt", fit);
    expect(belt.size[0]).toBeGreaterThan(fit.hips.max[0] - fit.hips.min[0]);
    expect(belt.at[1]).toBeGreaterThan(fit.hips.min[1]);
    expect(belt.at[1]).toBeLessThan(fit.hips.max[1]);
    const card = wearPieces("lanyard", fit).find((p) => p.tone === "paper") as Piece;
    expect(card.at[2]).toBeGreaterThan(fit.chest.max[2]);
    expect(top(card)).toBeLessThan(fit.collar.y);
  });

  it("is sized to the body: a body twice the size wears everything twice the size", () => {
    const big = fitFrom(robot(2)) as BodyFit;
    for (const thing of Object.keys(WEAR)) {
      const small = wearPieces(thing, fit);
      const large = wearPieces(thing, big);
      for (const [i, p] of small.entries())
        for (let k = 0; k < 3; k++) {
          expect(large[i].at[k], thing).toBeCloseTo(p.at[k] * 2, 5);
          expect(large[i].size[k], thing).toBeCloseTo(p.size[k] * 2, 5);
        }
    }
  });
});
