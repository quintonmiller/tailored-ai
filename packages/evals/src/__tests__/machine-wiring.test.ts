/**
 * Do scenario-declared tools reach the model, and does a `rounds:` wake stop?
 *
 * Both are seams between two pieces that are individually correct, which is the
 * class of bug this package keeps paying for: a `toolResults` stub for a tool
 * the agent could not reach, a world rule on a tool nobody held, an oracle whose
 * accepted answer was still the literal `{{token:…}}`. Each one failed looking
 * exactly like a model limit, and each cost a benchmark run to diagnose. The
 * schema now rejects those three. These are the same class one layer down, where
 * the schema cannot see them:
 *
 *   - a declared instrument that never makes it into the request
 *   - an instrument handed to every agent instead of the one that lists it
 *   - a world rule that does not fire because the tool was not stubbed
 *   - a `rounds:` wake that never stops, or stops before it starts
 *
 * The model is a scripted HTTP endpoint, so this is about plumbing: it is
 * deterministic, needs no GPU, and cannot be satisfied by a model that happened
 * to behave.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HarnessOptions, runOnce, wakeSteps } from "../harness.js";
import type { Scenario } from "../types.js";

type Turn = { toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string };

let server: Server;
let baseUrl: string;
let seen: Array<{ tools: string[] }> = [];
let script: Turn[] = [];
/** What every unscripted call returns. `""` makes a turn produce nothing at all. */
let fallback: Turn = { content: "Done." };

beforeEach(async () => {
  seen = [];
  script = [];
  fallback = { content: "Done." };
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
      seen.push({ tools: (parsed.tools ?? []).map((t) => t.function?.name ?? "?") });
      const turn = script[seen.length - 1] ?? fallback;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: turn.content ?? null,
                tool_calls: turn.toolCalls?.map((c, i) => ({
                  id: `call-${seen.length}-${i}`,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
              },
              finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop",
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
    maxToolRounds: 3,
    providerExtra: {},
    seed: 1,
    timeoutMs: 15_000,
    pinnedAt: null,
  };
}

describe("scenario-declared tools", () => {
  const withInstrument = (over: Partial<Scenario> = {}): Scenario =>
    ({
      id: "instrument",
      category: "orchestration",
      intent: "wiring",
      difficulty: 8,
      agent: { name: "atlas", instructions: "You are Atlas.", tools: ["rotate_ring"] },
      tools: [
        {
          name: "rotate_ring",
          description: "Rotate an observatory ring to a position.",
          params: { ring: "which ring", position: "the glyph to point at" },
        },
      ],
      message: "align the rings",
      expect: [{ replies: true }],
      ...over,
    }) as Scenario;

  it("puts the instrument in front of the model", async () => {
    script = [{ content: "nothing to do" }];
    await runOnce(withInstrument(), options());

    expect(seen[0].tools).toContain("rotate_ring");
  });

  it("stubs it, so a world rule on it actually fires", async () => {
    // The failure this rules out: a scenario tool that fell through to a real
    // `execute` would return the placeholder and the world would never move, so
    // the machinery would report "touched nothing" on a run that called it.
    script = [{ toolCalls: [{ name: "rotate_ring", arguments: { ring: "1", position: "V" } }] }, { content: "ok" }];
    const outcome = await runOnce(
      withInstrument({
        world: {
          state: { alignment: "off" },
          rules: [
            {
              tool: "rotate_ring",
              when: { position: "V" },
              then: "HARMONIC LOCK ESTABLISHED",
              sets: { alignment: "locked" },
            },
          ],
          goal: { alignment: "locked" },
        },
        expect: [{ world_state: "goal" }],
      }),
      options(),
    );

    expect(outcome.world).toEqual({ alignment: "locked" });
    expect(outcome.executions?.[0].result).toContain("HARMONIC LOCK");
  });

  it("stays behind the allowlist, so one agent's instrument is not everyone's", async () => {
    // The whole reason a specialist is a specialist. Handing every tool to every
    // agent turns an orchestration scenario into six agents who can each solve
    // it alone, which is the failure mode `by:` exists to prevent one layer up.
    script = [{ content: "hello" }];
    await runOnce(
      withInstrument({ agent: { name: "atlas", instructions: "You are Atlas.", tools: ["exec"] } }),
      options(),
    );

    expect(seen[0].tools).not.toContain("rotate_ring");
  });

  it("records what the tool said, which is where a fact enters the run", async () => {
    // Both parameters, because the loop validates a call against the schema and
    // drops one that is missing a required argument — which is the right
    // behaviour and would otherwise look like the tool never ran.
    script = [{ toolCalls: [{ name: "rotate_ring", arguments: { ring: "2", position: "⋔" } }] }, { content: "ok" }];
    const outcome = await runOnce(
      withInstrument({ toolResults: { rotate_ring: "ring 2 now points at ⋔" } }),
      options(),
    );

    expect(outcome.executions?.[0]).toMatchObject({ name: "rotate_ring", result: "ring 2 now points at ⋔" });
  });
});

describe("a roster taking turns", () => {
  const roster = (over: Partial<Scenario> = {}): Scenario =>
    ({
      id: "rounds",
      category: "orchestration",
      intent: "wiring",
      difficulty: 8,
      agent: { name: "atlas", instructions: "You are Atlas.", tools: ["room"] },
      config: { agents: { boron: { description: "Reactor.", instructions: "You are Boron.", tools: ["room"] } } },
      rooms: [{ name: "expedition", incoming: [{ speaker: "quinton", body: "activate the machine" }] }],
      wake: { room: "expedition", rounds: 3, agents: ["atlas", "boron"] },
      expect: [{ replies: true }],
      ...over,
    }) as Scenario;

  it("expands to rounds × agents, in order", () => {
    const steps = wakeSteps(roster(), "atlas");
    expect(steps.map((s) => `${s.round}:${s.agent}`)).toEqual([
      "0:atlas",
      "0:boron",
      "1:atlas",
      "1:boron",
      "2:atlas",
      "2:boron",
    ]);
  });

  it("runs every round while the team keeps talking", async () => {
    const outcome = await runOnce(roster(), options());
    expect(outcome.error).toBeUndefined();
    expect(outcome.turns).toHaveLength(6);
  });

  it("stops after a round in which nothing happened", async () => {
    // The cheapest possible evidence a team has finished or jammed. Without it a
    // generous `rounds:` is paid for in full on every run, and `rounds:` has to
    // be generous — guessing low makes the wake list part of the measurement.
    fallback = { content: "" };
    const outcome = await runOnce(roster(), options());

    expect(outcome.turns).toHaveLength(2);
    expect(outcome.posts).toHaveLength(0);
  });

  it("keeps going through a quiet round when the scenario says to", async () => {
    fallback = { content: "" };
    const outcome = await runOnce(
      roster({ wake: { room: "expedition", rounds: 3, agents: ["atlas", "boron"], noQuiescence: true } }),
      options(),
    );

    expect(outcome.turns).toHaveLength(6);
  });

  it("counts a refused world transition as activity, not as silence", async () => {
    // A team hammering a locked door is stuck, not finished, and cutting the run
    // short there would report "quiescent" for the state most worth watching.
    fallback = { content: "" };
    script = [
      { toolCalls: [{ name: "exec", arguments: { command: "open hatch" } }] },
      { content: "" },
      { content: "" },
      { toolCalls: [{ name: "exec", arguments: { command: "open hatch" } }] },
      { content: "" },
    ];
    const outcome = await runOnce(
      roster({
        agent: { name: "atlas", instructions: "You are Atlas.", tools: ["room", "exec"] },
        config: { agents: { boron: { description: "Reactor.", instructions: "You are Boron.", tools: ["room"] } } },
        world: {
          state: { power: "off", hatch: "locked" },
          rules: [
            {
              tool: "exec",
              when: { command: "/hatch/" },
              requires: { power: "on" },
              then: "open",
              else: "the panel is dead",
              sets: { hatch: "open" },
            },
          ],
          goal: { hatch: "open" },
        },
        expect: [{ world_state: "goal" }],
      }),
      options(),
    );

    // Round 0 was silent in the room but touched the machinery, so round 1 ran.
    expect(outcome.worldLog?.length).toBeGreaterThan(0);
    expect(outcome.turns?.length).toBeGreaterThan(2);
  });

  it("subscribes only a room's declared members, so a fact has to be relayed", async () => {
    // One room holding everybody turns routing into broadcasting: "get this to
    // the agent who needs it" collapses into "say it out loud", and a team can
    // look like it is routing while doing nothing of the kind. Two rooms with
    // different membership is what makes a relay necessary.
    script = [{ content: "atlas speaking" }, { content: "boron speaking" }];
    fallback = { content: "" };
    const outcome = await runOnce(
      roster({
        rooms: [
          { name: "north", members: ["atlas"], incoming: [{ speaker: "quinton", body: "start" }] },
          // Its own `incoming`, because a poll delivers what is unread and an
          // agent alone in a quiet room never wakes at all. That is correct
          // behaviour and a trap for anyone splitting a roster across rooms:
          // the second room needs something to wake on, or its occupant is
          // silent for a reason that has nothing to do with the model.
          { name: "south", members: ["boron"], incoming: [{ speaker: "quinton", body: "start" }] },
        ],
        wake: [
          { room: "north", agent: "atlas" },
          { room: "south", agent: "boron" },
        ],
      }),
      options(),
    );

    expect(outcome.error).toBeUndefined();
    // Boron's turn ran in a room Atlas cannot see, and vice versa. Whatever each
    // said stayed where it was said.
    expect(outcome.posts.map((p) => [p.agent, p.room])).toEqual([
      ["atlas", "north"],
      ["boron", "south"],
    ]);
  });

  it("stamps posts and executions with the turn that produced them", async () => {
    // The only clock a multi-agent run has. Without it "did Boron act on what
    // Atlas said, or before it" is not answerable, and fact routing is the
    // question that needs the answer.
    script = [{ content: "atlas here" }, { content: "boron here" }];
    fallback = { content: "" };
    const outcome = await runOnce(roster(), options());

    expect(outcome.posts.map((p) => [p.agent, p.turn])).toEqual([
      ["atlas", 0],
      ["boron", 1],
    ]);
    // Four turns, not two: round 0 spoke, so round 1 ran; round 1 was silent, so
    // round 2 was skipped. The roster is the ceiling and the transcript is what
    // happened, which is exactly why `turns` is recorded rather than derived.
    expect(outcome.turns).toEqual([
      { agent: "atlas", room: "expedition" },
      { agent: "boron", room: "expedition" },
      { agent: "atlas", room: "expedition" },
      { agent: "boron", room: "expedition" },
    ]);
  });
});
