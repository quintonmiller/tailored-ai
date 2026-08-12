/**
 * Partial credit, and the ways it could quietly lie.
 *
 * A milestone ladder replaces one bit with a curve, which is the point — and it
 * introduces a new way for a benchmark to overstate itself, because a step that
 * *cannot be graded* now contributes points instead of failing loudly. The
 * skipped-check rule is the guard, and it is the reason this file exists rather
 * than a couple of assertions bolted onto the grader tests.
 */

import { describe, expect, it } from "vitest";
import { grade, milestoneScore, scoreMilestones } from "../graders.js";
import { loadScenarios } from "../schema.js";
import type { RunOutcome, Scenario } from "../types.js";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    reply: "",
    calls: [],
    executions: [],
    posts: [],
    requests: [],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    ...over,
  };
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: "ladder",
    category: "orchestration",
    intent: "partial credit",
    difficulty: 8,
    message: "go",
    milestones: [
      { id: "looked", points: 1, when: { calls_tool: "read" } },
      { id: "acted", points: 4, when: { calls_tool: "exec" } },
      { id: "finished", points: 5, when: { reply_matches: "done" } },
    ],
    expect: [{ score_at_least: 0.5 }],
    ...over,
  } as Scenario;
}

describe("milestone scoring", () => {
  it("awards the points of the steps reached and none of the others", async () => {
    const results = await scoreMilestones(
      scenario(),
      outcome({
        calls: [
          { name: "read", args: {} },
          { name: "exec", args: {} },
        ],
      }),
    );

    expect(results.map((m) => [m.id, m.reached])).toEqual([
      ["looked", true],
      ["acted", true],
      ["finished", false],
    ]);
    expect(milestoneScore(results)).toEqual({ earned: 5, possible: 10, fraction: 0.5 });
  });

  it("keeps the reason a step was missed", async () => {
    const results = await scoreMilestones(scenario(), outcome());
    expect(results[0].detail).toContain("expected a call to read");
  });

  it("does not award a step whose check was skipped for want of input", async () => {
    // The failure this rules out is total and silent: an old report with the
    // field stripped would score full marks on every world milestone, and the
    // regression it was meant to catch would render as an improvement.
    const world = scenario({
      world: { state: { power: "off" }, rules: [{ tool: "exec", then: "on", sets: { power: "on" } }], goal: {} },
      milestones: [{ id: "powered", points: 10, when: { world_state: { power: "on" } } }],
    });

    const results = await scoreMilestones(world, outcome());
    expect(results[0].reached).toBe(false);
    expect(milestoneScore(results).fraction).toBe(0);
  });

  it("scores a crashed run at zero rather than skipping it", async () => {
    const results = await scoreMilestones(scenario(), outcome({ error: "boom" }));
    expect(results.every((m) => !m.reached)).toBe(true);
    expect(results[0].detail).toBe("the run failed");
  });

  it("reports zero possible as zero, never as complete", async () => {
    expect(milestoneScore([])).toEqual({ earned: 0, possible: 0, fraction: 0 });
  });
});

describe("score_at_least", () => {
  it("passes on the threshold and fails below it", async () => {
    const halfway = outcome({
      calls: [
        { name: "read", args: {} },
        { name: "exec", args: {} },
      ],
    });
    expect((await grade(scenario(), halfway))[0].pass).toBe(true);

    const barely = outcome({ calls: [{ name: "read", args: {} }] });
    expect((await grade(scenario(), barely))[0].pass).toBe(false);
  });

  it("names the last step reached and the first one missed", async () => {
    // The whole reason for a ladder: a failure that says where it stopped, not
    // that it stopped.
    const checks = await grade(scenario(), outcome({ calls: [{ name: "read", args: {} }] }));

    expect(checks[0].detail).toContain("1/10");
    expect(checks[0].detail).toContain("got as far as looked");
    expect(checks[0].detail).toContain("stopped at acted");
  });

  it("says so rather than passing when there is nothing to score", async () => {
    const checks = await grade(scenario({ milestones: undefined }), outcome());
    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain("no milestones");
  });
});

describe("the schema keeps a ladder gradeable", () => {
  const load = (yaml: string) => parse(yaml);
  async function parse(yaml: string): Promise<Scenario[]> {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "milestone-schema-"));
    try {
      writeFileSync(join(dir, "s.yaml"), yaml);
      return (await loadScenarios(dir)).scenarios;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const base = `
- id: x
  category: orchestration
  difficulty: 8
  intent: y
  message: go
`;

  it("rejects score_at_least with no milestones", async () => {
    await expect(load(`${base}  expect:\n    - score_at_least: 0.5\n`)).rejects.toThrow(/no .milestones/);
  });

  it("rejects a milestone scored on the aggregate score", async () => {
    await expect(
      load(`${base}  milestones:
    - { id: a, points: 1, when: { score_at_least: 0.5 } }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/score_at_least/);
  });

  it("rejects a duplicate milestone id", async () => {
    // Two steps with one name make the ladder unreadable and double-count the
    // points, which inflates the score of the run that reached only one of them.
    await expect(
      load(`${base}  milestones:
    - { id: a, points: 1, when: { replies: true } }
    - { id: a, points: 1, when: { calls_tool: exec } }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/duplicate milestone id/);
  });

  it("rejects fact_reaches naming a fact that does not exist", async () => {
    await expect(
      load(`${base}  facts:
    real: { value: abc }
  expect:
    - fact_reaches: { fact: typo, stage: used }
`),
    ).rejects.toThrow(/not in facts/);
  });

  it("rejects a world assertion on a scenario with no world", async () => {
    // Silent, permanent, and in the direction that inflates a score: the run
    // records no world, an absent input is graded as unknown, and the check is
    // skipped — which counts as a pass. Both spellings, because a milestone is
    // graded by the same function as an `expect` entry.
    await expect(load(`${base}  expect:\n    - world_state: { power: "on" }\n`)).rejects.toThrow(/no .world/);
    await expect(
      load(`${base}  milestones:
    - { id: a, points: 1, when: { world_reached: { power: "on" } } }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/no .world/);
  });

  it("rejects a simulation assertion on a scenario with no simulation", async () => {
    // Same silent-pass shape as a world assertion with no world: the run
    // records no economy, the check skips, and the scenario is green having
    // measured nothing at all.
    await expect(
      load(`${base}  expect:\n    - sim_metric: { metric: enterpriseValue, at_least: 1 }\n`),
    ).rejects.toThrow(/no .simulation/);
    await expect(load(`${base}  expect:\n    - beats_baseline: { policy: random }\n`)).rejects.toThrow(
      /no .simulation/,
    );
  });

  it("rejects a simulation role held by an agent nobody declared", async () => {
    await expect(
      load(`- id: x
  category: simulation
  difficulty: 10
  intent: y
  simulation:
    name: factory
    roles: { sales: nobody }
  rooms:
    - name: plant
  wake: { room: plant, rounds: 2, agents: [bench] }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/does not declare/);
  });

  it("rejects a simulation with no `rounds:` roster, which would never advance the clock", async () => {
    await expect(
      load(`- id: x
  category: simulation
  difficulty: 10
  intent: y
  simulation:
    name: factory
    roles: { sales: bench }
  rooms:
    - name: plant
      incoming:
        - { speaker: quinton, body: go }
  wake: { room: plant }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/never advances the clock/);
  });

  it("rejects a fact routed to an agent nobody declared", async () => {
    await expect(
      load(`${base}  facts:
    real: { value: abc, requiredBy: [nobody] }
  expect:
    - replies: true
`),
    ).rejects.toThrow(/not one of/);
  });
});
