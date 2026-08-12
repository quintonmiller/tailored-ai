/**
 * Playing the factory without a model.
 *
 * These exist to make the headline number mean something. "$1.31M" says
 * nothing; "$1.31M against $402K random, $711K static and $1.08M greedy" says
 * where a framework sits on a scale somebody can reason about.
 *
 * They also catch the failure that would otherwise waste a great deal of model
 * time: **a simulation with no gradient**. If random and greedy score the same,
 * the economy has no decisions in it and every agent number is noise. That
 * check costs milliseconds and has to happen before a single model call — which
 * is the whole argument for building the baselines first.
 *
 * Deliberately written as ordinary code against the same state the agents drive
 * through tools, so a policy cannot cheat in a way an agent could not. They do
 * read state directly rather than through tool schemas; the point is to bound
 * the achievable range, not to model an agent's information limits.
 */

import type { Policy } from "../types.js";
import type { FactorySimulation } from "./index.js";
import {
  availableCredit,
  BASE_MATERIAL_PRICE,
  BILL_OF_MATERIALS,
  type FactoryState,
  labourCapacity,
  type MaterialId,
  type ProductId,
  SUPPLIERS,
  type SupplierId,
  stageCapacity,
  unitProductionCost,
} from "./model.js";

const MATERIALS: MaterialId[] = ["aluminum", "electronics", "packaging"];
const PRODUCTS: ProductId[] = ["alpha", "beta"];

function state(sim: FactorySimulation): FactoryState {
  return sim.state;
}

/**
 * Order what the company can actually fund, rather than what the rule asked for.
 *
 * Every policy here used to call `order` with whatever its arithmetic produced,
 * which was fine while the funding guard was a flat $400K allowance nobody
 * reached. Against a borrowing base that shrinks as stock is consumed, the same
 * call throws — and a baseline that crashes when money is tight is not a
 * baseline, it is a missing branch.
 *
 * Trimming rather than skipping is the honest behaviour: a business short of
 * credit buys less, takes the stock-out that follows, and lives with the
 * reputation cost. That consequence is the thing being measured, so it must be
 * reachable rather than thrown.
 */
function order(factory: FactorySimulation, supplier: SupplierId, material: MaterialId, quantity: number): void {
  const s = state(factory);
  const unit = BASE_MATERIAL_PRICE[material] * SUPPLIERS[supplier].multiplier;
  const affordable = Math.floor((s.cash + availableCredit(s)) / unit);
  const qty = Math.min(Math.round(quantity), affordable);
  if (qty > 0) factory.order(supplier, material, qty);
}

/**
 * The floor. Prices and orders chosen at random inside plausible bounds.
 *
 * Not "does nothing" — a do-nothing policy is a different and less useful
 * floor, because it never spends money badly. Random spends money badly, which
 * is what a lower bound should look like.
 */
export function randomPolicy(): Policy {
  return {
    name: "random",
    act(sim) {
      const s = state(sim as FactorySimulation);
      const r = (sim as FactorySimulation).rng.fork(`random:${s.day}`);
      for (const p of PRODUCTS) {
        s.products[p].price = Math.round(s.competitorPrice[p] * r.range(0.7, 1.4));
        s.plan[p] = r.int(0, 250);
      }
      if (r.chance(0.3)) {
        const material = MATERIALS[r.int(0, MATERIALS.length - 1)];
        const supplier = (["domestic", "overseas", "spot"] as const)[r.int(0, 2)];
        order(sim as FactorySimulation, supplier, material, r.int(200, 3000));
      }
    },
  };
}

/**
 * Set it and forget it. The opening prices, a fixed plan, and a standing weekly
 * order — no reaction to anything.
 *
 * This is the honest "a competent person set this up once and went on holiday"
 * baseline, and it is usually much better than random. The gap between it and a
 * reactive policy is the part of the score that is actually about paying
 * attention.
 */
export function staticPolicy(): Policy {
  return {
    name: "static",
    act(sim) {
      const s = state(sim as FactorySimulation);
      s.plan.alpha = 180;
      s.plan.beta = 70;
      if (s.day % 7 === 0) {
        order(sim as FactorySimulation, "overseas", "aluminum", 2600);
        order(sim as FactorySimulation, "overseas", "electronics", 2100);
        order(sim as FactorySimulation, "overseas", "packaging", 1800);
      }
    },
  };
}

/** Days of cover a reorder-point policy aims to hold, by lead time. */
const COVER_DAYS = 18;

/**
 * Textbook operations. Reorder points with safety stock, production matched to
 * recent demand, preventative maintenance on expected value, and prices left
 * alone.
 *
 * The interesting baseline: it is what a well-run company does without anyone
 * being clever, and it is the bar an agent framework has to clear to be worth
 * anything at all.
 */
export function reorderPointPolicy(): Policy {
  return {
    name: "reorder-point",
    act(sim) {
      const factory = sim as FactorySimulation;
      const s = state(factory);
      const recent = s.history.slice(-7);
      const avg = (p: ProductId) =>
        recent.length ? recent.reduce((sum, h) => sum + h.demand[p], 0) / recent.length : s.products[p].demandBaseline;

      // Produce to recent demand plus backlog, capped by what the line can do.
      const capacity = Math.floor(
        Math.min(stageCapacity(s, "press"), stageCapacity(s, "assembler"), stageCapacity(s, "packaging")),
      );
      const wantAlpha = Math.round(avg("alpha") + s.products.alpha.backlog);
      const wantBeta = Math.round(avg("beta") + s.products.beta.backlog);
      const scale = Math.min(1, capacity / Math.max(1, wantAlpha + wantBeta));
      s.plan.alpha = Math.round(wantAlpha * scale);
      s.plan.beta = Math.round(wantBeta * scale);

      // Reorder against days of cover, counting what is already in flight.
      for (const material of MATERIALS) {
        const daily = PRODUCTS.reduce((sum, p) => sum + BILL_OF_MATERIALS[p][material] * avg(p), 0);
        const inFlight = s.orders
          .filter((o) => o.material === material && !o.received && !o.failed)
          .reduce((sum, o) => sum + o.quantity, 0);
        const cover = (s.materials[material] + inFlight) / Math.max(1, daily);
        if (cover < COVER_DAYS) {
          const need = Math.ceil(daily * (COVER_DAYS + 8) - s.materials[material] - inFlight);
          // Domestic whenever cover is thinner than the overseas lead time.
          // Ordering cheap-and-slow when you already have less stock than the
          // slow supplier takes to arrive guarantees the stock-out you were
          // ordering to prevent — which is what the opening position does to a
          // naive rule, and it cost every policy the first two weeks of the run.
          if (need > 0) order(factory, cover < SUPPLIERS.overseas.lead[1] ? "domestic" : "overseas", material, need);
        }
      }

      // Maintain on expected value: below 0.6 condition the expected cost of a
      // breakdown exceeds preventative maintenance several times over.
      for (const machine of s.machines) {
        if (machine.downDays > 0) continue;
        if (machine.condition < 0.6) factory.maintain(machine.id);
      }
    },
  };
}

/**
 * Reorder-point, plus a sales manager who chases utilisation.
 *
 * Kept in the ladder even though it scores *below* the policy it is built on,
 * because that is the finding. Its rule is the one a sales function reaches for
 * unprompted — move price until the line is full — and it is worth roughly
 * $150K of destroyed value over sixty days. Filling the line by cutting price
 * only pays when capacity is the binding constraint; when it is not, every
 * extra unit is sold at a discount the company did not need to offer.
 *
 * This is the single-subsystem optimisation the benchmark exists to catch, and
 * a baseline that demonstrates it is more useful than one that hides it.
 */
export function fillTheLinePolicy(): Policy {
  const base = reorderPointPolicy();
  return {
    name: "fill-the-line",
    act(sim) {
      base.act(sim);
      const factory = sim as FactorySimulation;
      const s = state(factory);
      const recent = s.history.slice(-5);
      if (!recent.length) return;

      // The *true* ceiling, labour included. Comparing demand against machine
      // capacity alone was the bug that made this the worst policy in the set:
      // labour binds first at the opening headcount, so demand always looked
      // slack, so the rule cut price 3% every single day and compounded down to
      // the margin floor over sixty days.
      const capacity = Math.floor(
        Math.min(
          stageCapacity(s, "press"),
          stageCapacity(s, "assembler"),
          stageCapacity(s, "packaging"),
          labourCapacity(s),
        ),
      );
      const demand = PRODUCTS.reduce((sum, p) => sum + recent.reduce((a, h) => a + h.demand[p], 0) / recent.length, 0);

      // Price toward the point where demand just fills the line, bounded below
      // by a margin floor. Demand moves as price^-1.6, so shifting demand by a
      // factor f means moving price by f^(-1/1.6); damped, because five days of
      // history is a noisy estimate and overshooting sheds reputation.
      const target = capacity * 0.95;
      const ratio = demand > 0 ? target / demand : 1;
      const move = ratio ** (-1 / 1.6);
      const damped = 1 + (move - 1) * 0.4;
      for (const p of PRODUCTS) {
        const floor = unitProductionCost(p) * 1.15;
        const next = s.products[p].price * Math.max(0.9, Math.min(1.1, damped));
        s.products[p].price = Math.max(floor, Math.round(next));
      }

      // Capacity is worth buying only where it actually binds. Assembly is not
      // the constraint at the opening headcount, so buying an assembler is a
      // quarter of a million dollars for nothing — hire instead.
      if (labourCapacity(s) < capacity * 1.02 && s.cash > 250_000 && demand > capacity) {
        factory.hire(Math.ceil((demand - capacity) / 16));
      }
    },
  };
}

/**
 * The strong baseline: competent operations, and capacity bought where it
 * actually binds.
 *
 * Everything reorder-point does, plus two moves that need a view across
 * subsystems rather than within one. It hires when demand is running past the
 * line — labour is the cheap ceiling to raise, and the assembler is not the
 * constraint whatever the assembler's utilisation says. And it lets price drift
 * *up* while a backlog persists, because a backlog means the company is already
 * selling everything it can make and the marginal order is being taken at a
 * discount it does not need.
 *
 * This is the bar. An agent framework that cannot beat a hundred lines of
 * operations heuristics is not adding anything, and one that beats it is doing
 * something a rule could not.
 */
export function operatorPolicy(): Policy {
  const base = reorderPointPolicy();
  return {
    name: "operator",
    act(sim) {
      base.act(sim);
      const factory = sim as FactorySimulation;
      const s = state(factory);
      const recent = s.history.slice(-5);
      if (!recent.length) return;

      const capacity = Math.floor(
        Math.min(
          stageCapacity(s, "press"),
          stageCapacity(s, "assembler"),
          stageCapacity(s, "packaging"),
          labourCapacity(s),
        ),
      );
      const demand = PRODUCTS.reduce((sum, p) => sum + recent.reduce((a, h) => a + h.demand[p], 0) / recent.length, 0);
      const backlog = s.products.alpha.backlog + s.products.beta.backlog;

      // Raise the ceiling where it is, rather than where a utilisation figure
      // points. Labour binds first at the opening headcount and a worker is
      // $190/day against a $275,000 machine.
      if (demand > capacity && s.cash > 120_000 && labourCapacity(s) <= capacity) {
        factory.hire(Math.ceil((demand - capacity) / 16));
      } else if (demand < capacity * 0.7 && s.workers.production > 10) {
        factory.hire(-2);
      }

      // Backlog means every unit made is already sold. Charging more for it
      // costs no volume the company could have served anyway.
      if (backlog > capacity * 0.25) {
        for (const p of PRODUCTS) s.products[p].price = Math.round(s.products[p].price * 1.02);
      }
    },
  };
}

/**
 * Growth on borrowed money: buy every scrap of capacity, price to fill it, and
 * assume demand holds.
 *
 * The row that makes the risk columns mean something. Every other baseline is
 * safe, so the report's P10, worst case and bankruptcy rate all described a
 * downside nothing could reach — and a framework that bet the company could not
 * have been marked down for it, because there was no example of what that costs.
 *
 * Nothing here is stupid in isolation. Buying capacity when the line is full,
 * financing it on an asset-backed facility, and pricing to keep the new capacity
 * busy are all things a real management team does, and on the seeds where demand
 * holds it is the best policy in the set. It is ruinous on exactly the seeds
 * where the distributor leaves early, because the borrowing base falls with the
 * stock and the machines while the debt does not.
 *
 * That is the whole argument for reading P10 next to the mean. This policy's
 * average is respectable and its tenth percentile is a smoking hole.
 */
export function growthPolicy(): Policy {
  const base = reorderPointPolicy();
  return {
    name: "growth",
    act(sim) {
      base.act(sim);
      const factory = sim as FactorySimulation;
      const s = state(factory);
      const recent = s.history.slice(-7);
      const avg = (p: ProductId) =>
        recent.length ? recent.reduce((sum, h) => sum + h.demand[p], 0) / recent.length : s.products[p].demandBaseline;

      // Build for the demand it expects to have, not the demand it has. A 20%
      // growth assumption is ordinary in a plan and ruinous in a contraction.
      const wanted = { alpha: avg("alpha") * 1.2, beta: avg("beta") * 1.2 };
      s.plan.alpha = Math.round(wanted.alpha);
      s.plan.beta = Math.round(wanted.beta);

      // Staff ahead of the plan, and never let anybody go. Keeping a trained
      // crew together through a soft patch is a defensible call and the reason
      // the wage bill does not follow demand down.
      const need = Math.ceil((wanted.alpha + wanted.beta) / 16);
      if (need > s.workers.production) factory.hire(need - s.workers.production);

      // Prices are left alone deliberately. A standing discount off the
      // competitor's price is not a risk, it is a spiral: competitors drift
      // toward whatever we charge, so pegging to them at 92% re-prices 92% of a
      // number we just moved, every day, all the way down to the margin floor.
      // That made this policy fail on every seed for a reason that had nothing
      // to do with the bet it is here to represent.

      // Buy capacity while the line is busy, on the facility rather than out of
      // cash. `startCapex` refuses what it cannot fund, so this leans on the
      // lender instead of checking — and the lender's patience is the risk.
      const ceiling = Math.floor(
        Math.min(
          stageCapacity(s, "press"),
          stageCapacity(s, "assembler"),
          stageCapacity(s, "packaging"),
          labourCapacity(s),
        ),
      );
      if (wanted.alpha + wanted.beta > ceiling * 0.85) {
        for (const project of ["assembler-3", "warehouse-expansion"]) {
          if (s.capex.some((c) => c.id === project)) continue;
          try {
            factory.startCapex(project);
          } catch {
            // Refused for want of funding. Nothing to do but carry on.
          }
        }
      }
    },
  };
}

/**
 * What the material *should* cost per unit produced, at each supplier. Used by
 * the report to explain a policy's procurement mix rather than by any policy.
 */
export function landedCost(material: MaterialId, supplier: keyof typeof SUPPLIERS): number {
  return BASE_MATERIAL_PRICE[material] * SUPPLIERS[supplier].multiplier;
}

export const FACTORY_POLICIES = {
  random: randomPolicy,
  static: staticPolicy,
  "fill-the-line": fillTheLinePolicy,
  growth: growthPolicy,
  "reorder-point": reorderPointPolicy,
  operator: operatorPolicy,
};
