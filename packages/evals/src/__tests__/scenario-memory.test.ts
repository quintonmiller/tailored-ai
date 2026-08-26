/**
 * Seeding what an agent is supposed to already know.
 *
 * Until this existed the benchmark could not express it. `history:` seeds a
 * conversation, `toolResults:` seeds tool output and `world:` seeds simulation
 * state; nothing seeded memory. Every run built its home with `mkdtempSync` and
 * never wrote a note, so `injectMemory` — which no run set anyway — would have
 * injected an empty corpus, and the three arms of #542 would all have scored
 * the cost of an empty query rather than the value of a memory. That result
 * would have looked like a clean null and meant nothing.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, DEFAULT_BASE_URL, type HarnessOptions, memoryNoteInput } from "../harness.js";
import { loadScenarios } from "../schema.js";
import { substituteTokens } from "../tokens.js";
import type { Scenario } from "../types.js";

const OPTS: HarnessOptions = {
  baseUrl: DEFAULT_BASE_URL,
  model: "test-model",
  apiKey: "unused",
  temperature: 0.3,
  maxTokens: 2048,
  maxToolRounds: 6,
  providerExtra: {},
  seed: null,
  timeoutMs: 1000,
};

const base: Scenario = {
  id: "s",
  category: "memory",
  intent: "x",
  difficulty: 1,
  message: "hello",
};

function inDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-mem-"));
  writeFileSync(join(dir, "s.yaml"), yaml);
  return dir;
}

describe("scenario memory seeding", () => {
  it("reads a bare string as a plain note", () => {
    expect(memoryNoteInput("the deploy key is abc")).toEqual({ content: "the deploy key is abc" });
  });

  it("turns pinned into the tag listPinnedNotes looks for", () => {
    // Not a cosmetic difference: a pinned note is injected regardless of
    // relevance, which is what lets a scenario stop depending on the recall
    // ranker agreeing that its note matters.
    expect(memoryNoteInput({ content: "sign off with OK", pinned: true })).toEqual({
      content: "sign off with OK",
      tags: ["pinned"],
    });
  });

  it("keeps declared tags alongside pinned", () => {
    expect(memoryNoteInput({ content: "c", tags: ["ops"], pinned: true })).toMatchObject({
      tags: ["ops", "pinned"],
    });
  });

  it("leaves a note unowned unless the seed names an agent", () => {
    // Unowned notes are visible to every agent — `listPinnedNotes` matches
    // `agent = ? OR agent IS NULL` — which is what a scenario means by "the
    // agent knows this", and what a room scenario with two agents needs.
    expect(memoryNoteInput("c")).not.toHaveProperty("agent");
    expect(memoryNoteInput({ content: "c", agent: "nova" })).toMatchObject({ agent: "nova" });
  });

  it("passes importance through, so a scenario can reach the pinned tier by score", () => {
    expect(memoryNoteInput({ content: "c", importance: 0.96 })).toMatchObject({ importance: 0.96 });
  });
});

describe("memory: in the schema", () => {
  it("accepts both the bare and the object form", async () => {
    const dir = inDir(`
- id: seeded
  category: memory
  intent: x
  difficulty: 1
  message: hi
  memory:
    - "a plain note"
    - { content: "a pinned one", pinned: true, tags: [ops], importance: 0.99 }
  expect:
    - replies: true
`);
    const { scenarios } = await loadScenarios(dir);
    expect(scenarios[0].memory).toEqual([
      "a plain note",
      { content: "a pinned one", pinned: true, tags: ["ops"], importance: 0.99 },
    ]);
  });

  it("rejects an empty note", async () => {
    const dir = inDir(`
- id: seeded
  category: memory
  intent: x
  difficulty: 1
  message: hi
  memory: [""]
  expect:
    - replies: true
`);
    await expect(loadScenarios(dir)).rejects.toThrow();
  });

  it("rejects a field the seed does not define", async () => {
    const dir = inDir(`
- id: seeded
  category: memory
  intent: x
  difficulty: 1
  message: hi
  memory:
    - { content: "c", ttl: "tomorrow" }
  expect:
    - replies: true
`);
    await expect(loadScenarios(dir)).rejects.toThrow();
  });

  it("substitutes witnesses into seeded memory", () => {
    // The whole point of seeding with a witness: the fact exists only here, so
    // a reply containing it proves retrieval rather than confabulation. If
    // substitution skipped this field the scenario would seed the literal
    // placeholder and could never pass.
    const scenario: Scenario = {
      ...base,
      tokens: ["key"],
      memory: ["the deploy key is {{token:key}}", { content: "also {{token:key}}", pinned: true }],
    };
    const out = substituteTokens(scenario, { key: "ZX41QP" });
    expect(out.memory?.[0]).toBe("the deploy key is ZX41QP");
    expect(out.memory?.[1]).toMatchObject({ content: "also ZX41QP" });
  });
});

describe("the injection arm", () => {
  it("leaves core's default alone when the flag is not passed", () => {
    // Not a no-op worth skipping: writing `false` here would look identical in
    // the config and would make every historical run's arm unrecoverable.
    const config = buildConfig({ ...base, agent: { name: "nova" } }, OPTS);
    const agent = (config.agents as Record<string, Record<string, unknown>>).nova;
    expect(agent).not.toHaveProperty("injectMemory");
  });

  it("sets injectMemory on the agent when the flag is passed", () => {
    const config = buildConfig({ ...base, agent: { name: "nova" } }, { ...OPTS, injectMemory: true });
    const agent = (config.agents as Record<string, Record<string, unknown>>).nova;
    expect(agent.injectMemory).toBe(true);
  });

  it("lets a scenario's own agent.extra win, so one scenario can pin its arm", () => {
    const scenario: Scenario = { ...base, agent: { name: "nova", extra: { injectMemory: false } } };
    const config = buildConfig(scenario, { ...OPTS, injectMemory: true });
    const agent = (config.agents as Record<string, Record<string, unknown>>).nova;
    expect(agent.injectMemory).toBe(false);
  });
});

describe("the shipped memory scenarios", () => {
  it("parse, and seed a corpus", async () => {
    const { scenarios } = await loadScenarios(join(import.meta.dirname, "..", "..", "scenarios"));
    const seeded = scenarios.filter((s) => s.memory?.length);
    expect(seeded.length).toBeGreaterThan(0);
    for (const s of seeded)
      expect(s.memory?.every((m) => (typeof m === "string" ? m : m.content).length > 0)).toBe(true);
  });
});
