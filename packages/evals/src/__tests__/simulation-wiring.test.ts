/**
 * Does the simulation seam actually reach the agents, and does the clock tick?
 *
 * The economy has its own tests (`factory-sim.test.ts`) and they say nothing
 * about whether an agent can drive it. Everything here is the seam between the
 * two, which is where this package keeps paying: a tool that never reaches the
 * request, an allowlist that hands sales the maintenance instruments, a clock
 * that advances per turn instead of per round. Each would fail looking like a
 * model that played badly.
 *
 * The model is a scripted HTTP endpoint, so this is deterministic, needs no GPU,
 * and cannot be satisfied by a model that happened to behave.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConfig, type HarnessOptions, runOnce, simulationGrants } from "../harness.js";
import { loadScenarios } from "../schema.js";
import { FactorySimulation } from "../sim/factory/index.js";
import { summariseResponses, traceResponses } from "../sim/latency.js";
import type { Scenario } from "../types.js";

type Turn = { toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string };

let server: Server;
let baseUrl: string;
let seen: Array<{ tools: string[] }> = [];
let fallback: Turn = { content: "Noted." };

beforeEach(async () => {
  seen = [];
  fallback = { content: "Noted." };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
      seen.push({ tools: (parsed.tools ?? []).map((t) => t.function?.name ?? "?") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: fallback.content ?? null, tool_calls: undefined },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function options(): HarnessOptions {
  return {
    baseUrl,
    model: "scripted",
    apiKey: "unused",
    temperature: 0,
    maxTokens: 256,
    maxToolRounds: 2,
    providerExtra: {},
    seed: 7,
    timeoutMs: 15_000,
    pinnedAt: null,
  };
}

const scenario = (over: Partial<Scenario> = {}): Scenario =>
  ({
    id: "sim",
    category: "simulation",
    intent: "wiring",
    difficulty: 10,
    agent: { name: "sales", description: "Sales." },
    config: { agents: { operations: { description: "Operations." } } },
    simulation: {
      name: "factory",
      days: 6,
      daysPerRound: 2,
      roles: { sales: "sales", operations: "operations" },
    },
    rooms: [{ name: "plant", members: ["sales", "operations"], deliver: "poll", wakeOn: "all" }],
    wake: { room: "plant", rounds: 3, agents: ["sales", "operations"] },
    expect: [{ replies: true }],
    ...over,
  }) as Scenario;

describe("who holds which instruments", () => {
  it("gives each role its own tools and the shared ones, and nobody else's", () => {
    const sim = new FactorySimulation({ seed: 1 });
    const grants = simulationGrants(sim, { sales: "sales", maintenance: "maintenance" });

    expect(grants.sales).toContain("set_price");
    expect(grants.sales).toContain("get_day"); // shared
    expect(grants.sales).not.toContain("schedule_maintenance");
    expect(grants.maintenance).toContain("schedule_maintenance");
    expect(grants.maintenance).not.toContain("set_price");
  });

  it("refuses a role the simulation does not have, rather than granting nothing", () => {
    // Silent is the dangerous outcome here: an agent with an empty grant takes
    // its turn, reads nothing, acts on nothing, and reads in the report as a
    // manager that chose to sit on its hands.
    const sim = new FactorySimulation({ seed: 1 });
    expect(() => simulationGrants(sim, { marketing: "sales" })).toThrow(/no role "marketing"/);
  });

  it("writes the grants into each agent's allowlist, plus `room`", () => {
    const sim = new FactorySimulation({ seed: 1 });
    const config = buildConfig(scenario(), options(), sim);
    const agents = config.agents as Record<string, { tools?: string[] }>;

    expect(agents.sales.tools).toContain("set_price");
    expect(agents.sales.tools).toContain("room");
    expect(agents.sales.tools).not.toContain("set_production_plan");
    expect(agents.operations.tools).toContain("set_production_plan");
    expect(agents.operations.tools).not.toContain("set_price");
  });
});

describe("a simulation run", () => {
  it("puts the role's instruments in the request and withholds the others", async () => {
    await runOnce(scenario(), options());
    const offered = new Set(seen.flatMap((s) => s.tools));
    expect(offered).toContain("set_price");
    expect(offered).toContain("set_production_plan");
    // Nobody in this scenario holds maintenance, so it must reach no request at
    // all — a tool built for a role nobody plays is still a tool the model sees.
    expect(offered).not.toContain("schedule_maintenance");
  });

  it("advances the clock once per round, not once per turn", async () => {
    // Two agents and three rounds at two days a round. Per-turn would reach day
    // 6 in the same number of turns and look identical in every other respect,
    // which is exactly why it needs its own check: the managers in one round
    // must all decide on the same day's numbers.
    const outcome = await runOnce(scenario(), options());
    expect(outcome.simulation?.dayOfTurn).toEqual([0, 0, 2, 2, 4, 4]);
    expect(outcome.simulation?.daysPerRound).toBe(2);
  });

  it("runs the company on to the horizon after the team stops", async () => {
    // Three rounds of two days manage six of ten, and the rest runs under the
    // team's last decisions. Truncating instead would score a team that went
    // quiet on a shorter horizon than the baseline it is compared against, which
    // flatters exactly the behaviour that should cost something.
    const outcome = await runOnce(scenario({ simulation: { ...scenario().simulation, days: 10 } as never }), options());
    expect(outcome.simulation?.days).toBe(10);
    expect(outcome.simulation?.daysManaged).toBe(5);
    expect(outcome.simulation?.metrics.daysCompleted).toBe(10);
  });

  it("does not credit the day marker's lines to the team", async () => {
    // The clock posts once a round so a quiet room still wakes somebody. Those
    // lines sit above the same watermark the agents' posts do, so leaving them
    // in would inflate `posts_by` and put sentences into the joined reply that
    // no agent wrote.
    const outcome = await runOnce(scenario(), options());
    expect(outcome.posts.every((p) => p.agent !== "plant-clock")).toBe(true);
    expect(outcome.reply).not.toContain("Overnight the factory ran");
  });
});

describe("organisational latency", () => {
  const events = [{ day: 4, kind: "demand_shock", message: "a customer left", visibleTo: ["sales"] }];
  const responses = { demand_shock: ["set_production_plan"] };
  const roles = { sales: "sales", operations: "operations" };

  it("ignores an action taken before the event", () => {
    const rows = traceResponses({
      events,
      responses,
      executions: [{ name: "set_production_plan", args: {}, agent: "operations", turn: 0 }],
      dayOfTurn: [0, 4],
      roles,
    });
    expect(rows[0].latencyDays).toBeNull();
  });

  it("measures the delay in days and says who acted", () => {
    const rows = traceResponses({
      events,
      responses,
      executions: [{ name: "set_production_plan", args: {}, agent: "operations", turn: 1 }],
      dayOfTurn: [0, 6],
      roles,
    });
    expect(rows[0].latencyDays).toBe(2);
    expect(rows[0].respondedBy).toBe("operations");
    // The whole point: the function that could see it is not the one that fixed
    // it, so this event was routed rather than merely noticed.
    expect(rows[0].crossedRoles).toBe(true);
  });

  it("marks a response from the function that could already see it", () => {
    const rows = traceResponses({
      events,
      responses: { demand_shock: ["set_price"] },
      executions: [{ name: "set_price", args: {}, agent: "sales", turn: 1 }],
      dayOfTurn: [0, 6],
      roles,
    });
    expect(rows[0].crossedRoles).toBe(false);
    expect(summariseResponses(rows).crossRole).toBe(0);
  });

  it("traces nothing for an event the simulation says nothing about", () => {
    // Rather than treating any later call as a response, which would report a
    // latency of zero for everything and read as a perfect score.
    const rows = traceResponses({ events, responses: {}, executions: [], dayOfTurn: [], roles });
    expect(rows).toHaveLength(0);
  });
});

describe("loading a scenario written in TypeScript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-eval-ts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a module's default export alongside the YAML files", async () => {
    writeFileSync(
      join(dir, "a.yaml"),
      "- id: from-yaml\n  category: c\n  difficulty: 1\n  intent: i\n  message: m\n  expect:\n    - replies: true\n",
    );
    writeFileSync(
      join(dir, "b.ts"),
      `export default { id: "from-ts", category: "c", difficulty: 1, intent: "i", message: "m", expect: [{ replies: true }] };\n`,
    );
    const { scenarios, sources } = await loadScenarios(dir);
    expect(scenarios.map((s) => s.id).sort()).toEqual(["from-ts", "from-yaml"]);
    // The source path is what carries a module's side effects — a scenario file
    // registering its own simulation — across the worker process boundary.
    expect(sources["from-ts"]).toBe(join(dir, "b.ts"));
  });

  it("holds a TypeScript scenario to the same schema as a YAML one", async () => {
    writeFileSync(join(dir, "bad.ts"), `export default { id: "x", category: "c", difficulty: 1, intent: "i" };\n`);
    await expect(loadScenarios(dir)).rejects.toThrow(/expect/);
  });

  it("rejects a file that exports nothing, rather than loading no scenarios", async () => {
    writeFileSync(join(dir, "empty.ts"), `export const unrelated = 1;\n`);
    await expect(loadScenarios(dir)).rejects.toThrow(/exports no scenarios/);
  });
});
