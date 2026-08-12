/**
 * How a run reports the way its turn ended, and what the grader does with it.
 *
 * The room path recorded nothing here until #521 — 132 of 237 runs in the
 * 2026-08-12 cohort — and the grader covered for it by matching
 * `[Agent stopped: …]` in the reply. That regex has never matched anything: all
 * 12 stalls in the same cohort came back as ordinary prose, because a turn that
 * runs out of rounds gets one tools-withheld call so it can explain itself.
 *
 * So the room path had no stall detection. It had a fallback that looked like
 * one, which is worse, because a check nobody expects to fire is a check nobody
 * goes back to.
 */

import { describe, expect, it } from "vitest";
import { grade } from "../graders.js";
import { stopForRun } from "../harness.js";
import type { RunOutcome, Scenario } from "../types.js";

function outcome(reply: string, stop?: RunOutcome["stop"]): RunOutcome {
  return {
    reply,
    calls: [],
    executions: [],
    posts: [],
    requests: [],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    stop,
  };
}

const scenario = (expect_: Scenario["expect"]): Scenario =>
  ({ id: "s", category: "c", intent: "i", expect: expect_ }) as Scenario;

describe("stopForRun", () => {
  it("prefers a stall to a later clean ending", async () => {
    // The shape a coordination scenario produces: one agent gets stuck, the
    // next takes its turn and finishes normally. Taking the last stop would
    // report the run as clean, and the stall would exist nowhere.
    expect(
      stopForRun([{ kind: "repeated-calls", period: 1 }, { kind: "complete" }, { kind: "tool-ended", tool: "room" }]),
    ).toEqual({ kind: "repeated-calls", period: 1 });
  });

  it("takes the last ending when nothing stalled", async () => {
    expect(stopForRun([{ kind: "complete" }, { kind: "tool-ended", tool: "room" }])).toEqual({
      kind: "tool-ended",
      tool: "room",
    });
  });

  it("has nothing to report when no turn ran", async () => {
    expect(stopForRun([])).toBeUndefined();
  });
});

describe("replies, against a stall", () => {
  it("fails a stall that answered in ordinary prose", async () => {
    // The case that scored 3/3 for a year. Nothing in the text gives it away —
    // only the structured stop does.
    const checks = await grade(
      scenario([{ replies: true }]),
      outcome("Dana. You mentioned it earlier.", { kind: "max-rounds", rounds: 8, answered: true }),
    );

    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain("stalled");
  });

  it("fails a stall even where silence was the right answer", async () => {
    // `replies: false` asserts the agent *chose* not to speak. A turn that went
    // in circles until the detector fired made no such choice, so it must not
    // collect the point for the silence that resulted.
    const checks = await grade(scenario([{ replies: false }]), outcome("", { kind: "repeated-calls", period: 2 }));

    expect(checks[0].pass).toBe(false);
  });

  it("passes a turn that ended cleanly", async () => {
    const checks = await grade(scenario([{ replies: true }]), outcome("status is green", { kind: "complete" }));

    expect(checks[0].pass).toBe(true);
  });

  it("does not read a marker in the text as a stall", async () => {
    // Deliberate. The marker is what a caller-requested abort looks like too
    // (`[Agent stopped: shutdown requested]`), so matching it files an operator
    // pulling the plug as an agent that got stuck — the same conflation
    // `task-watcher` refuses for the same reason. With no stop recorded, the
    // honest answer is that we do not know whether it stalled.
    const checks = await grade(
      scenario([{ replies: true }]),
      outcome("[Agent stopped: repeated identical tool calls detected]"),
    );

    expect(checks[0].pass).toBe(true);
  });
});
