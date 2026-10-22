/**
 * A milestone that names a metric nobody emits is worth zero points forever.
 *
 * `sim_metric` reads a number out of the simulation's `metrics()` bag, which is
 * `Record<string, number>` and so cannot be checked by the type system or by
 * the scenario schema. Misspell one — `chambersLevelled` for `chambersLeveled`,
 * `serviceLevel` for `service_level` — and the scenario still loads, still runs,
 * still scores, and quietly reports the team never did a thing it did. The
 * failure looks exactly like the team failing.
 *
 * This is the only place that can catch it, because it is the only place that
 * knows both halves: the scenarios that assert, and the simulations that emit.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { simulationGrants } from "../harness.js";
import { loadScenarios } from "../schema.js";
import { createSimulation, listSimulations } from "../sim/index.js";
import type { Assertion, Milestone, Scenario } from "../types.js";

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), "../../scenarios");

/** Every `sim_metric` an assertion tree can reach, milestones included. */
function metricsAsserted(scenario: Scenario): string[] {
  const from = (list: Array<Assertion | Milestone>): string[] =>
    list.flatMap((entry) => {
      const assertion = "when" in entry ? entry.when : entry;
      return assertion.sim_metric ? [assertion.sim_metric.metric] : [];
    });
  return [...from(scenario.expect ?? []), ...from(scenario.milestones ?? [])];
}

describe("simulation metrics a scenario asserts on", () => {
  it("all exist in the simulation that produces them", async () => {
    const { scenarios } = await loadScenarios(scenarioDir);

    const withSims = scenarios.filter((s) => s.simulation);
    // A guard that silently checks nothing is the thing this file exists to
    // prevent, so it refuses to pass on an empty set.
    expect(withSims.length).toBeGreaterThan(0);

    for (const scenario of withSims) {
      const spec = scenario.simulation as NonNullable<Scenario["simulation"]>;
      expect(listSimulations()).toContain(spec.name);
      const sim = createSimulation(spec.name, { seed: spec.seed ?? 0, ...(spec.days ? { days: spec.days } : {}) });
      const known = Object.keys(sim.metrics());
      for (const metric of metricsAsserted(scenario)) {
        expect(known, `${scenario.id} asserts sim_metric "${metric}", which "${spec.name}" does not emit`).toContain(
          metric,
        );
      }
    }
  });

  it("names roles the simulation actually has", async () => {
    const { scenarios } = await loadScenarios(scenarioDir);
    for (const scenario of scenarios.filter((s) => s.simulation)) {
      const spec = scenario.simulation as NonNullable<Scenario["simulation"]>;
      const sim = createSimulation(spec.name, { seed: spec.seed ?? 0, ...(spec.days ? { days: spec.days } : {}) });
      const roles = Object.keys(sim.tools());
      for (const role of Object.keys(spec.roles)) {
        expect(roles, `${scenario.id} maps role "${role}", which "${spec.name}" does not define`).toContain(role);
      }
      // And the other direction: a role the simulation defines but no scenario
      // hands out is an instrument nobody can reach.
      for (const role of roles) {
        expect(
          Object.keys(spec.roles),
          `"${spec.name}" defines role "${role}" that ${scenario.id} gives to nobody`,
        ).toContain(role);
      }
    }
  });
});

/**
 * Two roles cannot share a tool name, and the reason cost a 67-minute run.
 *
 * The harness flattens `sim.tools()` into one registry and each agent's
 * allowlist selects by *name*, so six roles exporting a `raise_paddle` apiece do
 * not get one each — they all get whichever was built last. `the-lock` shipped
 * exactly that: every agent was handed the upper chamber's paddle, every one of
 * them reported accurately that it was on chamber 3, and the transcript read as
 * a team hallucinating its own capabilities. Nothing in the run could tell the
 * two apart.
 *
 * The unit tests missed it because they called `sim.tools()[role]` directly,
 * which is the one path the agents never take. So this checks the flattened
 * shape instead.
 */
describe("tool names across a simulation's roles", () => {
  it("are unique, because the registry keys by name", () => {
    for (const name of listSimulations()) {
      const sim = createSimulation(name, { seed: 0 });
      const owner = new Map<string, string>();
      for (const [role, tools] of Object.entries(sim.tools())) {
        for (const t of tools) {
          expect(
            owner.get(t.name),
            `"${name}" gives both "${owner.get(t.name)}" and "${role}" a tool called "${t.name}" — ` +
              "one implementation would serve both. Move it to sharedTools() and read context.agentName.",
          ).toBeUndefined();
          owner.set(t.name, role);
        }
      }
    }
  });

  it("do not collide with a shared tool either", () => {
    for (const name of listSimulations()) {
      const sim = createSimulation(name, { seed: 0 });
      const shared = new Set(sim.sharedTools().map((t) => t.name));
      for (const [role, tools] of Object.entries(sim.tools())) {
        for (const t of tools) {
          expect(shared.has(t.name), `"${name}": role "${role}" redefines the shared tool "${t.name}"`).toBe(false);
        }
      }
    }
  });

  it("is enforced by the harness, not just asserted here", () => {
    // The guard has to fire on a simulation that has the defect, or it is
    // decoration. Built rather than mocked so it exercises the real code path.
    const broken = {
      name: "broken",
      day: 0,
      done: false,
      events: [],
      tools: () => ({
        one: [{ name: "pull", description: "", parameters: {}, execute: async () => ({ success: true, output: "" }) }],
        two: [{ name: "pull", description: "", parameters: {}, execute: async () => ({ success: true, output: "" }) }],
      }),
      sharedTools: () => [],
      advance: () => [],
      metrics: () => ({}),
      objective: () => 0,
      snapshot: () => ({}),
    } as unknown as Parameters<typeof simulationGrants>[0];
    expect(() => simulationGrants(broken, { one: "a", two: "b" })).toThrow(/both "one" and "two" a tool called "pull"/);
  });
});
