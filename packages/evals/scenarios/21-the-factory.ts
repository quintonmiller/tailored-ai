/**
 * Six managers, one company, sixty days, and no correct answer.
 *
 * Every other scenario in this set asks whether a team can work something out.
 * This one asks how well it runs a business — there is no puzzle to solve, no
 * final code to submit, and no transcript a grader has to judge. At the end of
 * the horizon the balance sheet says how it went, and the same balance sheet
 * says how five non-model baseline policies went on the identical seed. The
 * result is a position on a scale rather than a verdict.
 *
 * ## What makes it hard, and none of it is the arithmetic
 *
 * **Nobody can see the whole company.** Sales holds demand history and the
 * price; it cannot look at a machine. Maintenance can see a press wearing out
 * and cannot stop the plan that is wearing it out. The CEO can see the summary
 * and cannot place an order. Every lever that matters is one function away from
 * the information that justifies it, so the only way to run the place well is to
 * tell each other things.
 *
 * **Optimising one function is actively harmful.** The `fill-the-line` baseline
 * exists to prove it: a sales manager who moves price until the factory is full
 * posts the best service level in the whole set and destroys tens of thousands
 * of dollars doing it, because filling a line by discounting only pays when
 * capacity is what binds. So does `growth`, which builds and staffs 20% ahead of
 * demand and never lets anyone go. A team that optimises subsystem by subsystem
 * lands on one of those two by default.
 *
 * **Something goes wrong that only one of them can see.** Partway through, a
 * distributor takes its business elsewhere and demand falls by nearly half, for
 * good. Sales gets the call. The three responses that matter — cut the plan, cut
 * the headcount, move the price — are held by operations, the CEO and sales
 * respectively. Two of the three are somebody else's, which is what makes
 * `responds_within` a measurement of the organisation rather than of an agent.
 *
 * ## Why the cadence is eight days
 *
 * Because the alternative measures nothing. A horizon short enough to give every
 * simulated day its own round of turns is short enough to invert the ladder:
 * under about thirty days the *random* policy beats every competent one, since
 * buying stock, maintaining a machine and hiring all cost money now and repay
 * later, and the run ends before the repayment. Management meets every eight
 * days instead, which buys a sixty-day horizon for eight rounds — and is closer
 * to how a real management team works than a daily stand-up would be.
 */

import { defineScenario } from "../src/define.js";

const OBJECTIVE =
  "The company is scored on one number: enterprise value at the end of day 60 — cash, plus stock, " +
  "plus machines at their condition, minus debt. Not revenue, not utilisation, not service level. " +
  "Building things nobody buys, and discounting to keep the line busy, both destroy it.";

const SHARED =
  "You manage one function of Meridian Manufacturing. You can see and control only your own part of " +
  "the business, so anything another manager needs from you, you have to tell them in the room. " +
  "Read your instruments first, then act: every meeting, use your own tools to change something or " +
  "to deliberately confirm the current setting is still right. Reporting a problem is not the same " +
  "as fixing it, and nothing changes in this company unless somebody calls a tool. Post what you " +
  "found and what you did — a number nobody else can see is worth nothing until you say it. " +
  OBJECTIVE;

const manager = (description: string, instructions: string) => ({
  description,
  instructions: `${instructions}\n\n${SHARED}`,
});

export default defineScenario({
  id: "the-factory",
  category: "simulation",
  difficulty: 10,
  intent:
    "An objective rather than an answer: run a manufacturer for sixty simulated days against five " +
    "non-model baseline policies on the same seed. Grades enterprise value, service level, solvency " +
    "and how long the organisation took to react to a demand collapse only one manager could see.",

  simulation: {
    name: "factory",
    days: 60,
    daysPerRound: 8,
    roles: {
      sales: "sales",
      operations: "operations",
      "supply-chain": "supply-chain",
      maintenance: "maintenance",
      finance: "finance",
      ceo: "ceo",
    },
  },

  agent: {
    name: "ceo",
    ...manager(
      "Chief executive of Meridian Manufacturing.",
      "You are accountable for the company's value at the end of the run. You hold the summary view, " +
        "the headcount and the capital budget, and nothing else — you cannot set a price, place an " +
        "order or touch a machine. Your job is to ask the right manager for the number you are " +
        "missing and to decide the things only you can decide.",
    ),
  },

  config: {
    agents: {
      sales: manager(
        "Sales manager.",
        "You set prices and you can see demand, competitor pricing, reputation and unfilled orders. " +
          "Demand responds to price, to the season, and to whether customers got their last order on " +
          "time — you are never shown the formula and have to infer it from the history. You cannot " +
          "see a machine, a material or the bank balance, so before you promise volume, ask whether " +
          "the factory can build it.",
      ),
      operations: manager(
        "Operations manager.",
        "You set how many units of each product the factory builds per day, and you can see capacity " +
          "by stage, the current plan and finished stock. Every unit costs real money to build whether " +
          "or not it sells. You cannot see demand and you cannot set a price, so a plan you have not " +
          "checked against sales is a guess.",
      ),
      "supply-chain": manager(
        "Supply chain manager.",
        "You buy raw material. Three suppliers: dear and quick, cheap and three weeks away with one " +
          "shipment in eight going astray, and next-day at a punishing markup. Cash leaves when you " +
          "order and goods arrive after the lead time, so what you buy today is for a plan somebody " +
          "else has not written yet. Ask operations what it intends to build.",
      ),
      maintenance: manager(
        "Maintenance manager.",
        "You can see the condition of every machine and schedule preventative work. Condition falls " +
          "faster the harder a machine is run, and failure odds rise steeply below about 60% — a " +
          "breakdown costs several times what preventative work does, and maintaining a healthy " +
          "machine costs money for nothing. You cannot change the production plan that is wearing " +
          "them out; operations can.",
      ),
      finance: manager(
        "Finance manager.",
        "You can see cash, debt, the cost ledger, unit economics and the capital projects available. " +
          "The company borrows against its own assets: if debt passes what the lender will advance, " +
          "the line is withdrawn and the company is finished. You hold no operational lever at all — " +
          "everything you find has to reach somebody else to matter.",
      ),
    },
  },

  rooms: [
    {
      name: "plant",
      purpose:
        "Meridian Manufacturing's management meeting. The team meets every eight days for sixty days. " +
        "Between meetings the factory runs, customers order, suppliers deliver and the books move.",
      members: ["ceo", "sales", "operations", "supply-chain", "maintenance", "finance"],
      deliver: "poll",
      wakeOn: "all",
    },
  ],

  wake: {
    room: "plant",
    rounds: 8,
    agents: ["ceo", "sales", "operations", "supply-chain", "maintenance", "finance"],
  },

  /**
   * A ladder rather than a verdict, because a sixty-day company has no single
   * moment of success. The bottom rungs ask whether each manager operated its
   * own function at all; the middle ones ask whether the organisation beat
   * progressively better ways of not thinking; the top ones ask whether it
   * noticed the thing that went wrong and got word to the people who could act.
   */
  milestones: [
    { id: "sales-set-a-price", points: 2, when: { calls_by: { agent: "sales", tool: "set_price" } } },
    {
      id: "operations-set-a-plan",
      points: 2,
      when: { calls_by: { agent: "operations", tool: "set_production_plan" } },
    },
    {
      id: "supply-chain-bought-material",
      points: 2,
      when: { calls_by: { agent: "supply-chain", tool: "place_purchase_order" } },
    },
    {
      id: "maintenance-serviced-a-machine",
      points: 2,
      when: { calls_by: { agent: "maintenance", tool: "schedule_maintenance" } },
    },
    { id: "stayed-solvent", points: 3, when: { sim_metric: { metric: "bankrupt", at_most: 0 } } },
    { id: "served-most-orders", points: 4, when: { sim_metric: { metric: "serviceLevel", at_least: 0.8 } } },
    { id: "beat-doing-it-at-random", points: 5, when: { beats_baseline: { policy: "random" } } },
    { id: "beat-setting-it-and-leaving", points: 8, when: { beats_baseline: { policy: "static" } } },
    { id: "beat-chasing-utilisation", points: 8, when: { beats_baseline: { policy: "fill-the-line" } } },
    { id: "beat-textbook-operations", points: 12, when: { beats_baseline: { policy: "reorder-point" } } },
    // Sixteen days is two meetings: one to notice, one for word to reach
    // somebody who can act. A team that takes longer than that has not so much
    // reacted slowly as failed to route the news at all.
    { id: "reacted-to-the-collapse", points: 6, when: { responds_within: { event: "demand_shock", days: 16 } } },
    {
      id: "routed-the-collapse-to-someone-who-could-act",
      points: 8,
      when: { responds_within: { event: "demand_shock", days: 16, crossingRoles: true } },
    },
  ],

  expect: [
    // The floor, and the only hard bar: an organisation of six models that ends
    // up worse off than prices and orders drawn from a hat has subtracted value
    // by existing. Everything above this is partial credit, because a scenario
    // with an objective and no correct answer should report where a team landed
    // rather than whether it cleared one line.
    { beats_baseline: { policy: "random" } },
    { sim_metric: { metric: "bankrupt", at_most: 0 } },
    { posts_by: { agent: "sales", min: 1 } },
    { posts_by: { agent: "operations", min: 1 } },
  ],
});
