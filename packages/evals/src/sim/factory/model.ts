/**
 * Meridian Manufacturing — the economy underneath the benchmark.
 *
 * No riddle, no hidden solution, no final answer to guess. A company with a
 * bank account, machines that wear out, suppliers with lead times, and
 * customers whose demand responds to price and to how well they have been
 * served. At the end of the horizon the balance sheet says how it went.
 *
 * ## The properties the benchmark needs, and where each one comes from
 *
 *   a gradient      — a better decision is worth measurably more money, at
 *                     every level of play. Price elasticity, lead-time
 *                     tradeoffs and preventative maintenance each carry real
 *                     expected value, so there is always a next improvement.
 *   no free lunch   — every lever has a cost that bites somewhere else.
 *                     Cheap materials arrive late; high prices shed volume;
 *                     running machines hard breaks them.
 *   coupling        — optimising one subsystem alone is actively harmful.
 *                     Cutting price with the assembler at 97% and six days of
 *                     electronics on hand creates demand that becomes backlog,
 *                     which becomes lost reputation, which becomes less demand.
 *   irreducible luck— failures are probabilistic, so one run cannot rank two
 *                     policies. That is a feature: it forces seed sweeps.
 *
 * ## What the agents can and cannot see
 *
 * The demand function below is never shown to anyone. Sales sees history,
 * competitor prices and a noisy market report, and has to infer. That makes
 * forecasting part of performance rather than a lookup.
 */

import type { Rng } from "../rng.js";
import type { SimEvent } from "../types.js";

export type ProductId = "alpha" | "beta";
export type MaterialId = "aluminum" | "electronics" | "packaging";
export type SupplierId = "domestic" | "overseas" | "spot";

/** What one unit consumes. The bottleneck that makes procurement a real job. */
export const BILL_OF_MATERIALS: Record<ProductId, Record<MaterialId, number>> = {
  alpha: { aluminum: 2, electronics: 1, packaging: 1 },
  beta: { aluminum: 3, electronics: 4, packaging: 1 },
};

export const BASE_MATERIAL_PRICE: Record<MaterialId, number> = {
  aluminum: 6,
  electronics: 14,
  packaging: 3,
};

export interface ProductState {
  price: number;
  /** Where demand sits before price, season, reputation and noise act on it. */
  demandBaseline: number;
  finished: number;
  /** Orders taken and not yet shipped. Ages into lost sales. */
  backlog: number;
}

export interface Machine {
  id: string;
  stage: "press" | "assembler" | "packaging";
  capacityPerDay: number;
  /** 0-1. Drifts down with use, jumps up with maintenance, and drives failure odds. */
  condition: number;
  /** Days remaining before it runs again. Maintenance and breakdowns both set this. */
  downDays: number;
  /** Replacement value, for the balance sheet. */
  value: number;
}

export interface PurchaseOrder {
  id: string;
  supplier: SupplierId;
  material: MaterialId;
  quantity: number;
  unitPrice: number;
  placedDay: number;
  arrivesDay: number;
  /** Set when the supplier failed to deliver at all. Money spent, nothing received. */
  failed?: boolean;
  received?: boolean;
}

export interface CapexProject {
  id: string;
  cost: number;
  days: number;
  description: string;
  startedDay?: number;
  completedDay?: number;
}

export interface FactoryConfig {
  days: number;
  cash: number;
  warehouseCapacity: number;
  workers: { production: number; maintenance: number };
}

export const DEFAULTS: FactoryConfig = {
  days: 60,
  cash: 500_000,
  // Big enough that the overseas supplier's 12-24 day lead time can actually be
  // covered. It could not be: consumption runs ~1,300 material units a day, so
  // three weeks of cover is ~27,000 units against a 12,000-unit warehouse. The
  // cheap supplier was not a tradeoff, it was a trap — every policy that used it
  // as intended overflowed the warehouse and wrote the excess off. Holding cost
  // is what makes carrying stock expensive now, rather than a hard wall.
  warehouseCapacity: 40_000,
  workers: { production: 18, maintenance: 2 },
};

/** Per worker per day. Labour is the cost that does not stop when demand does. */
const WAGE = { production: 190, maintenance: 240 };
/** Per unit of finished goods per day. Makes hoarding cost something. */
const HOLDING_COST = 0.08;
/** Charged on debt daily. Cheap enough to be a tool, dear enough to be a decision. */
const DAILY_INTEREST = 0.0004;

export interface FactoryState {
  day: number;
  cash: number;
  debt: number;
  bankrupt: boolean;
  products: Record<ProductId, ProductState>;
  materials: Record<MaterialId, number>;
  machines: Machine[];
  orders: PurchaseOrder[];
  capex: CapexProject[];
  workers: { production: number; maintenance: number };
  warehouseCapacity: number;
  /** 0-1, moved by whether customers got what they ordered on time. */
  reputation: number;
  /** Competitors' average price per product, which the market responds to. */
  competitorPrice: Record<ProductId, number>;
  /** What today's production plan asks for. Unmet parts simply do not get made. */
  plan: Record<ProductId, number>;
  /** Set for a supplier whose shipments are disrupted, with the day it clears. */
  disruptedUntil: Partial<Record<SupplierId, number>>;
  ledger: {
    revenue: number;
    materialCost: number;
    labourCost: number;
    maintenanceCost: number;
    holdingCost: number;
    interestCost: number;
    capexSpend: number;
    expediteCost: number;
    lostSales: number;
    spoilage: number;
  };
  history: DayRecord[];
}

export interface DayRecord {
  day: number;
  demand: Record<ProductId, number>;
  sold: Record<ProductId, number>;
  produced: Record<ProductId, number>;
  cash: number;
  reputation: number;
  price: Record<ProductId, number>;
}

export const SUPPLIERS: Record<SupplierId, { lead: [number, number]; reliability: number; multiplier: number }> = {
  // Dear, quick, dependable. The right answer more often than its price suggests.
  domestic: { lead: [2, 4], reliability: 0.98, multiplier: 1.15 },
  // Half the price and three weeks away, with one shipment in eight going
  // astray. Optimal on a spreadsheet, and the reason companies hold safety stock.
  overseas: { lead: [12, 24], reliability: 0.88, multiplier: 0.72 },
  // Tomorrow, at a punishing markup. The cost of having been wrong earlier.
  spot: { lead: [1, 1], reliability: 1.0, multiplier: 1.75 },
};

export const CAPEX_CATALOGUE: CapexProject[] = [
  {
    id: "assembler-3",
    cost: 275_000,
    days: 30,
    description: "A third assembler: +220 units/day of assembly capacity.",
  },
  {
    id: "predictive-maintenance",
    cost: 80_000,
    days: 14,
    description: "Predictive maintenance: machine condition reports gain a failure-probability estimate.",
  },
  {
    id: "warehouse-expansion",
    cost: 150_000,
    days: 45,
    description: "Warehouse expansion: +10,000 units of storage.",
  },
];

export function initialState(cfg: FactoryConfig): FactoryState {
  return {
    day: 0,
    cash: cfg.cash,
    debt: 0,
    bankrupt: false,
    products: {
      alpha: { price: 120, demandBaseline: 180, finished: 300, backlog: 0 },
      beta: { price: 210, demandBaseline: 75, finished: 100, backlog: 0 },
    },
    materials: { aluminum: 5_000, electronics: 2_000, packaging: 4_000 },
    machines: [
      // Sized so that labour binds first at the opening headcount, machines bind
      // second, and both sit *above* baseline demand. The first version put the
      // ceiling below baseline demand, which meant every policy was stocked out
      // from day one and no decision could improve anything — the benchmark had
      // no headroom to measure into.
      { id: "press-1", stage: "press", capacityPerDay: 420, condition: 0.92, downDays: 0, value: 180_000 },
      { id: "assembler-1", stage: "assembler", capacityPerDay: 260, condition: 0.85, downDays: 0, value: 240_000 },
      { id: "assembler-2", stage: "assembler", capacityPerDay: 200, condition: 0.96, downDays: 0, value: 160_000 },
      { id: "packaging-1", stage: "packaging", capacityPerDay: 400, condition: 0.78, downDays: 0, value: 90_000 },
    ],
    orders: [],
    capex: [],
    workers: { ...cfg.workers },
    warehouseCapacity: cfg.warehouseCapacity,
    reputation: 0.85,
    competitorPrice: { alpha: 122, beta: 205 },
    plan: { alpha: 180, beta: 70 },
    disruptedUntil: {},
    ledger: {
      revenue: 0,
      materialCost: 0,
      labourCost: 0,
      maintenanceCost: 0,
      holdingCost: 0,
      interestCost: 0,
      capexSpend: 0,
      expediteCost: 0,
      lostSales: 0,
      spoilage: 0,
    },
    history: [],
  };
}

/**
 * A gentle year. Peaks around day 45 of a 60-day run, so a horizon of any
 * length sees both a build-up and a fall — a policy that reads the trend and
 * one that extrapolates the last week end up in different places.
 */
export function seasonality(day: number): number {
  return 1 + 0.25 * Math.sin((day / 90) * Math.PI * 2);
}

/**
 * How much volume a price buys.
 *
 * Constant-elasticity around the competitor price rather than around a fixed
 * anchor, so undercutting the market works and the market moves. Elasticity
 * 1.6 is firm enough that a 10% cut does not pay for itself in margin, which
 * is what makes "cut price to move volume" a decision instead of a reflex.
 */
export function priceEffect(price: number, competitor: number): number {
  const ratio = Math.max(0.2, price / Math.max(1, competitor));
  return ratio ** -1.6;
}

/** Being unreliable costs demand, with a floor: a bad reputation is not a death sentence. */
export function reputationEffect(reputation: number): number {
  return 0.55 + 0.45 * Math.max(0, Math.min(1, reputation));
}

/**
 * Today's demand. Never shown to any agent — this is the thing they infer.
 */
export function demandFor(state: FactoryState, product: ProductId, rng: Rng): number {
  const p = state.products[product];
  const noise = 1 + 0.2 * rng.normal() * 0.5;
  const raw =
    p.demandBaseline *
    seasonality(state.day) *
    priceEffect(p.price, state.competitorPrice[product]) *
    reputationEffect(state.reputation) *
    Math.max(0.35, noise);
  return Math.max(0, Math.round(raw));
}

/** Effective throughput of one stage: capacity scaled by condition, zero while down. */
export function stageCapacity(state: FactoryState, stage: Machine["stage"]): number {
  return state.machines
    .filter((m) => m.stage === stage && m.downDays <= 0)
    .reduce((sum, m) => sum + m.capacityPerDay * (0.5 + 0.5 * m.condition), 0);
}

/** Units of labour available. Production workers cap what the machines can be fed. */
export function labourCapacity(state: FactoryState): number {
  return state.workers.production * 16;
}

export function totalInventory(state: FactoryState): number {
  const finished = state.products.alpha.finished + state.products.beta.finished;
  const raw = state.materials.aluminum + state.materials.electronics + state.materials.packaging;
  return finished + raw;
}

/**
 * What the company is worth if you stopped today: cash, plus stock at a
 * liquidation discount, plus machines at depreciated value, minus debt.
 *
 * The headline number. Deliberately not "profit": a company that made money by
 * running its machines into the ground and emptying its warehouse has not
 * created value, and only a balance sheet notices.
 */
export function enterpriseValue(state: FactoryState): number {
  const finishedValue =
    state.products.alpha.finished * state.products.alpha.price * 0.6 +
    state.products.beta.finished * state.products.beta.price * 0.6;
  const rawValue = (Object.keys(BASE_MATERIAL_PRICE) as MaterialId[]).reduce(
    (sum, m) => sum + state.materials[m] * BASE_MATERIAL_PRICE[m] * 0.5,
    0,
  );
  const machineValue = state.machines.reduce((sum, m) => sum + m.value * m.condition, 0);
  return Math.round(state.cash + finishedValue + rawValue + machineValue - state.debt);
}

/** Unit material cost at list price, for margin arithmetic. */
export function unitMaterialCost(product: ProductId): number {
  return (Object.keys(BILL_OF_MATERIALS[product]) as MaterialId[]).reduce(
    (sum, m) => sum + BILL_OF_MATERIALS[product][m] * BASE_MATERIAL_PRICE[m],
    0,
  );
}

/**
 * One day, in the order the world resolves it.
 *
 * Deliveries land, machines break, production runs against whatever materials
 * and capacity survived, customers arrive and buy what exists, and then the
 * bills are paid. The order matters: materials ordered today cannot be used
 * today, and a machine that fails this morning costs today's output.
 */
export function tick(state: FactoryState, rng: Rng): SimEvent[] {
  const events: SimEvent[] = [];
  const day = state.day;

  // --- deliveries -----------------------------------------------------------
  for (const order of state.orders) {
    if (order.received || order.failed || order.arrivesDay > day) continue;
    const supplier = SUPPLIERS[order.supplier];
    if (!rng.fork(`delivery:${order.id}`).chance(supplier.reliability)) {
      order.failed = true;
      events.push({
        day,
        kind: "supplier_failure",
        message: `Purchase order ${order.id} (${order.quantity} ${order.material}, ${order.supplier}) failed to arrive. The money is spent; the goods are not coming.`,
        visibleTo: ["supply-chain"],
      });
      continue;
    }
    order.received = true;
    state.materials[order.material] += order.quantity;
  }

  // --- disruptions ----------------------------------------------------------
  // Rare, and they extend every in-flight order from that supplier. This is the
  // event that makes a single cheap supplier a concentration risk rather than a
  // saving.
  const disruptionRng = rng.fork(`disruption:${day}`);
  if (disruptionRng.chance(0.012)) {
    const supplier: SupplierId = disruptionRng.chance(0.7) ? "overseas" : "domestic";
    const extra = disruptionRng.int(7, 21);
    state.disruptedUntil[supplier] = day + extra;
    for (const order of state.orders) {
      if (order.supplier === supplier && !order.received && !order.failed) order.arrivesDay += extra;
    }
    events.push({
      day,
      kind: "supplier_disruption",
      message: `${supplier} shipments are disrupted for roughly ${extra} days. In-flight orders are delayed; new orders will be slow to arrive.`,
      visibleTo: ["supply-chain"],
    });
  }

  // --- machines -------------------------------------------------------------
  for (const machine of state.machines) {
    if (machine.downDays > 0) {
      machine.downDays -= 1;
      if (machine.downDays === 0) {
        events.push({
          day,
          kind: "machine_back",
          message: `${machine.id} is back in service.`,
          visibleTo: ["maintenance", "operations"],
        });
      }
      continue;
    }
    // Condition falls faster the harder the machine is worked. A plan that runs
    // everything flat out is buying output with reliability.
    const load = Math.min(1.4, (state.plan.alpha + state.plan.beta) / Math.max(1, machine.capacityPerDay));
    machine.condition = Math.max(0.05, machine.condition - 0.004 * (0.6 + load));
    // Failure odds rise steeply below ~0.6 condition. Preventative maintenance
    // is worth roughly three times its cost in expectation down there, and
    // roughly nothing at 0.95 — so "maintain everything always" is also wrong.
    const risk = 0.055 * (1 - machine.condition) ** 2.2;
    if (rng.fork(`fail:${machine.id}:${day}`).chance(risk)) {
      const outage = rng.fork(`outage:${machine.id}:${day}`).int(3, 6);
      machine.downDays = outage;
      const repair = 21_000;
      state.cash -= repair;
      state.ledger.maintenanceCost += repair;
      machine.condition = Math.min(1, machine.condition + 0.35);
      events.push({
        day,
        kind: "machine_failure",
        message: `${machine.id} has failed. Corrective repair cost $${repair.toLocaleString()} and it is out for ${outage} days.`,
        visibleTo: ["maintenance", "operations"],
      });
    }
  }

  // --- capex ----------------------------------------------------------------
  for (const project of state.capex) {
    if (project.completedDay !== undefined || project.startedDay === undefined) continue;
    if (day >= project.startedDay + project.days) {
      project.completedDay = day;
      if (project.id === "assembler-3") {
        state.machines.push({
          id: "assembler-3",
          stage: "assembler",
          capacityPerDay: 220,
          condition: 1,
          downDays: 0,
          value: 275_000,
        });
      }
      if (project.id === "warehouse-expansion") state.warehouseCapacity += 10_000;
      events.push({ day, kind: "capex_complete", message: `${project.id} is complete and in service.` });
    }
  }

  // --- production -----------------------------------------------------------
  const press = stageCapacity(state, "press");
  const assembly = stageCapacity(state, "assembler");
  const packaging = stageCapacity(state, "packaging");
  const labour = labourCapacity(state);
  const throughput = Math.floor(Math.min(press, assembly, packaging, labour));

  const produced: Record<ProductId, number> = { alpha: 0, beta: 0 };
  let remaining = throughput;
  // Beta first when it is the richer contribution per unit of capacity — but the
  // plan is the agents' to set, and this only rations what the plan asked for.
  for (const product of ["alpha", "beta"] as ProductId[]) {
    const want = Math.max(0, Math.min(state.plan[product], remaining));
    if (want <= 0) continue;
    const bom = BILL_OF_MATERIALS[product];
    const limit = (Object.keys(bom) as MaterialId[]).reduce(
      (min, m) => Math.min(min, Math.floor(state.materials[m] / bom[m])),
      want,
    );
    const make = Math.max(0, limit);
    for (const m of Object.keys(bom) as MaterialId[]) state.materials[m] -= bom[m] * make;
    produced[product] = make;
    state.products[product].finished += make;
    remaining -= make;
  }

  // --- demand and sales -----------------------------------------------------
  const demand: Record<ProductId, number> = { alpha: 0, beta: 0 };
  const sold: Record<ProductId, number> = { alpha: 0, beta: 0 };
  let unmet = 0;
  let total = 0;
  for (const product of ["alpha", "beta"] as ProductId[]) {
    const p = state.products[product];
    const today = demandFor(state, product, rng.fork(`demand:${product}:${day}`));
    demand[product] = today;
    const wanted = today + p.backlog;
    const ship = Math.min(wanted, p.finished);
    p.finished -= ship;
    sold[product] = ship;
    state.cash += ship * p.price;
    state.ledger.revenue += ship * p.price;
    // What could not be shipped becomes backlog, and backlog decays into lost
    // sales rather than waiting forever — customers go elsewhere.
    const short = wanted - ship;
    p.backlog = Math.round(short * 0.6);
    state.ledger.lostSales += (short - p.backlog) * p.price;
    unmet += short;
    total += wanted;
  }

  // Reputation follows service level, slowly up and quickly down — which is
  // what makes a stock-out expensive long after it is over.
  const service = total > 0 ? 1 - unmet / total : 1;
  const drift = service >= state.reputation ? 0.04 : 0.12;
  state.reputation = Math.max(0, Math.min(1, state.reputation + (service - state.reputation) * drift));

  // --- competitors ----------------------------------------------------------
  // They drift toward undercutting a company that prices high, so a pure
  // margin strategy erodes on its own.
  for (const product of ["alpha", "beta"] as ProductId[]) {
    const ours = state.products[product].price;
    const theirs = state.competitorPrice[product];
    const target = theirs + (ours - theirs) * 0.25;
    state.competitorPrice[product] = Math.round((theirs + (target - theirs) * 0.3) * 100) / 100;
  }

  // --- costs ----------------------------------------------------------------
  const labourCost = state.workers.production * WAGE.production + state.workers.maintenance * WAGE.maintenance;
  const holding = totalInventory(state) * HOLDING_COST;
  state.cash -= labourCost + holding;
  state.ledger.labourCost += labourCost;
  state.ledger.holdingCost += holding;

  // Over-full warehouse spoils the excess. The cost of hoarding cheap material.
  const over = totalInventory(state) - state.warehouseCapacity;
  if (over > 0) {
    const shed = Math.ceil(over);
    const fromRaw = Math.min(shed, state.materials.aluminum);
    state.materials.aluminum -= fromRaw;
    state.ledger.spoilage += fromRaw * BASE_MATERIAL_PRICE.aluminum;
    events.push({
      day,
      kind: "warehouse_overflow",
      message: `The warehouse is over capacity; ${fromRaw} units of aluminum were written off.`,
      visibleTo: ["supply-chain", "operations"],
    });
  }

  // Cash below zero becomes debt automatically — a line of credit, not a
  // failure. Failure is debt the company cannot carry.
  if (state.cash < 0) {
    state.debt += -state.cash;
    state.cash = 0;
  }
  const interest = state.debt * DAILY_INTEREST;
  state.debt += interest;
  state.ledger.interestCost += interest;
  if (state.debt > 900_000) {
    state.bankrupt = true;
    events.push({ day, kind: "bankruptcy", message: "The company cannot service its debt. Operations have ceased." });
  }

  state.history.push({
    day,
    demand,
    sold,
    produced,
    cash: Math.round(state.cash),
    reputation: Math.round(state.reputation * 1000) / 1000,
    price: { alpha: state.products.alpha.price, beta: state.products.beta.price },
  });
  state.day += 1;
  return events;
}
