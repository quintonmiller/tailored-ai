/**
 * No simulation tool may be named after a tool the benchmark stubs.
 *
 * Found the expensive way on 2026-08-18. The descent's social layer shipped a
 * tool called `read`; `read` is also core's file-reading tool, which the harness
 * replaces with "(stubbed in the benchmark — assume it succeeded and continue)".
 * A live model called it in round three of a paid run. It got a success back,
 * the simulation never saw the call, the metric that counts it stayed at zero,
 * and nothing anywhere failed. The run was on course to report "the party never
 * used the instrument" about an instrument the party used.
 *
 * Two things were wrong and both are fixed, which is why this file asserts two
 * different properties:
 *
 * 1. `instrument()` consulted `STUBBED` for simulation tools, even though the
 *    comment at the call site already said it must not. That is now a `"never"`
 *    mode, so a future collision degrades to a duplicate name rather than a
 *    silent substitution.
 * 2. A duplicate name is *still* broken — two tools with one name in a schema
 *    list is undefined behaviour at the API level, and which one the model gets
 *    depends on ordering nobody should have to reason about. So the names must
 *    simply not collide, and that is what the first test below is for.
 *
 * The general lesson is the same one this workstream keeps relearning: a
 * mechanism that silently substitutes something plausible is worse than one
 * that fails. A missing tool is a loud error. A shadowed one is a measurement
 * of the arm you did not run.
 */

import { describe, expect, it } from "vitest";
import { STUBBED } from "../harness.js";
import { createSimulation, listSimulations, simulationDefaults } from "../sim/index.js";

/** Every tool every role can reach, for one simulation at its own play options. */
function toolNames(name: string): string[] {
  const sim = createSimulation(name, {
    seed: 1000,
    days: 8,
    ...simulationDefaults(name),
    traitors: 1,
    reveal: "social",
  });
  const perRole = Object.values(sim.tools?.() ?? {}).flat();
  return [...perRole, ...sim.sharedTools()].map((t) => t.name);
}

describe("what a simulation calls its tools", () => {
  it("never collides with a tool the harness stubs", () => {
    for (const name of listSimulations()) {
      const clashes = toolNames(name).filter((tool) => STUBBED.has(tool));
      expect(
        clashes,
        `${name} offers ${clashes.join(", ")}, which the benchmark stubs. A model calling one gets ` +
          "a fabricated success and the simulation never sees it. Rename the simulation's tool.",
      ).toEqual([]);
    }
  });

  it("never offers the same name twice", () => {
    // A simulation with two tools of one name is the same failure without the
    // harness's help: whichever the schema list happens to carry last wins.
    for (const name of listSimulations()) {
      const names = toolNames(name);
      const seen = new Set<string>();
      const twice: string[] = [];
      for (const tool of names) {
        if (seen.has(tool)) twice.push(tool);
        seen.add(tool);
      }
      expect(twice, `${name} offers ${twice.join(", ")} more than once`).toEqual([]);
    }
  });
});

describe("what a simulation says its parameters are", () => {
  it("accepts a number where a model sensibly sends one", () => {
    /*
     * The defect this guards cost three rounds of a live run.
     *
     * Every sim parameter was declared `type: "string"`, so core's
     * `validateToolArgs` rejected `give_gold({to: "guardian", amount: 25})`
     * before `execute` ran — and because the rejection lives in the loop rather
     * than the tool, no `call` event reached the trace. From the outside the
     * call simply never happened. A cleric spent three rounds apologising to
     * the party for gold transfers it believed it had made and concluded the
     * tool did not exist.
     *
     * Asserted through core's own validator rather than by inspecting the
     * schema, because the schema is only wrong in terms of what the validator
     * then does with it.
     */
    const tool = createSimulation("descent", { seed: 1000, days: 8, ...simulationDefaults("descent") })
      .sharedTools()
      .find((t) => t.name === "give_gold");
    if (!tool) throw new Error("give_gold is not offered");
    const props = (tool.parameters as { properties: Record<string, { type: unknown }> }).properties;
    for (const [name, spec] of Object.entries(props)) {
      expect(spec.type, `${name} refuses a number`).toEqual(["string", "number"]);
    }
  });
});
