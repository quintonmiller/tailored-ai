/**
 * The configuration a simulation is measured at.
 *
 * A simulation's constructor defaults and the configuration its scenario plays
 * are two different things, and for a while nothing connected them. `descent`
 * construct-defaults to a shallow start with no maze; its scenario plays floor
 * one with a maze and a preparation phase. Swept at the construct-defaults the
 * baseline ladder reads oracle 1,455 against rule-based 1,450 — a five-point
 * gap that says perfect information is worth nothing. Swept at the scenario's
 * own options the same code reads 714 against 666.
 *
 * Both numbers are true about *a* game. Only one is about the game anybody
 * plays, and the command that printed the wrong one printed it without saying
 * so. These tests hold the two together.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenarios } from "../schema.js";
import { DESCENT_PLAY_OPTIONS } from "../sim/descent/index.js";
import { DESCENT_POLICIES } from "../sim/descent/policies.js";
import { simulationDefaults } from "../sim/index.js";
import { runPolicy } from "../sim/sweep.js";

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scenarios");

describe("the configuration a simulation is played at", () => {
  it("is declared by the simulation, not left to the constructor", () => {
    const declared = simulationDefaults("descent");
    expect(Object.keys(declared).length).toBeGreaterThan(0);
    // The maze is the load-bearing one: without it `floorMap` is null for the
    // whole run, so there is no floor graph, no room movement, no locks and no
    // gates — and the ladder measures a game with nothing to navigate.
    expect(declared.maze).toBe(true);
    expect(declared.startFloor).toBe(1);
    expect(declared.preparation).toBe(true);
  });

  it("is the same configuration the scenario runs", async () => {
    const { scenarios } = await loadScenarios(scenarioDir, "the-endless-descent");
    const scenario = scenarios.find((s) => s.id === "the-endless-descent");
    expect(scenario).toBeDefined();
    // Not a tautology even though the scenario imports the constant: it asserts
    // the scenario still routes its simulation through the declared options
    // rather than restating a copy that can drift.
    expect(scenario?.simulation?.options).toEqual({ ...DESCENT_PLAY_OPTIONS });
    expect(scenario?.simulation?.options).toEqual(simulationDefaults("descent"));
  });

  it("measures a game with navigation in it, which the bare defaults do not", () => {
    // The whole reason the declaration exists, asserted on the structural
    // difference rather than on the score gap. The oracle's edge over
    // rule-based is real but small and seed-dependent, so a handful of seeds
    // can show zero; whether there is a floor to navigate at all is not a
    // matter of degree.
    const seeds = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007];
    const totals = (options: Record<string, unknown>) => {
      const runs = seeds.map((seed) => runPolicy("descent", DESCENT_POLICIES["rule-based"](), seed, 40, 1, options));
      const sum = (key: string) => runs.reduce((total, run) => total + (run[key] ?? 0), 0);
      return { rooms: sum("roomsExplored"), floors: sum("floorReached") };
    };

    const played = totals(simulationDefaults("descent"));
    const bare = totals({});

    // With no maze, `floorMap` is null for the whole run: there are no rooms to
    // enter, so every navigation metric is dead and floors fall much faster.
    expect(played.rooms).toBeGreaterThan(0);
    expect(bare.rooms).toBe(0);
    expect(bare.floors).toBeGreaterThan(played.floors);
  });

  it("leaves a simulation that declares nothing alone", () => {
    expect(simulationDefaults("factory")).toEqual({});
    expect(simulationDefaults("no-such-simulation")).toEqual({});
  });
});
