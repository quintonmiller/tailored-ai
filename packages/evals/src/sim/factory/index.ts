/**
 * Meridian Manufacturing, as a benchmark.
 *
 * Six managers, one company, a fixed horizon, and no correct answer. The tools
 * below are split so that **nobody holds complete information or complete
 * control**: sales can see demand history and set a price but cannot look at a
 * machine; maintenance can see machine condition but cannot stop a production
 * plan that is destroying it. That split is the benchmark. A team that shares
 * one omniscient toolbox is one agent wearing six hats, and would tell you
 * nothing about a multi-agent framework.
 *
 * The economics live in `model.ts`; this file is the seam between them and the
 * harness — tools in, metrics out.
 */

import type { Tool } from "@tailored-ai/core";
import { makeRng, type Rng } from "../rng.js";
import { tool } from "../tool.js";
import {
  registerSimulation,
  type SimEvent,
  type SimMetrics,
  type Simulation,
  type SimulationOptions,
  type SimulationReport,
} from "../types.js";
import {
  availableCredit,
  BASE_MATERIAL_PRICE,
  BILL_OF_MATERIALS,
  borrowingBase,
  CAPEX_CATALOGUE,
  DEFAULTS,
  enterpriseValue,
  type FactoryConfig,
  type FactoryState,
  initialState,
  labourCapacity,
  type MaterialId,
  type ProductId,
  SUPPLIERS,
  type SupplierId,
  stageCapacity,
  tick,
  totalInventory,
  unitMaterialCost,
  unitProductionCost,
} from "./model.js";
import { FACTORY_POLICIES } from "./policies.js";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const num = (v: unknown, fallback = Number.NaN): number => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : fallback;
};

export class FactorySimulation implements Simulation {
  readonly name = "factory";
  readonly state: FactoryState;
  readonly rng: Rng;
  readonly events: SimEvent[] = [];
  private readonly horizon: number;
  private orderSeq = 0;
  /** Set when the team closes the day itself, so `advance` is not called twice. */
  endedToday = false;
  /** The balance sheet on day 0, so "value created" means what it says. */
  readonly openingValue: number;

  constructor(options: SimulationOptions) {
    const cfg: FactoryConfig = {
      ...DEFAULTS,
      ...(typeof options.days === "number" ? { days: options.days } : {}),
    };
    this.horizon = cfg.days;
    this.rng = makeRng(options.seed);
    this.state = initialState(cfg, this.rng);
    this.openingValue = enterpriseValue(this.state);
  }

  get day(): number {
    return this.state.day;
  }

  get done(): boolean {
    return this.state.bankrupt || this.state.day >= this.horizon;
  }

  get endedBecause(): string | undefined {
    if (this.state.bankrupt) return "bankrupt";
    if (this.state.day >= this.horizon) return "horizon reached";
    return undefined;
  }

  /**
   * What answering each event looks like, for the latency metric.
   *
   * Every entry here is deliberately answerable by somebody other than the
   * function that can see the event, which is the whole point of measuring it:
   *
   *   demand_shock        seen in the sales history; answered by the production
   *                       plan (operations), the headcount (the CEO) and the
   *                       price (sales). Two of the three are somebody else's.
   *   supplier_disruption seen by supply chain; answered by re-sourcing, which
   *                       supply chain does hold — the routing question here is
   *                       whether operations hears about it before the line stops.
   *   machine_failure     seen by maintenance; the plan that has to shrink
   *                       around it belongs to operations.
   *   covenant_warning    seen by finance; nothing finance holds can fix it. The
   *                       levers are price, plan and headcount, all elsewhere.
   */
  readonly responses: Record<string, string[]> = {
    demand_shock: ["set_production_plan", "set_workforce", "set_price"],
    supplier_disruption: ["place_purchase_order", "set_production_plan"],
    supplier_failure: ["place_purchase_order"],
    machine_failure: ["set_production_plan", "schedule_maintenance"],
    covenant_warning: ["set_price", "set_production_plan", "set_workforce"],
  };

  /**
   * The line the clock posts in every room at the top of the day.
   *
   * It carries the date and nothing else. Anything about the state of the
   * business would be a broadcast, and would hand every manager information the
   * simulation deliberately gave to one of them.
   */
  announce(): string {
    return (
      `Day ${this.state.day + 1} of ${this.horizon}. ` +
      "Overnight the factory ran, customers ordered, and the books moved. Today's decisions are yours."
    );
  }

  advance(): SimEvent[] {
    if (this.done) return [];
    const produced = tick(this.state, this.rng);
    this.events.push(...produced);
    this.endedToday = false;
    return produced;
  }

  // ---------------------------------------------------------------- actions
  // Shared by the tools and the baseline policies, so a policy cannot do
  // anything an agent could not.

  order(supplier: SupplierId, material: MaterialId, quantity: number): string {
    if (quantity <= 0) throw new Error("quantity must be positive");
    const s = this.state;
    const spec = SUPPLIERS[supplier];
    const unitPrice = BASE_MATERIAL_PRICE[material] * spec.multiplier;
    const cost = unitPrice * quantity;
    const credit = availableCredit(s);
    if (cost > s.cash + credit)
      throw new Error(
        `that order costs ${money(cost)}; cash is ${money(s.cash)} and the lender will advance ${money(credit)} more`,
      );
    const disrupted = s.disruptedUntil[supplier];
    const delay = disrupted && disrupted > s.day ? disrupted - s.day : 0;
    const lead = this.rng.fork(`lead:${supplier}:${s.day}:${this.orderSeq}`).int(spec.lead[0], spec.lead[1]) + delay;
    const id = `PO-${String(++this.orderSeq).padStart(3, "0")}`;
    s.cash -= cost;
    s.ledger.materialCost += cost;
    s.orders.push({
      id,
      supplier,
      material,
      quantity,
      unitPrice,
      placedDay: s.day,
      arrivesDay: s.day + lead,
    });
    return `${id}: ${quantity} ${material} from ${supplier} at ${money(unitPrice)}/unit, ${money(cost)} total, expected day ${s.day + lead}.`;
  }

  maintain(machineId: string): string {
    const machine = this.state.machines.find((m) => m.id === machineId);
    if (!machine) throw new Error(`no machine "${machineId}"`);
    if (machine.downDays > 0) throw new Error(`${machineId} is already out of service`);
    const cost = 6_000;
    this.state.cash -= cost;
    this.state.ledger.maintenanceCost += cost;
    machine.condition = Math.min(1, machine.condition + 0.3);
    machine.downDays = 1;
    return `${machineId} scheduled for preventative maintenance: ${money(cost)}, out of service 1 day, condition now ${(machine.condition * 100).toFixed(0)}%.`;
  }

  hire(delta: number): string {
    const want = Math.max(0, this.state.workers.production + Math.round(delta));
    this.state.workers.production = want;
    return `Production headcount now ${want}; labour capacity ${labourCapacity(this.state)} units/day.`;
  }

  startCapex(id: string): string {
    const spec = CAPEX_CATALOGUE.find((c) => c.id === id);
    if (!spec) throw new Error(`no capital project "${id}"`);
    if (this.state.capex.some((c) => c.id === id)) throw new Error(`${id} is already under way`);
    // Fundable on credit, not only out of cash. Capital spending is where a
    // company takes on real risk, and a rule that only lets it spend money it
    // already has removes the decision — the interesting question is whether
    // buying capacity on the line is worth it, and it cannot be asked if the
    // line is not reachable.
    if (spec.cost > this.state.cash + availableCredit(this.state))
      throw new Error(
        `${id} costs ${money(spec.cost)}; cash on hand is ${money(this.state.cash)} and the lender will advance ${money(availableCredit(this.state))} more`,
      );
    this.state.cash -= spec.cost;
    this.state.ledger.capexSpend += spec.cost;
    this.state.capex.push({ ...spec, startedDay: this.state.day });
    return `${id} started: ${money(spec.cost)}, ready in ${spec.days} days.`;
  }

  /**
   * What this function has heard lately.
   *
   * Appended to each role's own status tool rather than broadcast, which is the
   * whole design: an event reaches the organisation through the one function
   * that can see it, and travels further only if that function says something.
   * A shared notice board would hand every agent every event and quietly delete
   * the coordination problem the benchmark exists to measure.
   *
   * Nothing pushes these. They are here for whoever looks.
   */
  private notices(role: string, lookback = 10): string {
    const since = this.state.day - lookback;
    const seen = this.events.filter((e) => e.day >= since && (!e.visibleTo?.length || e.visibleTo.includes(role)));
    if (!seen.length) return "";
    return ["", "Recent notices:", ...seen.map((e) => `• day ${e.day}: ${e.message}`)].join("\n");
  }

  // ------------------------------------------------------------------ tools

  sharedTools(): Tool[] {
    return [
      tool(
        "get_day",
        "What simulated day it is, and how many remain.",
        {},
        () => {
          const s = this.state;
          return `Day ${s.day} of ${this.horizon}. Cash ${money(s.cash)}${s.debt > 0 ? `, debt ${money(s.debt)}` : ""}.`;
        },
        "read",
      ),
      tool(
        "end_day",
        "Close out the day. The factory runs, customers buy, and the next day begins. Call this once management has made its decisions.",
        {},
        () => {
          if (this.done) return `The run is over (${this.endedBecause}). Nothing further to do.`;
          const before = this.state.day;
          const produced = this.advance();
          this.endedToday = true;
          const s = this.state;
          const last = s.history.at(-1);
          const lines = [
            `Day ${before} closed.`,
            last
              ? `Sold alpha ${last.sold.alpha}/${last.demand.alpha}, beta ${last.sold.beta}/${last.demand.beta}. Cash ${money(s.cash)}.`
              : "",
            ...produced.map((e) => `• ${e.message}`),
          ].filter(Boolean);
          return lines.join("\n");
        },
      ),
    ];
  }

  tools(): Record<string, Tool[]> {
    const s = this.state;
    return {
      sales: [
        tool(
          "get_sales_history",
          "Demand, units sold and price for the last N days.",
          { days: "How many days back." },
          (a) => {
            const n = Math.max(1, Math.min(30, num(a.days, 7)));
            const rows = s.history.slice(-n);
            if (!rows.length) return "No trading history yet.";
            return rows
              .map(
                (h) =>
                  `day ${h.day}: alpha demand ${h.demand.alpha} sold ${h.sold.alpha} @ ${money(h.price.alpha)} · beta demand ${h.demand.beta} sold ${h.sold.beta} @ ${money(h.price.beta)}`,
              )
              .join("\n");
          },
          "read",
        ),
        tool(
          "get_market_report",
          "Competitor pricing, reputation, and unfilled orders.",
          {},
          () => {
            return (
              [
                `Our price: alpha ${money(s.products.alpha.price)}, beta ${money(s.products.beta.price)}.`,
                `Competitors average: alpha ${money(s.competitorPrice.alpha)}, beta ${money(s.competitorPrice.beta)}.`,
                `Customer reputation: ${(s.reputation * 100).toFixed(0)}%.`,
                `Unfilled orders carried: alpha ${s.products.alpha.backlog}, beta ${s.products.beta.backlog}.`,
                "Demand responds to price, to the season, and to whether customers got their last order on time.",
              ].join("\n") + this.notices("sales")
            );
          },
          "read",
        ),
        tool(
          "set_price",
          "Set the selling price of a product.",
          { product: "alpha or beta.", price: "The new unit price." },
          (a) => {
            const product = String(a.product ?? "").toLowerCase() as ProductId;
            if (product !== "alpha" && product !== "beta") throw new Error("product must be alpha or beta");
            const price = num(a.price);
            if (!Number.isFinite(price) || price <= 0) throw new Error("price must be a positive number");
            const cost = unitProductionCost(product);
            s.products[product].price = Math.round(price);
            return `${product} now sells at ${money(price)} (it costs ${money(cost)} to make, competitors ${money(s.competitorPrice[product])}).`;
          },
        ),
      ],
      operations: [
        tool(
          "get_production_status",
          "Capacity by stage, today's plan, and finished stock.",
          {},
          () => {
            const press = stageCapacity(s, "press");
            const assembly = stageCapacity(s, "assembler");
            const packaging = stageCapacity(s, "packaging");
            const labour = labourCapacity(s);
            const limit = Math.min(press, assembly, packaging, labour);
            const bottleneck =
              limit === labour ? "labour" : limit === assembly ? "assembly" : limit === press ? "press" : "packaging";
            return (
              [
                `Capacity/day — press ${press.toFixed(0)}, assembly ${assembly.toFixed(0)}, packaging ${packaging.toFixed(0)}, labour ${labour}.`,
                `Effective throughput ${limit.toFixed(0)} units/day; the bottleneck is ${bottleneck}.`,
                `Plan today: alpha ${s.plan.alpha}, beta ${s.plan.beta}.`,
                `Finished stock: alpha ${s.products.alpha.finished}, beta ${s.products.beta.finished}.`,
                `Machines out of service: ${
                  s.machines
                    .filter((m) => m.downDays > 0)
                    .map((m) => m.id)
                    .join(", ") || "none"
                }.`,
              ].join("\n") + this.notices("operations")
            );
          },
          "read",
        ),
        tool(
          "set_production_plan",
          "Set how many units of each product to build per day.",
          { alpha: "Units of alpha per day.", beta: "Units of beta per day." },
          (a) => {
            const alpha = Math.max(0, Math.round(num(a.alpha, s.plan.alpha)));
            const beta = Math.max(0, Math.round(num(a.beta, s.plan.beta)));
            s.plan = { alpha, beta };
            return `Plan set: alpha ${alpha}/day, beta ${beta}/day. Whether it is met depends on materials and machine availability.`;
          },
        ),
        tool(
          "get_material_cover",
          "How many days of raw materials remain at the current plan.",
          {},
          () => {
            return (Object.keys(BASE_MATERIAL_PRICE) as MaterialId[])
              .map((m) => {
                const daily = BILL_OF_MATERIALS.alpha[m] * s.plan.alpha + BILL_OF_MATERIALS.beta[m] * s.plan.beta;
                const cover = daily > 0 ? s.materials[m] / daily : Number.POSITIVE_INFINITY;
                return `${m}: ${s.materials[m]} on hand, ${daily}/day consumed, ${Number.isFinite(cover) ? `${cover.toFixed(1)} days` : "not consumed"} of cover`;
              })
              .join("\n");
          },
          "read",
        ),
      ],
      "supply-chain": [
        tool(
          "get_inventory",
          "Raw materials, finished goods and warehouse usage.",
          {},
          () => {
            return (
              [
                `Raw: aluminum ${s.materials.aluminum}, electronics ${s.materials.electronics}, packaging ${s.materials.packaging}.`,
                `Finished: alpha ${s.products.alpha.finished}, beta ${s.products.beta.finished}.`,
                `Warehouse ${totalInventory(s)} / ${s.warehouseCapacity} units. Anything over capacity is written off.`,
                `Open orders: ${
                  s.orders
                    .filter((o) => !o.received && !o.failed)
                    .map((o) => `${o.id} ${o.quantity} ${o.material} (${o.supplier}, day ${o.arrivesDay})`)
                    .join("; ") || "none"
                }`,
              ].join("\n") + this.notices("supply-chain")
            );
          },
          "read",
        ),
        tool(
          "get_supplier_quotes",
          "Price, lead time and reliability for each supplier.",
          { material: "aluminum, electronics or packaging." },
          (a) => {
            const material = String(a.material ?? "").toLowerCase() as MaterialId;
            if (!(material in BASE_MATERIAL_PRICE))
              throw new Error("material must be aluminum, electronics or packaging");
            return (Object.keys(SUPPLIERS) as SupplierId[])
              .map((id) => {
                const spec = SUPPLIERS[id];
                const disrupted = s.disruptedUntil[id];
                const note = disrupted && disrupted > s.day ? `  [DISRUPTED until ~day ${disrupted}]` : "";
                return `${id}: ${money(BASE_MATERIAL_PRICE[material] * spec.multiplier)}/unit, ${spec.lead[0]}-${spec.lead[1]} days, ${(spec.reliability * 100).toFixed(0)}% reliable${note}`;
              })
              .join("\n");
          },
          "read",
        ),
        tool(
          "place_purchase_order",
          "Order raw material from a supplier. Cash leaves immediately; goods arrive after the lead time.",
          {
            supplier: "domestic, overseas or spot.",
            material: "aluminum, electronics or packaging.",
            quantity: "Units to buy.",
          },
          (a) => {
            const supplier = String(a.supplier ?? "").toLowerCase() as SupplierId;
            const material = String(a.material ?? "").toLowerCase() as MaterialId;
            if (!(supplier in SUPPLIERS)) throw new Error("supplier must be domestic, overseas or spot");
            if (!(material in BASE_MATERIAL_PRICE))
              throw new Error("material must be aluminum, electronics or packaging");
            return this.order(supplier, material, Math.round(num(a.quantity, 0)));
          },
        ),
      ],
      maintenance: [
        tool(
          "list_machine_health",
          "Condition and availability of every machine.",
          {},
          () => {
            const predictive = s.capex.some((c) => c.id === "predictive-maintenance" && c.completedDay !== undefined);
            return (
              s.machines
                .map((m) => {
                  const risk = 0.055 * (1 - m.condition) ** 2.2;
                  const forecast = predictive ? `, ~${(risk * 30 * 100).toFixed(0)}% chance of failure in 30 days` : "";
                  return `${m.id} (${m.stage}): condition ${(m.condition * 100).toFixed(0)}%${m.downDays > 0 ? `, OUT for ${m.downDays}d` : ""}${forecast}`;
                })
                .join("\n") + this.notices("maintenance")
            );
          },
          "read",
        ),
        tool(
          "schedule_maintenance",
          "Preventative maintenance: $6,000 and one day out of service, condition restored by 30 points.",
          { machine: "Machine id." },
          (a) => this.maintain(String(a.machine ?? "")),
        ),
      ],
      finance: [
        tool(
          "get_financials",
          "Cash, debt, and the cost ledger so far.",
          {},
          () => {
            const l = s.ledger;
            return (
              [
                `Cash ${money(s.cash)}, debt ${money(s.debt)}. Enterprise value ${money(enterpriseValue(s))}.`,
                `Borrowing base ${money(borrowingBase(s))} (55% of machines and stock); ${money(availableCredit(s))} still available. ` +
                  "If debt passes the base the lender withdraws the line and the company is finished.",
                `Revenue ${money(l.revenue)}.`,
                `Costs — materials ${money(l.materialCost)}, conversion ${money(l.conversionCost)}, labour ${money(l.labourCost)}, maintenance ${money(l.maintenanceCost)}, holding ${money(l.holdingCost)}, interest ${money(l.interestCost)}, capex ${money(l.capexSpend)}.`,
                `Sales lost to stock-outs so far: ${money(l.lostSales)}.`,
              ].join("\n") + this.notices("finance")
            );
          },
          "read",
        ),
        tool(
          "get_unit_economics",
          "Price, material cost and contribution per unit.",
          { product: "alpha or beta." },
          (a) => {
            const product = String(a.product ?? "").toLowerCase() as ProductId;
            if (product !== "alpha" && product !== "beta") throw new Error("product must be alpha or beta");
            const materials = unitMaterialCost(product);
            const cost = unitProductionCost(product);
            const price = s.products[product].price;
            return `${product}: price ${money(price)}, materials ${money(materials)}, conversion ${money(cost - materials)}, total cost ${money(cost)}, contribution ${money(price - cost)} (${(((price - cost) / price) * 100).toFixed(0)}%).`;
          },
          "read",
        ),
        tool(
          "list_capital_projects",
          "Capital projects available, their cost and lead time.",
          {},
          () => {
            return CAPEX_CATALOGUE.map((c) => {
              const started = s.capex.find((p) => p.id === c.id);
              const status = started
                ? started.completedDay !== undefined
                  ? " [complete]"
                  : ` [under way, ready day ${(started.startedDay ?? 0) + c.days}]`
                : "";
              return `${c.id}: ${money(c.cost)}, ${c.days} days — ${c.description}${status}`;
            }).join("\n");
          },
          "read",
        ),
      ],
      ceo: [
        tool(
          "get_executive_dashboard",
          "The whole company at a glance.",
          {},
          () => {
            const last = s.history.at(-1);
            const limit = Math.min(
              stageCapacity(s, "press"),
              stageCapacity(s, "assembler"),
              stageCapacity(s, "packaging"),
              labourCapacity(s),
            );
            return (
              [
                `Day ${s.day} of ${this.horizon}. Enterprise value ${money(enterpriseValue(s))} (opened at ${money(this.openingValue)}).`,
                `Cash ${money(s.cash)}, debt ${money(s.debt)}, reputation ${(s.reputation * 100).toFixed(0)}%.`,
                last
                  ? `Yesterday: alpha ${last.sold.alpha}/${last.demand.alpha}, beta ${last.sold.beta}/${last.demand.beta}.`
                  : "No trading yet.",
                `Throughput ceiling ${limit.toFixed(0)} units/day; plan asks for ${s.plan.alpha + s.plan.beta}.`,
                `Backlog: alpha ${s.products.alpha.backlog}, beta ${s.products.beta.backlog}.`,
              ].join("\n") + this.notices("ceo")
            );
          },
          "read",
        ),
        tool(
          "approve_capital_project",
          "Commit to a capital project. The cash leaves now; the benefit arrives after the build.",
          { project: "Project id from the finance team's list." },
          (a) => this.startCapex(String(a.project ?? "")),
        ),
        tool(
          "set_workforce",
          "Hire or release production workers. Each produces 16 units/day of capacity and costs $190/day.",
          { production: "Number of production workers to employ." },
          (a) => {
            const want = Math.max(0, Math.round(num(a.production, s.workers.production)));
            return this.hire(want - s.workers.production);
          },
        ),
      ],
    };
  }

  metrics(): SimMetrics {
    const s = this.state;
    const l = s.ledger;
    const demand = s.history.reduce((sum, h) => sum + h.demand.alpha + h.demand.beta, 0);
    const sold = s.history.reduce((sum, h) => sum + h.sold.alpha + h.sold.beta, 0);
    const downtime = s.history.length
      ? s.machines.reduce((sum, m) => sum + (m.downDays > 0 ? 1 : 0), 0) / s.machines.length
      : 0;
    return {
      enterpriseValue: enterpriseValue(s),
      // Against the *opening balance sheet*, not the opening cash. Subtracting
      // cash alone counted the machines and stock the company already owned as
      // value it had created — about $660K of it, which flattered every policy
      // equally and hid that most of them were losing money.
      valueCreated: enterpriseValue(s) - this.openingValue,
      revenue: Math.round(l.revenue),
      operatingProfit: Math.round(
        l.revenue -
          l.materialCost -
          l.conversionCost -
          l.labourCost -
          l.maintenanceCost -
          l.holdingCost -
          l.interestCost,
      ),
      serviceLevel: demand > 0 ? Math.round((sold / demand) * 1000) / 1000 : 1,
      lostSales: Math.round(l.lostSales),
      spoilage: Math.round(l.spoilage),
      reputation: Math.round(s.reputation * 1000) / 1000,
      cash: Math.round(s.cash),
      debt: Math.round(s.debt),
      bankrupt: s.bankrupt ? 1 : 0,
      daysCompleted: s.day,
      machineDowntime: Math.round(downtime * 1000) / 1000,
    };
  }

  objective(): number {
    return enterpriseValue(this.state);
  }

  snapshot(): Record<string, unknown> {
    return { ...this.metrics(), day: this.state.day, horizon: this.horizon };
  }
}

/**
 * How this world wants its ladder printed: money, and the two things a mean
 * cannot tell you — whether the customers were served and whether anybody went
 * broke getting there.
 */
const usd = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
};

export const FACTORY_REPORT: SimulationReport = {
  key: "enterpriseValue",
  format: usd,
  columns: [
    { label: "service", key: "serviceLevel", kind: "mean" },
    { label: "bankrupt", key: "bankrupt", kind: "rate" },
  ],
};

registerSimulation("factory", (options) => new FactorySimulation(options), FACTORY_POLICIES, FACTORY_REPORT);

export { FACTORY_POLICIES };
