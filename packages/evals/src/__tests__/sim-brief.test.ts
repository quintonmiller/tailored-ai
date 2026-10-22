/**
 * Whether a simulation can tell an agent anything durable about itself.
 *
 * Until now it could not. Everything a simulation says reaches an agent as a
 * tool result, which a model reads as *what happened* rather than as *what it
 * wants* — and that is not a matter of wording. Measured on
 * `the-descent-betrayed`, seed 610357: the traitor's objective was delivered
 * thirteen times, correctly scoped to one agent, as the first line of its own
 * tool output. Across nineteen rounds its private reasoning referenced the role
 * zero times while roughly fifteen hundred words of "the party does not last
 * long without you" sat in its system prompt.
 *
 * `Simulation.briefFor` is the missing channel: text the simulation decides at
 * construction, delivered where the scenario's own instructions live. The tests
 * below are about the seam, not about whether any particular wording works —
 * that question needs a model and is answered in `docs/endless-descent-betrayal.md`.
 */

import { describe, expect, it } from "vitest";
import { buildConfig } from "../harness.js";
import { loadScenarios } from "../schema.js";
import { createSimulation, simulationDefaults } from "../sim/index.js";
import type { HarnessOptions, Scenario, Simulation } from "../types.js";

const OPTS = {
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test",
  apiKey: "none",
  temperature: 0.3,
  maxTokens: null,
  maxToolRounds: 20,
  providerExtra: {},
  seed: null,
  timeoutMs: 1000,
} as unknown as HarnessOptions;

async function betrayed(): Promise<Scenario> {
  const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname);
  const found = scenarios.find((s) => s.id === "the-descent-betrayed");
  if (!found) throw new Error("the-descent-betrayed is not loading");
  return found;
}

function sim(briefStyle: string, seed = 610357): Simulation & { traitorRoles(): ReadonlySet<string> } {
  return createSimulation("descent-betrayed", {
    seed,
    days: 8,
    ...simulationDefaults("descent-betrayed"),
    briefStyle,
  }) as Simulation & { traitorRoles(): ReadonlySet<string> };
}

function instructionsOf(config: Record<string, unknown>, agent: string): string {
  const agents = config.agents as Record<string, { instructions?: string }>;
  return String(agents[agent]?.instructions ?? "");
}

describe("a simulation briefing one agent", () => {
  it("reaches that agent's own instructions, not a tool result", async () => {
    const scenario = await betrayed();
    const s = sim("plain");
    const [traitor] = [...s.traitorRoles()];
    expect(instructionsOf(buildConfig(scenario, OPTS, s), traitor)).toContain("YOUR ACTUAL OBJECTIVE");
  });

  it("reaches nobody else", async () => {
    const scenario = await betrayed();
    const s = sim("override");
    const config = buildConfig(scenario, OPTS, s);
    const agents = Object.keys(config.agents as Record<string, unknown>);
    for (const agent of agents) {
      if (s.traitorRoles().has(agent)) continue;
      expect(instructionsOf(config, agent), `${agent} was briefed`).not.toContain("YOUR ACTUAL OBJECTIVE");
    }
  });

  it("adds to the scenario's instructions rather than replacing them", async () => {
    // A traitor is still the cleric, and still the only one who can heal. A
    // brief that overwrote the job description would be measuring an agent that
    // does not know what its own abilities are.
    const scenario = await betrayed();
    const plain = buildConfig(scenario, OPTS, sim("none"));
    const s = sim("plain");
    const [traitor] = [...s.traitorRoles()];
    const briefed = buildConfig(scenario, OPTS, s);
    const before = instructionsOf(plain, traitor);
    expect(before.length).toBeGreaterThan(1000);
    expect(instructionsOf(briefed, traitor).startsWith(before)).toBe(true);
  });

  it("says nothing at all when the simulation has nothing to add", async () => {
    const scenario = await betrayed();
    const s = sim("none");
    const [traitor] = [...s.traitorRoles()];
    expect(instructionsOf(buildConfig(scenario, OPTS, s), traitor)).not.toContain("YOUR ACTUAL OBJECTIVE");
  });

  it("is optional, so a simulation that never heard of it still builds", async () => {
    // `briefFor` is an optional member of the contract. Every other simulation
    // in the package omits it, and `buildConfig` must not require it.
    const { scenarios } = await loadScenarios(new URL("../../scenarios", import.meta.url).pathname);
    const factory = scenarios.find((s) => s.simulation?.name === "factory");
    if (!factory?.simulation) return;
    const f = createSimulation("factory", { seed: 1, days: 4 });
    expect((f as Simulation).briefFor).toBeUndefined();
    expect(() => buildConfig(factory, OPTS, f)).not.toThrow();
  });

  it("does not edit the scenario it was handed", async () => {
    // `deepMerge` copies a key it does not already hold by reference, so an
    // agent block in the built config *is* the scenario's own object. Appending
    // through it meant a scenario built twice — `--repeats 3`, or two variants
    // in one process — accumulated the brief once per build, and the second
    // variant measured the first one's instructions.
    const scenario = await betrayed();
    const s = sim("override");
    const [traitor] = [...s.traitorRoles()];
    const before = String(
      (scenario.config?.agents as Record<string, { instructions?: string }> | undefined)?.[traitor]?.instructions ?? "",
    );
    buildConfig(scenario, OPTS, s);
    buildConfig(scenario, OPTS, s);
    const after = String(
      (scenario.config?.agents as Record<string, { instructions?: string }> | undefined)?.[traitor]?.instructions ?? "",
    );
    expect(after).toBe(before);
    expect(after).not.toContain("YOUR ACTUAL OBJECTIVE");
    // And the built copy still carries it exactly once.
    const built = instructionsOf(buildConfig(scenario, OPTS, s), traitor);
    expect(built.split("YOUR ACTUAL OBJECTIVE").length - 1).toBe(1);
  });

  it("grows with the variant, which is what makes them comparable arms", async () => {
    const scenario = await betrayed();
    const lengths = ["none", "plain", "override", "scored"].map((style) => {
      const s = sim(style);
      const [traitor] = [...s.traitorRoles()];
      return instructionsOf(buildConfig(scenario, OPTS, s), traitor).length;
    });
    expect(lengths[0]).toBeLessThan(lengths[1]);
    expect(lengths[1]).toBeLessThan(lengths[2]);
    expect(lengths[2]).toBeLessThan(lengths[3]);
  });
});

/* -------------------------------------------------------------------------- */
/* the other half: the premise, delivered to everybody                         */
/* -------------------------------------------------------------------------- */

function both(
  briefStyle: string,
  partyBrief: string,
  seed = 610357,
): Simulation & { traitorRoles(): ReadonlySet<string> } {
  return createSimulation("descent-betrayed", {
    seed,
    days: 8,
    ...simulationDefaults("descent-betrayed"),
    briefStyle,
    partyBrief,
  }) as Simulation & { traitorRoles(): ReadonlySet<string> };
}

const PREMISE = "WHO ELSE IS ON THIS EXPEDITION";

describe("a simulation briefing the whole party", () => {
  it("reaches every character, which is the difference from the traitor's brief", async () => {
    const scenario = await betrayed();
    const s = both("none", "premise");
    const config = buildConfig(scenario, OPTS, s);
    for (const agent of Object.keys(config.agents as Record<string, unknown>)) {
      expect(instructionsOf(config, agent), `${agent} was not briefed`).toContain(PREMISE);
    }
  });

  it("is byte-identical for all five, so it leaks nothing", async () => {
    // The same property `setupBrief()` has in the private view, and for the
    // same reason: a premise that read differently for a traitor would hand
    // the party a tell that has nothing to do with anybody's behaviour.
    const scenario = await betrayed();
    const s = both("none", "premise");
    const config = buildConfig(scenario, OPTS, s);
    const blocks = Object.keys(config.agents as Record<string, unknown>).map((agent) => {
      const text = instructionsOf(config, agent);
      return text.slice(text.indexOf(PREMISE));
    });
    expect(new Set(blocks).size).toBe(1);
  });

  it("does not tell a traitor it is loyal when the traitor's own brief is off", async () => {
    // The private view can say "if nothing below says you are one, you are not"
    // because it always carries the traitor's paragraph underneath. Here the
    // two halves are separate options, so under `briefStyle=none` there is
    // nothing underneath — and that inference would be a lie told to the one
    // character it matters to.
    const scenario = await betrayed();
    const s = both("none", "premise");
    const [traitor] = [...s.traitorRoles()];
    const text = instructionsOf(buildConfig(scenario, OPTS, s), traitor);
    expect(text).toContain(PREMISE);
    expect(text).not.toMatch(/you are not (one of them|with them)/i);
  });

  it("names both tools, which is the zero it exists to move", async () => {
    // Across 54 rounds and 404 utterances the words `whisper` and `accuse`
    // never appeared in anything any agent said, while both tools were
    // declared to all five the whole time.
    const scenario = await betrayed();
    const s = both("none", "premise");
    const [, loyal] = Object.keys(buildConfig(scenario, OPTS, s).agents as Record<string, unknown>).filter(
      (a) => !s.traitorRoles().has(a),
    );
    const text = instructionsOf(buildConfig(scenario, OPTS, s), loyal);
    expect(text).toContain("`whisper`");
    expect(text).toContain("`accuse`");
  });

  it("is off unless asked for, so every arm measured so far still means what it said", async () => {
    const scenario = await betrayed();
    for (const style of ["none", "plain", "override", "scored"]) {
      const s = sim(style);
      const config = buildConfig(scenario, OPTS, s);
      for (const agent of Object.keys(config.agents as Record<string, unknown>)) {
        expect(instructionsOf(config, agent), `${agent}, briefStyle=${style}`).not.toContain(PREMISE);
      }
    }
  });

  it("crosses with the traitor's brief without either half implying the other", async () => {
    // Two independent defects with the same suspected cause. An arm that moved
    // both at once could not say which one mattered, so the options have to be
    // orthogonal rather than two rungs on one ladder.
    const scenario = await betrayed();
    const cases = [
      { brief: "none", party: "none", premise: false, objective: false },
      { brief: "override", party: "none", premise: false, objective: true },
      { brief: "none", party: "premise", premise: true, objective: false },
      { brief: "override", party: "premise", premise: true, objective: true },
    ];
    for (const c of cases) {
      const s = both(c.brief, c.party);
      const [traitor] = [...s.traitorRoles()];
      const text = instructionsOf(buildConfig(scenario, OPTS, s), traitor);
      const label = `briefStyle=${c.brief} partyBrief=${c.party}`;
      expect(text.includes(PREMISE), `${label}: premise`).toBe(c.premise);
      expect(text.includes("YOUR ACTUAL OBJECTIVE"), `${label}: objective`).toBe(c.objective);
    }
  });

  it("puts the shared half first, matching the order the private view uses", async () => {
    const scenario = await betrayed();
    const s = both("override", "premise");
    const [traitor] = [...s.traitorRoles()];
    const text = instructionsOf(buildConfig(scenario, OPTS, s), traitor);
    expect(text.indexOf(PREMISE)).toBeLessThan(text.indexOf("YOUR ACTUAL OBJECTIVE"));
  });

  it("stays off when the betrayal layer is off entirely", async () => {
    // `descent` is the game it always was. Asking for a party brief on a
    // simulation with no traitors must not put a premise about traitors into
    // five system prompts.
    const plain = createSimulation("descent", {
      seed: 610357,
      days: 8,
      ...simulationDefaults("descent"),
      partyBrief: "premise",
    }) as Simulation;
    expect(plain.briefFor?.("cleric")).toBeUndefined();
  });
});
