/**
 * The avatar's own movement: a pose for each moment of a turn, eased into,
 * a mouth that follows the voice, and blinks — all from time alone.
 */

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { EMOTES, type WalkStyle, walkStyle } from "./body";
import { asMade, type BodyState, type Carriage, MOVES, Motion, type Pose } from "./motion";
import { GESTURES } from "./scene";

/** Run at 60 fps from `from` for `seconds`, returning the last pose. */
function run(motion: Motion, state: BodyState, seconds: number, loudness = 0, from = 0): Pose {
  let pose = motion.step(from, state, loudness);
  for (let t = from; t <= from + seconds; t += 1 / 60) pose = motion.step(t, state, loudness);
  return pose;
}

/** A fixed random, so blinks land at known times. */
const steady = () => 0.5;

describe("Motion", () => {
  it("stands with its arms down, not in the T-pose the model is rigged in", () => {
    const pose = new Motion({ random: steady }).step(0, "idle", 0);
    expect(pose.bones.leftUpperArm[2]).toBeLessThan(-1);
    expect(pose.bones.rightUpperArm[2]).toBeGreaterThan(1);
  });

  it("leans in with its head tilted while you talk", () => {
    const idle = run(new Motion({ random: steady }), "idle", 2);
    const listening = run(new Motion({ random: steady }), "listening", 2);
    expect(listening.bones.spine[0]).toBeGreaterThan(idle.bones.spine[0] + 0.03);
    expect(listening.bones.head[2]).toBeGreaterThan(idle.bones.head[2] + 0.05);
  });

  it("looks up and away while it thinks", () => {
    const pose = run(new Motion({ random: steady }), "thinking", 2);
    expect(pose.bones.head[0]).toBeLessThan(-0.05);
    expect(pose.bones.head[1]).toBeGreaterThan(0.1);
    expect(pose.gaze[1]).toBeGreaterThan(0.2);
  });

  it("eases into a new moment instead of snapping to it", () => {
    const motion = new Motion({ random: steady });
    run(motion, "idle", 1);
    const first = motion.step(1 + 1 / 60, "thinking", 0);
    const settled = run(motion, "thinking", 2, 0, 1 + 2 / 60);
    // The gaze has no idle drift, so it shows the blend alone.
    expect(first.gaze[0]).toBeGreaterThan(0);
    expect(first.gaze[0]).toBeLessThan(settled.gaze[0] / 4);
  });

  it("opens its mouth with the voice and closes it in the gaps", () => {
    const motion = new Motion({ random: steady });
    const loud = run(motion, "speaking", 0.3, 1);
    expect(loud.expressions.aa).toBeGreaterThan(0.9);
    const quiet = run(motion, "speaking", 0.3, 0, 0.4);
    expect(quiet.expressions.aa).toBeLessThan(0.05);
  });

  it("keeps its mouth shut unless it is the one speaking", () => {
    const pose = run(new Motion({ random: steady }), "listening", 0.5, 1);
    expect(pose.expressions.aa).toBe(0);
  });

  it("blinks every few seconds, briefly, with its eyes open in between", () => {
    const motion = new Motion({ random: steady });
    const closed: number[] = [];
    for (let t = 0; t < 12; t += 1 / 120) if (motion.step(t, "idle", 0).expressions.blink > 0.5) closed.push(t);
    expect(closed.length).toBeGreaterThan(0);
    // Group the closed frames into blinks: each under a third of a second, two to six seconds apart.
    const blinks = closed.filter((t, i) => i === 0 || t - closed[i - 1] > 0.5);
    expect(blinks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < blinks.length; i++) expect(blinks[i] - blinks[i - 1]).toBeGreaterThanOrEqual(2);
    expect(closed.length / blinks.length / 120).toBeLessThan(0.3);
  });

  it("drifts far less when reduced motion is asked for, but still takes each pose", () => {
    const sway = (motion: Motion) => {
      const ys: number[] = [];
      for (let t = 0; t < 10; t += 1 / 30) ys.push(motion.step(t, "idle", 0).bones.head[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(sway(new Motion({ random: steady, reducedMotion: true }))).toBeLessThan(
      sway(new Motion({ random: steady })) / 2,
    );
    const thinking = run(new Motion({ random: steady, reducedMotion: true }), "thinking", 2);
    expect(thinking.bones.head[1]).toBeGreaterThan(0.15);
  });

  it("swings its legs against each other, and its arms against its legs, while it walks", () => {
    const motion = new Motion({ random: steady });
    const swings: number[][] = [];
    for (let t = 0; t < 2; t += 1 / 60) {
      const p = motion.step(t, "idle", 0, { walked: 0.5 / 60, stride: 0.45 });
      swings.push([p.bones.leftUpperLeg[0], p.bones.rightUpperLeg[0], p.bones.leftUpperArm[0]]);
    }
    const late = swings.slice(30);
    const range = (i: number) => Math.max(...late.map((s) => s[i])) - Math.min(...late.map((s) => s[i]));
    expect(range(0)).toBeGreaterThan(0.5);
    for (const [left, right, arm] of late) {
      expect(Math.sign(left)).not.toBe(Math.sign(right) || Math.sign(left) * -1);
      if (Math.abs(left) > 0.2) expect(Math.sign(arm)).toBe(-Math.sign(left));
    }
  });

  it("stands with straight legs once it stops walking", () => {
    const motion = new Motion({ random: steady });
    for (let t = 0; t < 1; t += 1 / 60) motion.step(t, "idle", 0, { walked: 0.01, stride: 0.45 });
    const still = run(motion, "idle", 1, 0, 1);
    expect(Math.abs(still.bones.leftUpperLeg[0])).toBeLessThan(0.01);
    expect(still.lift).toBeLessThan(0.001);
  });

  it("sits down at a seat: thighs level, knees bent, settled onto it", () => {
    const motion = new Motion({ random: steady });
    let pose = motion.step(0, "idle", 0, { walked: 0, stride: 0.45, activity: "sit" });
    for (let t = 0; t < 3; t += 1 / 60) pose = motion.step(t, "idle", 0, { walked: 0, stride: 0.45, activity: "sit" });
    expect(pose.seated).toBeGreaterThan(0.95);
    expect(pose.bones.leftUpperLeg[0]).toBeLessThan(-1.3);
    expect(pose.bones.leftLowerLeg[0]).toBeGreaterThan(1.3);
  });

  it("doesn't start an activity while still walking", () => {
    const motion = new Motion({ random: steady });
    let pose = motion.step(0, "idle", 0);
    for (let t = 0; t < 2; t += 1 / 60)
      pose = motion.step(t, "idle", 0, { walked: 0.01, stride: 0.45, activity: "sit" });
    expect(pose.seated).toBeLessThan(0.01);
  });

  it("reaches for the keyboard and looks down at the desk", () => {
    const motion = new Motion({ random: steady });
    const rest = run(new Motion({ random: steady }), "idle", 2);
    let pose = motion.step(0, "idle", 0);
    for (let t = 0; t < 2; t += 1 / 60) pose = motion.step(t, "idle", 0, { walked: 0, stride: 0.45, activity: "type" });
    expect(pose.bones.leftUpperArm[0]).toBeLessThan(rest.bones.leftUpperArm[0] - 0.6);
    expect(pose.bones.head[0]).toBeGreaterThan(rest.bones.head[0] + 0.1);
  });

  it("waves when asked: right arm up, then back down once the wave is over", () => {
    const motion = new Motion({ random: steady });
    run(motion, "idle", 1);
    expect(motion.gesture("wave", 1)).toBe(true);
    const mid = run(motion, "speaking", 0.6, 0, 1.02);
    expect(mid.bones.rightUpperArm[2]).toBeLessThan(0);
    const after = run(motion, "idle", 2, 0, 1.7);
    expect(after.bones.rightUpperArm[2]).toBeGreaterThan(1);
  });

  it("nods and shakes the head", () => {
    const rest = run(new Motion({ random: steady }), "idle", 1);
    const nodding = new Motion({ random: steady });
    run(nodding, "idle", 1);
    nodding.gesture("nod", 1);
    expect(nodding.step(1.25, "idle", 0).bones.head[0]).toBeGreaterThan(rest.bones.head[0] + 0.05);
    const shaking = new Motion({ random: steady });
    run(shaking, "idle", 1);
    shaking.gesture("shake", 1);
    const turns = [1.1, 1.2, 1.3, 1.4, 1.5].map((t) => shaking.step(t, "idle", 0).bones.head[1]);
    expect(Math.max(...turns) - Math.min(...turns)).toBeGreaterThan(0.2);
  });

  it("has a move for every gesture an agent can ask its body for", () => {
    for (const e of [...EMOTES, ...GESTURES]) expect(MOVES).toContain(e);
  });

  it("keeps a gesture going for as long as it was asked, round and round, then lets it go", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    run(motion, "idle", 1);
    motion.gesture("wave", 1, 7);
    // Long past one wave, the arm is still up and the forearm still swinging.
    const swings = [5, 5.1, 5.2, 5.3].map((t) => motion.step(t, "idle", 0));
    for (const pose of swings) expect(pose.bones.rightUpperArm[2]).toBeLessThan(0);
    const forearm = swings.map((p) => p.bones.rightLowerArm[2]);
    expect(Math.max(...forearm) - Math.min(...forearm)).toBeGreaterThan(0.3);
    const after = run(motion, "idle", 1, 0, 7.05);
    expect(after.bones.rightUpperArm[2]).toBeGreaterThan(1);
  });

  it("takes the arms over for a gesture, rather than clapping on top of typing", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    const typing = { walked: 0, stride: 0.45, activity: "type" as const };
    let pose = motion.step(0, "idle", 0, typing);
    for (let t = 0; t < 2; t += 1 / 60) pose = motion.step(t, "idle", 0, typing);
    expect(pose.bones.rightUpperArm[0]).toBeLessThan(-0.6);
    motion.gesture("clap", 2, 6);
    for (let t = 2; t < 3.5; t += 1 / 60) pose = motion.step(t, "idle", 0, typing);
    // The arm as the clap has it, not the typing arm with the clap added.
    expect(Math.abs(pose.bones.rightUpperArm[0])).toBeLessThan(0.1);
    expect(pose.bones.rightUpperArm[1]).toBeGreaterThan(1);
  });

  it("raises an arm in a gesture as far again as the model's arms hang as made, and only then", () => {
    const wave = (droop: number) => {
      const motion = new Motion({ random: steady, reducedMotion: true });
      motion.armDroop = droop;
      run(motion, "idle", 1);
      motion.gesture("wave", 1);
      return run(motion, "idle", 0.6, 0, 1.02);
    };
    expect(wave(0.6).bones.rightUpperArm[2]).toBeCloseTo(wave(0).bones.rightUpperArm[2] - 0.6, 1);
    // At rest the arms hang as they always have.
    const rest = new Motion({ random: steady, reducedMotion: true });
    rest.armDroop = 0.6;
    expect(run(rest, "idle", 1).bones.rightUpperArm[2]).toBeCloseTo(
      run(new Motion({ random: steady, reducedMotion: true }), "idle", 1).bones.rightUpperArm[2],
      3,
    );
  });

  it("turns an arm made in an A-pose to point where the same turn points a T-posed arm, forearm and all", () => {
    const droop = 0.66;
    const q = (r: [number, number, number]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...r));
    // The right arm along -x in a T-pose; made hanging `droop` below level, straight at the elbow.
    const tPose = new THREE.Vector3(-1, 0, 0);
    const made = tPose.clone().applyAxisAngle(new THREE.Vector3(0, 0, 1), droop);
    const upper: [number, number, number] = [0, 1.2, 0.25];
    const lower: [number, number, number] = [0, 1.1, 0];
    const want = {
      upper: tPose.clone().applyQuaternion(q(upper)),
      fore: tPose.clone().applyQuaternion(q(upper).multiply(q(lower))),
    };
    const up = q(asMade(upper, "rightUpperArm", droop));
    const lo = q(asMade(lower, "rightLowerArm", droop));
    expect(made.clone().applyQuaternion(up).distanceTo(want.upper)).toBeLessThan(1e-6);
    expect(made.clone().applyQuaternion(up.clone().multiply(lo)).distanceTo(want.fore)).toBeLessThan(1e-6);
    // Made in a T-pose, nothing changes.
    const same = asMade(upper, "rightUpperArm", 0);
    for (let i = 0; i < 3; i++) expect(same[i]).toBeCloseTo(upper[i], 6);
  });

  it("ends a gesture kept going when told to stop", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    run(motion, "idle", 1);
    motion.gesture("clap", 1, 30);
    run(motion, "idle", 1, 0, 1.02);
    motion.stopGestures(2);
    expect(run(motion, "idle", 1, 0, 2.02).bones.rightUpperArm[0]).toBeGreaterThan(-0.1);
  });

  it("cheers with both arms up, and jumps clear of the floor", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    run(motion, "idle", 1);
    motion.gesture("cheer", 1);
    const cheer = run(motion, "idle", 0.7, 0, 1.02);
    expect(cheer.bones.leftUpperArm[2]).toBeGreaterThan(0.8);
    expect(cheer.bones.rightUpperArm[2]).toBeLessThan(-0.8);
    const jumper = new Motion({ random: steady, reducedMotion: true });
    run(jumper, "idle", 1);
    jumper.gesture("jump", 1);
    const lifts = [1.3, 1.45, 1.55, 1.65].map((t) => jumper.step(t, "idle", 0).lift);
    expect(Math.max(...lifts)).toBeGreaterThan(0.15);
    expect(run(jumper, "idle", 1, 0, 2.2).lift).toBeLessThan(0.001);
  });

  it("stands the way its posture says: slouched forward, proud and upright, shy with its head down", () => {
    const stand = (posture?: Carriage["posture"]) => {
      const motion = new Motion({ random: steady, reducedMotion: true });
      if (posture) motion.carry({ posture });
      return run(motion, "idle", 1);
    };
    const plain = stand();
    expect(stand("slouched").bones.spine[0]).toBeGreaterThan(plain.bones.spine[0] + 0.1);
    expect(stand("proud").bones.chest[0]).toBeLessThan(plain.bones.chest[0] - 0.05);
    expect(stand("shy").bones.head[0]).toBeGreaterThan(plain.bones.head[0] + 0.15);
  });

  it("folds its arms only while they have nothing else to do", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    motion.carry({ posture: "arms folded" });
    const folded = run(motion, "idle", 2);
    expect(folded.bones.rightLowerArm[1]).toBeGreaterThan(1.5);
    motion.hold("chest");
    const holding = run(motion, "idle", 2, 0, 2.02);
    expect(holding.bones.leftLowerArm[1]).toBeGreaterThan(-0.5);
  });

  it("fidgets as much as its idle style says, and droops when sleepy", () => {
    const sway = (carriage: Carriage) => {
      const motion = new Motion({ random: steady });
      motion.carry(carriage);
      const ys: number[] = [];
      for (let t = 0; t < 10; t += 1 / 30) ys.push(motion.step(t, "idle", 0).bones.head[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(sway({ idle: "lively", drift: 1.7 })).toBeGreaterThan(sway({}) * 1.4);
    expect(sway({ idle: "calm", drift: 0.6 })).toBeLessThan(sway({}) * 0.8);
    const sleepy = new Motion({ random: steady, reducedMotion: true });
    sleepy.carry({ idle: "sleepy" });
    expect(run(sleepy, "idle", 1).bones.head[0]).toBeGreaterThan(
      run(new Motion({ random: steady, reducedMotion: true }), "idle", 1).bones.head[0] + 0.04,
    );
  });

  it("walks the way it chose: bouncing in each step, or leaning into a sneak on bent knees", () => {
    const walk = (style?: WalkStyle) => {
      const motion = new Motion({ random: steady, reducedMotion: true });
      if (style) motion.carry({ walk: style });
      const poses: Pose[] = [];
      for (let t = 0; t < 2; t += 1 / 60) poses.push(motion.step(t, "idle", 0, { walked: 0.8 / 60, stride: 0.45 }));
      return poses.slice(60);
    };
    const top = (poses: Pose[]) => Math.max(...poses.map((p) => p.lift));
    expect(top(walk(walkStyle("bouncy")))).toBeGreaterThan(top(walk()) + 0.02);
    const sneak = walk(walkStyle("sneak"));
    expect(sneak.at(-1)?.bones.spine[0]).toBeGreaterThan(0.2);
    expect(Math.min(...sneak.map((p) => p.lift))).toBeLessThan(-0.05);
    // With a sneak clip to play, the clip leans: no lean added on top.
    const clipped = new Motion({ random: steady, reducedMotion: true });
    clipped.carry({ walk: walkStyle("sneak") });
    let pose = clipped.step(0, "idle", 0);
    const clips = { walk: true, activities: [], styledWalk: true };
    for (let t = 0; t < 1; t += 1 / 60) pose = clipped.step(t, "idle", 0, { walked: 0.5 / 60, stride: 0.45, clips });
    expect(Math.abs(pose.bones.spine[0])).toBeLessThan(0.05);
  });

  it("has no move for a gesture it doesn't know", () => {
    expect(new Motion({ random: steady }).gesture("juggle", 0)).toBe(false);
  });

  it("turns its head toward something it is told to look at, then back", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    run(motion, "idle", 1);
    motion.look(0.6, 0.2, 1);
    const looking = run(motion, "idle", 1, 0, 1.02);
    expect(looking.bones.head[1]).toBeGreaterThan(0.45);
    expect(looking.bones.head[0]).toBeLessThan(-0.1);
    const back = run(motion, "idle", 3, 0, 2.1);
    expect(Math.abs(back.bones.head[1])).toBeLessThan(0.1);
  });

  it("with animation files playing, returns only what goes on top: no rest pose, walk cycle or breathing", () => {
    const motion = new Motion({ random: steady });
    let pose = motion.step(0, "idle", 0);
    const clips = { walk: true, activities: ["sit" as const] };
    for (let t = 0; t < 2; t += 1 / 60) pose = motion.step(t, "idle", 0, { walked: 0.5 / 60, stride: 0.45, clips });
    expect(Math.abs(pose.bones.leftUpperArm[2])).toBeLessThan(0.05);
    expect(Math.abs(pose.bones.leftUpperLeg[0])).toBeLessThan(0.01);
    expect(pose.lift).toBe(0);
  });

  it("with animation files playing, lets an arm gesture take the arm over instead of adding to it", () => {
    const motion = new Motion({ random: steady });
    const clips = { walk: true, activities: [] };
    motion.step(0, "idle", 0, { walked: 0, stride: 0.45, clips });
    motion.gesture("wave", 0);
    const pose = motion.step(0.8, "idle", 0, { walked: 0, stride: 0.45, clips });
    expect(pose.owned?.weight).toBeGreaterThan(0.9);
    expect(pose.owned?.bones.rightUpperArm?.[2]).toBeCloseTo(-0.9, 1);
    expect(Math.abs(pose.bones.rightUpperArm[2])).toBeLessThan(0.05);
  });

  it("holds something in front of its chest, looking down at it, and lets the arm fall when it lets go", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    const rest = motion.step(0, "idle", 0);
    motion.hold("chest");
    let pose = rest;
    for (let t = 0; t <= 2; t += 1 / 60) pose = motion.step(t, "idle", 0);
    // The arm forward and the elbow bent, the head down: from rest, not just near it.
    expect(pose.bones.rightUpperArm[0]).toBeLessThan(rest.bones.rightUpperArm[0] - 0.7);
    expect(pose.bones.rightLowerArm[1]).toBeGreaterThan(rest.bones.rightLowerArm[1] + 1.2);
    expect(pose.bones.head[0]).toBeGreaterThan(rest.bones.head[0] + 0.2);
    // The other arm is its own.
    for (let i = 0; i < 3; i++) expect(pose.bones.leftUpperArm[i]).toBeCloseTo(rest.bones.leftUpperArm[i], 1);
    motion.hold(undefined);
    for (let t = 2; t <= 4; t += 1 / 60) pose = motion.step(t, "idle", 0);
    expect(pose.bones.rightUpperArm[0]).toBeCloseTo(rest.bones.rightUpperArm[0], 1);
  });

  it("with animation files playing, takes the arm over to hold something, unless a gesture has it", () => {
    const motion = new Motion({ random: steady });
    const clips = { walk: true, activities: [] };
    motion.hold("up");
    let pose = motion.step(0, "idle", 0, { walked: 0, stride: 0.45, clips });
    for (let t = 0; t <= 2; t += 1 / 60) pose = motion.step(t, "idle", 0, { walked: 0, stride: 0.45, clips });
    expect(pose.owned?.weight).toBeGreaterThan(0.95);
    expect(pose.owned?.bones.rightUpperArm?.[0]).toBeCloseTo(-1.35, 1);
    motion.gesture("wave", 2);
    pose = motion.step(2.8, "idle", 0, { walked: 0, stride: 0.45, clips });
    expect(pose.owned?.bones.rightUpperArm?.[2]).toBeCloseTo(-0.9, 1);
  });

  it("holds a phone to the ear in the pose measured for its own body, with files playing or not", () => {
    const ear = {
      upper: [-2.1, 0, 0.6] as [number, number, number],
      lower: [0.3, 1.9, -0.2] as [number, number, number],
    };
    const coded = new Motion({ random: steady, reducedMotion: true });
    coded.armClearance = 0.3;
    coded.ear = ear;
    coded.hold("ear");
    let pose = coded.step(0, "idle", 0);
    for (let t = 0; t <= 2; t += 1 / 60) pose = coded.step(t, "idle", 0);
    // The arm ends turned as measured: the swing out for a wide body taken back off it, as the pose adds it.
    for (let i = 0; i < 3; i++) {
      expect(pose.bones.rightUpperArm[i]).toBeCloseTo(ear.upper[i], 1);
      expect(pose.bones.rightLowerArm[i]).toBeCloseTo(ear.lower[i], 1);
    }
    const filed = new Motion({ random: steady });
    filed.armClearance = 0.3;
    filed.ear = ear;
    filed.hold("ear");
    const clips = { walk: true, activities: [] };
    for (let t = 0; t <= 2; t += 1 / 60) pose = filed.step(t, "idle", 0, { walked: 0, stride: 0.45, clips });
    for (let i = 0; i < 3; i++) {
      expect(pose.owned?.bones.rightUpperArm?.[i]).toBeCloseTo(ear.upper[i], 5);
      expect(pose.owned?.bones.rightLowerArm?.[i]).toBeCloseTo(ear.lower[i], 5);
    }
  });

  it("dozes: eyes shut, chin down; and wakes", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    const awake = motion.step(0, "idle", 0);
    motion.doze(true);
    let pose = awake;
    for (let t = 0; t <= 5; t += 1 / 60) pose = motion.step(t, "idle", 0);
    expect(pose.expressions.blink).toBeGreaterThan(0.95);
    expect(pose.bones.head[0]).toBeGreaterThan(awake.bones.head[0] + 0.3);
    motion.doze(false);
    for (let t = 5; t <= 10; t += 1 / 60) pose = motion.step(t, "idle", 0);
    expect(pose.bones.head[0]).toBeLessThan(awake.bones.head[0] + 0.1);
  });

  it("swings the arms out by the clearance the body needs", () => {
    const motion = new Motion({ random: steady, reducedMotion: true });
    motion.armClearance = 0.3;
    const pose = motion.step(0, "idle", 0);
    expect(pose.bones.leftUpperArm[2]).toBeCloseTo(-1.2 + 0.3, 1);
    expect(pose.bones.rightUpperArm[2]).toBeCloseTo(1.2 - 0.3, 1);
  });
});
