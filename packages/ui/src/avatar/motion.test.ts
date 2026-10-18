/**
 * The avatar's own movement: a pose for each moment of a turn, eased into,
 * a mouth that follows the voice, and blinks — all from time alone.
 */
import { describe, expect, it } from "vitest";
import { type BodyState, Motion, type Pose } from "./motion";

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
});
