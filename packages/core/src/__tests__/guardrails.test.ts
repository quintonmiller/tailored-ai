/**
 * Guardrails: a mechanical check an agent's outgoing message has to pass.
 *
 * Three of these tests exist because of a specific way this feature could be
 * useless rather than wrong:
 *
 * - `resolveAgent` has to actually surface the specs. A config key that parses
 *   and is never read is the failure this repo produces more than any other,
 *   and a guardrail that is declared and never consulted looks exactly like
 *   one that is passing.
 * - A `/g` regex keeps `lastIndex` between calls, so the same rule checked
 *   against a second message starts counting from where the first one stopped.
 * - A guardrail that throws must not silence the agent. It fails open, on
 *   purpose, and that is worth pinning down because it is the opposite of what
 *   hooks do.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import type { AgentConfig } from "../config.js";
import { checkGuardrails, resetGuardrailCache } from "../guardrails/check.js";
import { guardrailRegistry, registerGuardrail } from "../guardrails/registry.js";
import type { GuardrailSpec } from "../guardrails/types.js";

const ctx = { agent: "player-marine", surface: "room", destination: "local:table" };
const text = (options: Record<string, unknown>): GuardrailSpec[] => [{ use: "text", options }];

beforeEach(() => resetGuardrailCache());

describe("the built-in text guardrail", () => {
  it("is registered by core", () => {
    expect(guardrailRegistry.has("text")).toBe(true);
  });

  it("passes a message inside the limits", async () => {
    expect(await checkGuardrails(text({ maxChars: 100 }), "Rolling. A two.", ctx)).toBeUndefined();
  });

  it("refuses one over the character limit, and says both numbers", async () => {
    const reason = await checkGuardrails(text({ maxChars: 20 }), "x".repeat(50), ctx);
    expect(reason).toMatch(/50 characters/);
    expect(reason).toMatch(/limit here is 20/);
  });

  it("counts words separately from characters", async () => {
    expect(await checkGuardrails(text({ maxWords: 3 }), "one two three", ctx)).toBeUndefined();
    expect(await checkGuardrails(text({ maxWords: 3 }), "one two three four", ctx)).toMatch(/4 words/);
  });

  it("denies a pattern outright", async () => {
    const specs = text({ deny: ["\\blet me think\\b"] });
    expect(await checkGuardrails(specs, "Korran steps to the rail.", ctx)).toBeUndefined();
    expect(await checkGuardrails(specs, "Actually let me think about what he'd do.", ctx)).toMatch(
      /not supposed to write/,
    );
  });

  it("allows a pattern up to a limit", async () => {
    const specs = text({ limit: [{ pattern: "—", max: 1 }] });
    expect(await checkGuardrails(specs, "He waits — and listens.", ctx)).toBeUndefined();
    expect(await checkGuardrails(specs, "He waits — listens — moves.", ctx)).toMatch(/2 times/);
  });

  it("counts a limited pattern from scratch every time", async () => {
    // A /g regex remembers lastIndex. Reusing one across messages made the
    // second check start from wherever the first stopped, so a message that
    // broke the rule could pass because an earlier one had already "used up"
    // the pattern.
    const specs = text({ limit: [{ pattern: "—", max: 1 }] });
    await checkGuardrails(specs, "a — b — c", ctx);
    expect(await checkGuardrails(specs, "a — b — c", ctx)).toMatch(/2 times/);
  });

  it("only applies when `when` matches, so one rule can be about one kind of message", async () => {
    const specs = text({ when: "\\[ROLL\\]", maxChars: 40 });
    const long = "x".repeat(200);
    expect(await checkGuardrails(specs, long, ctx)).toBeUndefined();
    expect(await checkGuardrails(specs, `[ROLL] ${long}`, ctx)).toMatch(/limit here is 40/);
  });

  it("ignores a pattern that will not compile instead of refusing every message", async () => {
    const specs = text({ deny: ["([unclosed"] });
    expect(await checkGuardrails(specs, "anything at all", ctx)).toBeUndefined();
  });

  it("ignores an empty message", async () => {
    expect(await checkGuardrails(text({ maxChars: 1 }), "   ", ctx)).toBeUndefined();
  });
});

describe("running an agent's guardrails", () => {
  it("does nothing when none are declared", async () => {
    expect(await checkGuardrails(undefined, "x".repeat(9999), ctx)).toBeUndefined();
    expect(await checkGuardrails([], "x".repeat(9999), ctx)).toBeUndefined();
  });

  it("skips a rule scoped to a different surface", async () => {
    const specs: GuardrailSpec[] = [{ use: "text", surfaces: ["reply"], options: { maxChars: 5 } }];
    expect(await checkGuardrails(specs, "far too long for five", ctx)).toBeUndefined();
    expect(await checkGuardrails(specs, "far too long for five", { ...ctx, surface: "reply" })).toBeDefined();
  });

  it("returns the FIRST failure, so the agent is given one thing to fix", async () => {
    const specs: GuardrailSpec[] = [
      { use: "text", options: { maxChars: 5 } },
      { use: "text", options: { deny: ["hello"] } },
    ];
    expect(await checkGuardrails(specs, "hello there", ctx)).toMatch(/characters/);
  });

  it("fails open when the guardrail id is not registered", async () => {
    expect(await checkGuardrails([{ use: "nothing-registers-this" }], "any message", ctx)).toBeUndefined();
  });

  it("fails open when a guardrail throws", async () => {
    const dispose = registerGuardrail("explodes", () => ({
      id: "explodes",
      check() {
        throw new Error("boom");
      },
    }));
    try {
      expect(await checkGuardrails([{ use: "explodes" }], "any message", ctx)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("fails open when a guardrail's factory throws", async () => {
    const dispose = registerGuardrail("bad-factory", () => {
      throw new Error("bad options");
    });
    try {
      expect(await checkGuardrails([{ use: "bad-factory" }], "any message", ctx)).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("takes an async verdict", async () => {
    const dispose = registerGuardrail("slow", () => ({
      id: "slow",
      async check() {
        return { ok: false as const, reason: "too slow" };
      },
    }));
    try {
      expect(await checkGuardrails([{ use: "slow" }], "any message", ctx)).toBe("too slow");
    } finally {
      dispose();
    }
  });
});

describe("config actually reaches the checker", () => {
  const config = (agents: Record<string, unknown>): AgentConfig =>
    ({
      agent: {
        defaultProvider: "openai",
        extraInstructions: "",
        temperature: 0.3,
        maxToolRounds: 8,
        maxHistoryTokens: 8000,
      },
      providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
      agents,
      tools: {},
    }) as unknown as AgentConfig;

  it("resolveAgent surfaces an agent's own guardrails", () => {
    const specs: GuardrailSpec[] = [{ use: "text", options: { maxChars: 700 } }];
    const resolved = resolveAgent("marine", config({ marine: { instructions: "x", guardrails: specs } }), []);
    expect(resolved.guardrails).toEqual(specs);
  });

  it("an agent without any resolves to undefined rather than inheriting a stray rule", () => {
    const resolved = resolveAgent("plain", config({ plain: { instructions: "x" } }), []);
    expect(resolved.guardrails).toBeUndefined();
  });
});
