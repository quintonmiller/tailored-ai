/**
 * Does the factory have anything in it worth measuring?
 *
 * A simulation benchmark has one failure mode that costs more than all the
 * others put together: **no gradient**. If a random policy and a competent one
 * score the same, there are no decisions in the economy, and every agent number
 * it ever produces is noise wearing a dollar sign. That is not hypothetical —
 * the first build of this model had the machine ceiling *below* baseline demand
 * and a warehouse too small to hold the cheap supplier's lead time, so every
 * policy was stocked out from day one and the "smart" ones scored worst.
 *
 * These run in milliseconds and involve no model, which is the point: the check
 * that protects a day of GPU time should cost nothing and run in CI.
 */

import { describe, expect, it } from "vitest";
import { FACTORY_POLICIES, FactorySimulation } from "../sim/factory/index.js";
import { enterpriseValue, priceEffect, seasonality } from "../sim/factory/model.js";
import { makeRng } from "../sim/rng.js";
import { gradient, runPolicy, summarise, sweep } from "../sim/sweep.js";

/** Enough seeds to rank policies, few enough to stay a unit test. */
const SEEDS = Array.from({ length: 24 }, (_, i) => 5000 + i);

/** Weakest first. The order the ladder has to come out in. */
const LADDER = ["random", "static", "fill-the-line", "reorder-point", "operator"] as const;

describe("the seeded generator", () => {
  it("gives the same run twice for the same seed", () => {
    const a = runPolicy("factory", FACTORY_POLICIES.operator(), 7, 20);
    const b = runPolicy("factory", FACTORY_POLICIES.operator(), 7, 20);
    expect(a).toEqual(b);
  });

  it("gives different runs for different seeds", () => {
    const a = runPolicy("factory", FACTORY_POLICIES.operator(), 7, 20);
    const b = runPolicy("factory", FACTORY_POLICIES.operator(), 8, 20);
    expect(a.enterpriseValue).not.toBe(b.enterpriseValue);
  });

  it("keeps named streams independent, so adding a draw does not move the weather", () => {
    // Without this, inserting one `chance()` in the maintenance model reshuffles
    // demand for the rest of the run, and every stored baseline silently stops
    // being comparable — which turns "this policy improved" into an artefact of
    // where a line was added.
    const rng = makeRng(42);
    const before = Array.from({ length: 5 }, () => rng.fork("demand:alpha:1").next());
    rng.fork("something:else").next();
    const after = Array.from({ length: 5 }, () => rng.fork("demand:alpha:1").next());
    expect(after).toEqual(before);
  });
});

describe("the economics", () => {
  it("sheds volume as price rises above the competition", () => {
    expect(priceEffect(100, 100)).toBeCloseTo(1, 5);
    expect(priceEffect(120, 100)).toBeLessThan(1);
    expect(priceEffect(80, 100)).toBeGreaterThan(1);
  });

  it("has a season, so extrapolating last week is not the same as reading the trend", () => {
    const values = Array.from({ length: 90 }, (_, d) => seasonality(d));
    expect(Math.max(...values)).toBeGreaterThan(1.2);
    expect(Math.min(...values)).toBeLessThan(0.85);
  });

  it("counts the opening balance sheet, not just the opening cash", () => {
    // Measuring value created against cash alone counted the machines and stock
    // the company already owned as value it had produced — about $660K of it,
    // which flattered every policy equally and hid that most were losing money.
    const sim = new FactorySimulation({ seed: 1, days: 5 });
    expect(sim.openingValue).toBeGreaterThan(1_000_000);
    expect(enterpriseValue(sim.state)).toBe(sim.openingValue);
  });

  it("lets a company hold enough stock to cover its slowest supplier", () => {
    // The warehouse was smaller than the overseas lead time implied, so the
    // cheap supplier was a trap rather than a tradeoff: using it as intended
    // overflowed the warehouse and wrote the excess off.
    const sim = new FactorySimulation({ seed: 1, days: 5 });
    const dailyMaterials = 2 * 180 + 3 * 70 + (1 * 180 + 4 * 70) + (180 + 70);
    expect(sim.state.warehouseCapacity).toBeGreaterThan(dailyMaterials * 24);
  });
});

describe("the baseline ladder", () => {
  const summaries = LADDER.map((name) => summarise(sweep("factory", FACTORY_POLICIES[name](), SEEDS)));
  const by = (name: string) => summaries.find((s) => s.policy === name) as (typeof summaries)[number];

  it("is monotonic — a better policy earns more", () => {
    const means = summaries.map((s) => s.mean);
    expect(means).toEqual([...means].sort((a, b) => a - b));
  });

  it("spans a wide enough range to measure into", () => {
    // The check that would have caught the first broken build. A spread this
    // size means there is roughly a million dollars of decision quality between
    // playing badly and playing well, so a framework has somewhere to land.
    const { spread } = gradient(summaries);
    expect(spread).toBeGreaterThan(500_000);
  });

  it("destroys value when played badly and creates it when played well", () => {
    const opening = new FactorySimulation({ seed: 1 }).openingValue;
    expect(by("random").mean).toBeLessThan(opening);
    expect(by("operator").mean).toBeGreaterThan(opening * 1.5);
  });

  it("rewards the strong policy on the downside too, not only on average", () => {
    // A policy that earns more by risking ruin is a different thing from one
    // that earns more and is also safer, and a mean cannot tell them apart.
    expect(by("operator").p10).toBeGreaterThan(by("reorder-point").p10);
    expect(by("operator").worst).toBeGreaterThan(by("static").worst);
  });

  it("punishes chasing utilisation, which is the trap it exists to show", () => {
    // `fill-the-line` is reorder-point plus a sales manager moving price until
    // the line is full. It is a plausible local optimisation and it destroys
    // real money, because filling the line by discounting only pays when
    // capacity is what binds.
    expect(by("fill-the-line").mean).toBeLessThan(by("reorder-point").mean);
    expect(by("fill-the-line").serviceLevel).toBeGreaterThan(by("reorder-point").serviceLevel);
  });

  it("varies enough between seeds that one run cannot rank two policies", () => {
    // The justification for sweeping. If a single run were decisive there would
    // be no reason to pay for sixty of them.
    expect(by("operator").stdev).toBeGreaterThan(20_000);
  });
});

describe("a run of the simulation", () => {
  it("stops at the horizon and reports why", () => {
    const sim = new FactorySimulation({ seed: 3, days: 10 });
    while (!sim.done) sim.advance();
    expect(sim.day).toBe(10);
    expect(sim.endedBecause).toBe("horizon reached");
    expect(sim.metrics().daysCompleted).toBe(10);
  });

  it("refuses an impossible action with a reason rather than throwing", () => {
    // A refusal is information the agent should read and act on, exactly as it
    // would from a real system. A thrown error would end the turn instead.
    const sim = new FactorySimulation({ seed: 3, days: 10 });
    const buy = sim.tools()["supply-chain"].find((t) => t.name === "place_purchase_order");
    expect(buy).toBeDefined();
    return buy?.execute({ supplier: "nowhere", material: "aluminum", quantity: "10" }, {} as never).then((r) => {
      expect(r.success).toBe(true);
      expect(String(r.output)).toContain("Refused");
    });
  });

  it("gives each manager only its own instruments", () => {
    // Nobody holds complete information or complete control — the split is the
    // benchmark. A team sharing one omniscient toolbox is one agent in six hats.
    const tools = new FactorySimulation({ seed: 1 }).tools();
    const names = (role: string) => tools[role].map((t) => t.name);
    expect(names("sales")).toContain("set_price");
    expect(names("sales")).not.toContain("schedule_maintenance");
    expect(names("maintenance")).toContain("list_machine_health");
    expect(names("maintenance")).not.toContain("set_price");
    expect(names("ceo")).not.toContain("place_purchase_order");
  });
});
