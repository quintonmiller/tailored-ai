/**
 * The scenario surface that makes a multi-agent turn expressible.
 *
 * Before this, `wake:` named one room and the runner took one turn for one
 * agent — so 57 of 59 scenarios declared no second agent, and the two that did
 * used it as scenery. None of the machinery rooms exist for (the wake queue,
 * pass handling, `maxWakesPerHour`, per-room chaining) had a scenario, because
 * one agent answering once structurally cannot produce a cascade, a silence
 * where everybody deferred, or a handoff.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grade } from "../graders.js";
import { loadScenarios } from "../schema.js";
import type { RunOutcome, Scenario } from "../types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coord-schema-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write one scenario file and load it, so the zod schema is what is under test. */
function load(body: string): Scenario[] {
  writeFileSync(join(dir, "s.yaml"), body);
  return loadScenarios(dir).scenarios;
}

const ROOMS = `
  rooms:
    - name: ops
      incoming:
        - { speaker: quinton, to: [nova], body: "ping" }`;

describe("wake as a sequence", () => {
  it("takes a list of turns", () => {
    const [scenario] = load(`
- id: two-turns
  category: coordination
  difficulty: 3
  intent: two agents
${ROOMS}
  wake:
    - { room: ops, agent: nova }
    - { room: ops, agent: dana }
  expect:
    - replies: true
`);

    expect(scenario.wake).toEqual([
      { room: "ops", agent: "nova" },
      { room: "ops", agent: "dana" },
    ]);
  });

  it("still takes a bare object, so every existing scenario is untouched", () => {
    const [scenario] = load(`
- id: one-turn
  category: addressing
  difficulty: 3
  intent: one agent
${ROOMS}
  wake: { room: ops }
  expect:
    - replies: true
`);

    expect(scenario.wake).toEqual({ room: "ops" });
  });

  it("rejects a step naming a room that does not exist — in any position", () => {
    // The single-wake version checked this. A list that only validated its
    // first entry would let a typo in the second silently wake nobody.
    expect(() =>
      load(`
- id: bad-second-step
  category: coordination
  difficulty: 3
  intent: typo in the second step
${ROOMS}
  wake:
    - { room: ops, agent: nova }
    - { room: opss, agent: dana }
  expect:
    - replies: true
`),
    ).toThrow(/wake\.room "opss" is not one of the rooms/);
  });

  it("rejects an empty list rather than silently waking nobody", () => {
    expect(() =>
      load(`
- id: empty-wake
  category: coordination
  difficulty: 3
  intent: nothing runs
${ROOMS}
  wake: []
  expect:
    - replies: true
`),
    ).toThrow();
  });
});

function outcome(posts: Array<{ room: string; body: string; agent?: string }>): RunOutcome {
  return {
    reply: posts.map((p) => p.body).join("\n"),
    posts,
    calls: [],
    requests: [],
    usage: { input: 0, output: 0 },
    latencyMs: 0,
  } as unknown as RunOutcome;
}

function scenario(expect_: Scenario["expect"]): Scenario {
  return { id: "s", category: "coordination", difficulty: 3, intent: "i", expect: expect_ } as Scenario;
}

async function passes(assertion: Scenario["expect"][number], out: RunOutcome): Promise<boolean> {
  const checks = await grade(scenario([assertion]), out);
  return checks.every((c) => c.pass);
}

describe("posts_by", () => {
  const conversation = outcome([
    { room: "ops", body: "deploy finished", agent: "nova" },
    { room: "ops", body: "and the icons shipped", agent: "dana" },
    { room: "ops", body: "one more thing", agent: "dana" },
  ]);

  it("asks whether a named agent spoke at all, defaulting to at least once", async () => {
    expect(await passes({ posts_by: { agent: "nova" } }, conversation)).toBe(true);
    expect(await passes({ posts_by: { agent: "ravi" } }, conversation)).toBe(false);
  });

  it("catches the echo — an agent that should have stayed out", async () => {
    // The question `posts_in` cannot ask: "somebody posted in ops" is true
    // whether the handoff worked or the second agent parroted the first.
    expect(await passes({ posts_by: { agent: "dana", max: 0 } }, conversation)).toBe(false);
    expect(await passes({ posts_by: { agent: "ravi", max: 0 } }, conversation)).toBe(true);
  });

  it("counts posts, not agents, so one agent speaking twice is two", async () => {
    expect(await passes({ posts_by: { agent: "dana", max: 1 } }, conversation)).toBe(false);
    expect(await passes({ posts_by: { agent: "dana", max: 2 } }, conversation)).toBe(true);
  });

  it("names who did speak when it fails, so the failure is diagnosable", async () => {
    const checks = await grade(scenario([{ posts_by: { agent: "ravi" } }]), conversation);

    expect(checks[0].detail).toContain("nova×1");
    expect(checks[0].detail).toContain("dana×2");
  });

  it("asks what a named agent said, which counting cannot", async () => {
    // The handoff question. `reply_matches` is useless here: `reply` is every
    // post joined, so /41207/ passes the moment nova says it — whether or not
    // dana, the agent whose turn is under test, ever used it.
    expect(await passes({ posts_by: { agent: "dana", matches: "icons" } }, conversation)).toBe(true);
    expect(await passes({ posts_by: { agent: "dana", matches: "deploy" } }, conversation)).toBe(false);
    expect(await passes({ posts_by: { agent: "nova", matches: "deploy" } }, conversation)).toBe(true);
  });

  it("says what the agent did say when nothing matched, so a near miss is legible", async () => {
    const checks = await grade(scenario([{ posts_by: { agent: "nova", matches: "rollback" } }]), conversation);

    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain("deploy finished");
  });

  it("reports nobody rather than an empty list on a silent room", async () => {
    const checks = await grade(scenario([{ posts_by: { agent: "nova" } }]), outcome([]));

    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toContain("nobody posted");
  });
});

describe("a stub the agent cannot reach", () => {
  it("rejects toolResults for a tool outside the agent's allowlist", () => {
    // Four scenarios were written this way in one afternoon, usually by reusing
    // an `&anchor` whose `tools:` is narrower than the new row needs. Each
    // failed looking exactly like a model limitation — the agent correctly said
    // it had no way to check — and each cost a benchmark run to diagnose.
    expect(() =>
      load(`
- id: unreachable-stub
  category: tool-pressure
  difficulty: 3
  intent: asks for a lookup it cannot do
  agent:
    name: nova
    tools: [room]
  toolResults:
    exec: "queue depth: 41207"
  message: how deep is the queue?
  expect:
    - replies: true
`),
    ).toThrow(/no agent in this scenario can call/);
  });

  it("looks at every agent's allowlist, not just the one under test", () => {
    // A lead that can only talk directs specialists who can act, so the stub a
    // multi-agent scenario needs is almost never on the agent under test.
    // Reading its allowlist alone rejected exactly the scenarios worth writing.
    const [scenario] = load(`
- id: peer-holds-the-stub
  category: orchestration
  difficulty: 8
  intent: the lead cannot act, the specialist can
  agent:
    name: lead
    tools: [room]
  config:
    agents:
      rus:
        tools: [room, exec]
  toolResults:
    exec: "queue depth: 41207"
  rooms:
    - name: ops
      incoming:
        - { speaker: quinton, body: "how deep is the queue?" }
  wake:
    - { room: ops, agent: lead }
    - { room: ops, agent: rus }
  expect:
    - replies: true
`);
    expect(scenario.id).toBe("peer-holds-the-stub");
  });

  it("allows a stub when the agent lists the tool", () => {
    const [scenario] = load(`
- id: reachable-stub
  category: tool-pressure
  difficulty: 3
  intent: asks for a lookup it can do
  agent:
    name: nova
    tools: [room, exec]
  toolResults:
    exec: "queue depth: 41207"
  message: how deep is the queue?
  expect:
    - replies: true
`);
    expect(scenario.toolResults?.exec).toContain("41207");
  });

  it("allows a stub when the agent has no allowlist, because then it has everything", () => {
    const [scenario] = load(`
- id: no-allowlist
  category: tool-pressure
  difficulty: 3
  intent: the fixture's whole tool set
  agent:
    name: nova
  toolResults:
    exec: "queue depth: 41207"
  message: how deep is the queue?
  expect:
    - replies: true
`);
    expect(scenario.agent?.tools).toBeUndefined();
  });
});
