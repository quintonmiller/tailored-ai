/**
 * Doing several things in one call, and what happens when one of them is wrong.
 *
 * A tool call is a whole model round trip carrying the entire grown context, so
 * the number of them is the wall clock. Across 2,642 agent-turns in seventeen
 * traces the simulation saw 2.57 calls a turn and 75% of turns made more than
 * one — so collapsing multi-call turns removes about 45% of all round trips.
 *
 * The semantics matter more than the saving. Refusal rates in those same traces
 * run to 72% for `unlock_route`, 69% for `revive` and 43% for `take`, so a
 * batch will routinely contain something illegal. All-or-nothing execution
 * would compound a per-call failure rate into most turns doing nothing at all,
 * which would make this optimisation a regression. Hence: in order, stop at the
 * first refusal, keep everything before it, and say what was skipped.
 */

import { describe, expect, it } from "vitest";
import { createSimulation, simulationDefaults, simulationPolicies } from "../sim/index.js";

interface Batch {
  execute(
    args: Record<string, unknown>,
    context?: { agentName?: string },
  ): Promise<{ success: boolean; output?: string }>;
  name: string;
}

function sim(seed = 1000, rounds = 0) {
  const s = createSimulation("descent", { seed, days: 40, ...simulationDefaults("descent") });
  if (rounds > 0) {
    const pol = simulationPolicies("descent")["rule-based"]?.();
    for (let i = 0; i < rounds && !s.done && pol; i++) {
      pol.act(s);
      s.advance();
    }
  }
  return s;
}

function batchOf(s: ReturnType<typeof sim>): Batch {
  const found = s.sharedTools().find((t) => t.name === "execute_actions");
  if (!found) throw new Error("execute_actions is not in sharedTools()");
  return found as unknown as Batch;
}

describe("execute_actions", () => {
  it("is offered to every role, not one", () => {
    // It reads context.agentName to decide what it can reach, so it belongs in
    // sharedTools(). Declared per-role it would silently collapse to whichever
    // role registered last.
    expect(batchOf(sim()).name).toBe("execute_actions");
  });

  it("declares actions as a real array, not a string to be parsed", () => {
    const params = (batchOf(sim()) as unknown as { parameters: Record<string, never> }).parameters;
    const actions = (params.properties as Record<string, { type?: string; items?: unknown }>).actions;
    expect(actions?.type).toBe("array");
    expect(actions?.items).toBeDefined();
  });

  it("runs the actions in the order given", async () => {
    const s = sim();
    const out = String(
      (
        await batchOf(s).execute(
          {
            actions: [
              { actionType: "look", payload: {} },
              { actionType: "look", payload: {} },
            ],
          },
          { agentName: "guardian" },
        )
      ).output,
    );
    expect(out).toContain("1. look");
    expect(out).toContain("2. look");
    expect(out.indexOf("1. look")).toBeLessThan(out.indexOf("2. look"));
  });

  it("keeps what succeeded before a refusal and says what it skipped", async () => {
    const s = sim();
    const out = String(
      (
        await batchOf(s).execute(
          {
            actions: [
              { actionType: "look", payload: {} },
              { actionType: "revive", payload: { ally: "mage" } }, // nobody is dead
              { actionType: "look", payload: {} },
            ],
          },
          { agentName: "guardian" },
        )
      ).output,
    );
    expect(out).toContain("1. look");
    expect(out).toMatch(/2\. revive — Refused:/);
    expect(out).toContain("Stopped:");
    // The third action must not have run — that is the whole contract.
    expect(out).not.toContain("3. look");
  });

  it("refuses an unknown action by name instead of silently skipping it", async () => {
    const s = sim();
    const out = String(
      (await batchOf(s).execute({ actions: [{ actionType: "teleport", payload: {} }] }, { agentName: "guardian" }))
        .output,
    );
    expect(out).toContain("teleport");
    expect(out).toContain("Refused:");
  });

  it("cannot reach another role's abilities", async () => {
    // The asymmetry is the scenario. A guardian batching `backstab` would be a
    // hole straight through it, and a hole that reads as good coordination.
    const s = sim();
    const out = String(
      (await batchOf(s).execute({ actions: [{ actionType: "backstab", payload: {} }] }, { agentName: "guardian" }))
        .output,
    );
    expect(out).toContain("Refused:");
    expect(out).toContain("no such action");
  });

  it("puts a message where the whole party will read it", async () => {
    // Across the `advance()`, deliberately. This assertion used to omit it and
    // therefore passed for weeks against code that destroyed every message
    // before anybody could read it — `advance()` reassigns the round log in
    // every branch of its phase switch. `descent-speech.test.ts` owns the rest
    // of that contract.
    const s = sim(1000, 6);
    await batchOf(s).execute({ message: "regrouping at the stairs", actions: [] }, { agentName: "guardian" });
    s.advance();
    expect((s as unknown as { announce(): string }).announce()).toContain("regrouping at the stairs");
  });

  it("keeps thinking out of what anybody else can read", async () => {
    const s = sim(1000, 6);
    await batchOf(s).execute(
      { thinking: "the cleric is nearly out of mana and I am not saying so", actions: [] },
      { agentName: "guardian" },
    );
    const said = (s as unknown as { announce(): string }).announce();
    expect(said).not.toContain("not saying so");
  });

  it("will not accept an empty turn", async () => {
    const s = sim();
    const out = String((await batchOf(s).execute({ actions: [] }, { agentName: "guardian" })).output);
    expect(out).toContain("Refused:");
  });
});
