/**
 * Prompt caching matches an exact token prefix, so a layer that is rebuilt
 * every turn invalidates everything after it — and the system prompt sits in
 * front of the entire history. `chat_live_state` carries a wall clock and
 * relative ages ("5m ago"), `recall_memory` is keyed on the user's message;
 * both change per turn, so cross-run reuse was approximately zero.
 *
 * The fix is placement, not content: those layers ride behind the history, so
 * the prompt and the history stay a stable prefix and only the tail is fresh.
 * What matters here is that the block still reaches the model exactly once, is
 * genuinely last, and is charged against the same budget it used to occupy.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextSlots, registerContextSlot } from "../agent/context-slots.js";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { DEFAULT_LAYER_ORDER } from "../agent/system-prompt.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function recordingProvider(seen: ChatParams[]): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

/** A custom layer stands in for the built-in volatile ones: same mechanism, no DB fixtures. */
const volatileLayer = {
  order: [...DEFAULT_LAYER_ORDER, "vol"],
  tail: ["vol"],
  custom: [{ name: "vol", content: "VOLATILE-BLOCK" }],
};

function run(seen: ChatParams[], over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider: recordingProvider(seen),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    ...over,
  });
}

describe("runAgentLoop — volatile prompt tail", () => {
  it("sends the tail as the last message, not in the system prompt", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { systemPrompt: volatileLayer });

    const msgs = seen[0].messages;
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).not.toContain("VOLATILE-BLOCK");

    const last = msgs[msgs.length - 1];
    expect(last.content).toContain("VOLATILE-BLOCK");
    // After the user's turn, so the whole history stays a cacheable prefix.
    expect(msgs.findIndex((m) => m.content === "go")).toBeLessThan(msgs.length - 1);
  });

  it("sends the block exactly once", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { systemPrompt: volatileLayer });

    const all = seen[0].messages.map((m) => m.content ?? "").join("\n");
    expect(all.split("VOLATILE-BLOCK")).toHaveLength(2);
  });

  it("labels the tail so the model does not read it as the user talking", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { systemPrompt: volatileLayer });

    const last = seen[0].messages[seen[0].messages.length - 1];
    // Role "user" for the same reason the tool-update notice is: vLLM in
    // strict OpenAI mode rejects mid-history system messages.
    expect(last.role).toBe("user");
    expect(last.content).toContain("[System:");
  });

  it("stays last as the history grows across tool rounds", async () => {
    const seen: ChatParams[] = [];
    let round = 0;
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(params: ChatParams): Promise<ChatResponse> {
        seen.push(params);
        round++;
        if (round === 1) {
          return {
            content: "",
            toolCalls: [{ id: "c1", name: "noop", arguments: {} }],
            usage: { input: 0, output: 0 },
            finishReason: "tool_calls",
          };
        }
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    };
    await run(seen.splice(0), {
      provider,
      systemPrompt: volatileLayer,
      tools: [
        {
          name: "noop",
          description: "does nothing",
          parameters: { type: "object", properties: {} },
          execute: async () => "ok",
        },
      ],
    });

    expect(seen.length).toBeGreaterThan(1);
    for (const call of seen) {
      const last = call.messages[call.messages.length - 1];
      expect(last.content).toContain("VOLATILE-BLOCK");
    }
    // Second round really did grow the history, so "last" is not trivially true.
    expect(seen[1].messages.length).toBeGreaterThan(seen[0].messages.length);
  });

  it("charges the tail against the history budget", async () => {
    // The tail used to sit inside the system prompt and be reserved there.
    // Moving it must not quietly hand that allowance back to the history, or
    // the request grows by exactly the amount that was supposed to be free.
    const big = { ...volatileLayer, custom: [{ name: "vol", content: "x".repeat(8000) }] };

    const survivors = async (tail: string[]) => {
      const session = newSession(db, "fake-model", "fake");
      for (let i = 0; i < 40; i++) {
        saveMessage(db, session.id, { role: "user", content: `filler ${i} ${"y".repeat(400)}` });
      }
      const seen: ChatParams[] = [];
      await runAgentLoop("go", {
        provider: recordingProvider(seen),
        session,
        db,
        tools: [],
        extraInstructions: "",
        maxToolRounds: 2,
        maxHistoryTokens: 6000,
        temperature: 0.3,
        systemPrompt: { ...big, tail },
      });
      return seen[0].messages.filter((m) => m.content?.startsWith("filler ")).length;
    };

    const trimmedAtAll = await survivors([]);
    expect(trimmedAtAll).toBeGreaterThan(0);
    expect(trimmedAtAll).toBeLessThan(40); // the budget really is binding
    expect(await survivors(["vol"])).toBe(trimmedAtAll);
  });

  it("adds no message when nothing is in the tail", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { systemPrompt: { ...volatileLayer, tail: [] } });

    const msgs = seen[0].messages;
    expect(msgs[msgs.length - 1].content).toBe("go");
    expect(msgs[0].content).toContain("VOLATILE-BLOCK");
  });

  it("adds no message on a default config with no live state or recall", async () => {
    const seen: ChatParams[] = [];
    await run(seen);

    const msgs = seen[0].messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe("go");
  });
});

/**
 * The point of the slot registry: a contributor names no layer, sets no order,
 * and its content still lands in the right half of the request.
 */
describe("runAgentLoop — context slots", () => {
  afterEach(() => clearContextSlots());

  it("puts a reload slot in the system prompt, in front of the history", async () => {
    registerContextSlot({ id: "rules", refresh: "reload", render: () => "HOUSE-RULES" });
    const seen: ChatParams[] = [];

    await run(seen);

    expect(seen[0].messages[0].role).toBe("system");
    expect(seen[0].messages[0].content).toContain("HOUSE-RULES");
  });

  it("puts a turn slot behind the history, where the volatile block lives", async () => {
    registerContextSlot({ id: "oncall", refresh: "turn", render: () => "ON-CALL-NOW" });
    const seen: ChatParams[] = [];

    await run(seen);

    const last = seen[0].messages[seen[0].messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("ON-CALL-NOW");
    expect(seen[0].messages[0].content).not.toContain("ON-CALL-NOW");
  });

  it("hands the slot the turn it is rendering for", async () => {
    const seenCtx: string[] = [];
    registerContextSlot({
      id: "echo",
      refresh: "turn",
      render: (c) => {
        seenCtx.push(c.userMessage);
        return null;
      },
    });

    await run([]);

    expect(seenCtx).toContain("go");
  });

  it("sends nothing extra when no slot is registered", async () => {
    const seen: ChatParams[] = [];
    await run(seen);
    expect(seen[0].messages.every((m) => !m.content?.includes("HOUSE-RULES"))).toBe(true);
  });
});
