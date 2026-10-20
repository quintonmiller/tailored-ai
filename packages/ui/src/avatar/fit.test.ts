/**
 * Fitting a hold to the body: the hand brought to the side of the head by
 * turning the arm, measured from where the shoulder, elbow and wrist stand.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type Arm, type ArmTurn, earAt, handAt, reach } from "./fit";

/** A grown-up in the T-pose, facing +z: the right arm straight out to −x at shoulder height. */
const PERSON: Arm = { shoulder: [-0.18, 1.42, 0], elbow: [-0.45, 1.42, 0], hand: [-0.7, 1.42, 0] };
/** A small robot with a big head and short arms, its arms hanging part way down as made. */
const ROBOT: Arm = { shoulder: [-0.134, 0.623, 0.014], elbow: [-0.228, 0.55, 0.016], hand: [-0.355, 0.406, 0.003] };
/** The elbow out, down and a little forward, as when holding a phone to the ear. */
const ELBOW: [number, number, number] = [-1, -1, 0.35];

const v = (p: [number, number, number]) => new THREE.Vector3(...p);

/** Which way the palm faces with the arm turned so: down as made, square to the forearm. */
function palmOf(arm: Arm, turn: ArmTurn): THREE.Vector3 {
  const along = v(arm.hand).sub(v(arm.elbow)).normalize();
  const face = new THREE.Vector3(0, -1, 0);
  face.sub(along.clone().multiplyScalar(face.dot(along))).normalize();
  const upper = new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn.upper));
  const lower = new THREE.Quaternion().setFromEuler(new THREE.Euler(...turn.lower));
  return face.applyQuaternion(upper.multiply(lower));
}

describe("turning the arm", () => {
  it("leaves the hand where it was made with the arm not turned, and swings it round the shoulder when it is", () => {
    const still = handAt(PERSON, { upper: [0, 0, 0], lower: [0, 0, 0] });
    expect(still.hand.toArray()).toEqual(PERSON.hand);
    // Down by the side: the upper arm turned a right angle about z.
    const down = handAt(PERSON, { upper: [0, 0, Math.PI / 2], lower: [0, 0, 0] });
    expect(down.hand.x).toBeCloseTo(-0.18, 5);
    expect(down.hand.y).toBeCloseTo(1.42 - 0.52, 5);
  });
});

describe("reaching", () => {
  it("brings a grown-up's hand to the side of its head, the elbow below the hand", () => {
    const target: [number, number, number] = [-0.13, 1.55, 0.03];
    const turn = reach(PERSON, target, { elbow: ELBOW });
    expect(turn.miss).toBeLessThan(0.001);
    const { elbow, hand } = handAt(PERSON, turn);
    expect(hand.distanceTo(v(target))).toBeLessThan(0.001);
    // The elbow where it was asked to point: below the hand, out to the side and in front of the shoulder.
    expect(elbow.y).toBeLessThan(hand.y);
    expect(elbow.x).toBeLessThan(PERSON.shoulder[0]);
    expect(elbow.z).toBeGreaterThan(0);
    // Each bone still as long as it was made.
    expect(elbow.distanceTo(v(PERSON.shoulder))).toBeCloseTo(0.27, 5);
    expect(hand.distanceTo(elbow)).toBeCloseTo(0.25, 5);
  });

  it("brings a big-headed robot's short arm up beside its head", () => {
    const head = {
      min: [-0.19, 0.66, -0.17] as [number, number, number],
      max: [0.19, 1.06, 0.16] as [number, number, number],
    };
    const target = earAt({ head, face: { y: 0.86, z: 0.16, half: 0.19 } }, 0.03);
    const turn = reach(ROBOT, target, { elbow: ELBOW });
    expect(turn.miss).toBeLessThan(0.001);
    // Outside the head, not in it.
    expect(handAt(ROBOT, turn).hand.x).toBeLessThan(head.min[0]);
  });

  it("stretches toward a place out of reach as far as the arm goes", () => {
    const target: [number, number, number] = [-0.18, 2.4, 0];
    const turn = reach(PERSON, target, { elbow: ELBOW });
    // Shoulder to wrist is 0.52 m; the target is 0.98 m off.
    expect(turn.miss).toBeCloseTo(0.98 - 0.52, 3);
    expect(handAt(PERSON, turn).hand.y).toBeGreaterThan(1.42 + 0.45);
  });

  it("turns the forearm for the palm to face where it is asked, leaving the hand where it is", () => {
    const target: [number, number, number] = [-0.13, 1.55, 0.03];
    const plain = reach(PERSON, target, { elbow: ELBOW });
    const facing = reach(PERSON, target, { elbow: ELBOW, palm: [1, 0, 0] });
    const { elbow, hand } = handAt(PERSON, facing);
    expect(hand.distanceTo(handAt(PERSON, plain).hand)).toBeLessThan(1e-6);
    // Square to the forearm, a palm faces the way asked as near as the forearm's own way lets it.
    const along = hand.clone().sub(elbow).normalize();
    const best = Math.sqrt(1 - along.x ** 2);
    expect(palmOf(PERSON, facing).x).toBeGreaterThan(0.99 * best);
    expect(palmOf(PERSON, plain).x).toBeLessThan(0.9 * best);
  });
});

describe("the ear", () => {
  it("is just outside the right side of the head, below the eyes, a little in front of the middle", () => {
    const head = {
      min: [-0.1, 1.5, -0.12] as [number, number, number],
      max: [0.1, 1.75, 0.1] as [number, number, number],
    };
    const [x, y, z] = earAt({ head, face: { y: 1.64, z: 0.1, half: 0.08 } }, 0.04);
    expect(x).toBeCloseTo(-0.14, 5);
    expect(y).toBeLessThan(1.64);
    expect(y).toBeGreaterThan(1.5);
    expect(z).toBeGreaterThan(-0.01);
    expect(z).toBeLessThan(0.1);
  });
});
