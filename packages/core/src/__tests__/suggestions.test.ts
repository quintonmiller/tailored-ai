import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, updateProjectTask } from "../db/task-queries.js";
import type { AIProvider, ChatParams } from "../providers/interface.js";
import {
  assembleSuggestionsContext,
  DEFAULT_SUGGESTIONS_PROMPT,
  generateSuggestions,
  parseSuggestions,
  type SuggestionsRuntime,
} from "../suggestions.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function buildConfig(overrides: Partial<AgentConfig["suggestions"]> = {}): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    suggestions: { enabled: true, prompt: DEFAULT_SUGGESTIONS_PROMPT, count: 4, ttlMinutes: 15, ...overrides },
  } as AgentConfig;
}

function makeRuntime(config: AgentConfig, chat: AIProvider["chat"], model = "default-model"): SuggestionsRuntime {
  return {
    db,
    getConfig: () => config,
    getProvider: () => ({ id: "stub", name: "stub", supportsTools: true, chat }),
    getModel: () => model,
  };
}

function chatReturning(content: string) {
  return vi.fn(async (_params: ChatParams) => ({
    content,
    usage: { input: 0, output: 0 },
    finishReason: "stop" as const,
  }));
}

describe("parseSuggestions", () => {
  it("returns trimmed lines as-is when already clean", () => {
    const out = parseSuggestions("Resume the migration\nTriage blocked tasks\nReview the open PR", 4);
    expect(out).toEqual(["Resume the migration", "Triage blocked tasks", "Review the open PR"]);
  });

  it("strips bullets and numbering the model may add", () => {
    const raw = ["- Resume the migration", "* Triage blocked tasks", "1. Review the PR", "2) Draft the email"].join(
      "\n",
    );
    expect(parseSuggestions(raw, 4)).toEqual([
      "Resume the migration",
      "Triage blocked tasks",
      "Review the PR",
      "Draft the email",
    ]);
  });

  it("strips wrapping quotes (straight and curly)", () => {
    const raw = ['"Resume the migration"', "'Triage tasks'", "“Review PR”"].join("\n");
    expect(parseSuggestions(raw, 4)).toEqual(["Resume the migration", "Triage tasks", "Review PR"]);
  });

  it("drops blank lines and lines over 100 chars", () => {
    const long = "x".repeat(120);
    const raw = ["Resume the migration", "", "   ", long, "Triage tasks"].join("\n");
    expect(parseSuggestions(raw, 4)).toEqual(["Resume the migration", "Triage tasks"]);
  });

  it("caps at the requested count", () => {
    const raw = ["one", "two", "three", "four", "five", "six"].join("\n");
    expect(parseSuggestions(raw, 3)).toEqual(["one", "two", "three"]);
  });

  it("de-duplicates case-insensitively", () => {
    const raw = ["Resume migration", "resume migration", "Triage tasks"].join("\n");
    expect(parseSuggestions(raw, 4)).toEqual(["Resume migration", "Triage tasks"]);
  });

  it("returns an empty array when fewer than two usable lines survive", () => {
    expect(parseSuggestions("Only one line", 4)).toEqual([]);
    expect(parseSuggestions("", 4)).toEqual([]);
    expect(parseSuggestions("- \n* \n  ", 4)).toEqual([]);
  });
});

describe("assembleSuggestionsContext", () => {
  it("includes the requested count and the briefing data", () => {
    const blocked = createProjectTask(db, { title: "Stuck task" });
    updateProjectTask(db, blocked.id, { status: "blocked", blocked_reason: "question" });
    createNote(db, { content: "Talked about the migration plan", tags: ["session-summary"] });

    const ctx = assembleSuggestionsContext(makeRuntime(buildConfig(), chatReturning("")), 24, 4);
    expect(ctx).toContain("Generate 4 suggestions");
    expect(ctx).toContain("Stuck task");
    expect(ctx).toContain("migration plan");
  });

  it("caps the data context length (briefing budget)", () => {
    for (let i = 0; i < 12; i++) {
      const t = createProjectTask(db, { title: `Blocked ${i}` });
      updateProjectTask(db, t.id, { status: "blocked", blocked_reason: "error" });
    }
    const ctx = assembleSuggestionsContext(makeRuntime(buildConfig(), chatReturning("")), 24, 4);
    const matches = ctx.match(/Blocked \d+/g) ?? [];
    expect(matches.length).toBe(5);
  });
});

describe("generateSuggestions", () => {
  it("runs one provider call with the config prompt as the system message", async () => {
    const blocked = createProjectTask(db, { title: "Needs review" });
    updateProjectTask(db, blocked.id, { status: "blocked", blocked_reason: "question" });

    const chat = chatReturning("Resume the discussion\nTriage blocked tasks");
    const result = await generateSuggestions(makeRuntime(buildConfig(), chat));

    expect(chat).toHaveBeenCalledTimes(1);
    const params = chat.mock.calls[0][0];
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[0].content).toBe(DEFAULT_SUGGESTIONS_PROMPT);
    expect(params.messages[1].role).toBe("user");
    expect(params.messages[1].content).toContain("Needs review");
    expect(params.maxTokens).toBe(512);
    expect(result.suggestions).toEqual(["Resume the discussion", "Triage blocked tasks"]);
    expect(result.generatedAt).toBeGreaterThan(0);
  });

  it("honors suggestions.maxTokens override", async () => {
    const chat = chatReturning("One thing\nAnother thing");
    const config = buildConfig();
    config.suggestions = { ...config.suggestions, maxTokens: 128 };
    await generateSuggestions(makeRuntime(config, chat));
    expect(chat.mock.calls[0][0].maxTokens).toBe(128);
  });

  it("honors suggestions.count in the prompt and the cap", async () => {
    const chat = chatReturning(["a", "b", "c", "d", "e"].join("\n"));
    const result = await generateSuggestions(makeRuntime(buildConfig({ count: 2 }), chat));
    expect(chat.mock.calls[0][0].messages[1].content).toContain("Generate 2 suggestions");
    expect(result.suggestions).toEqual(["a", "b"]);
  });

  it("uses suggestions.model when set, otherwise the runtime model", async () => {
    const chat = chatReturning("one\ntwo");
    await generateSuggestions(makeRuntime(buildConfig({ model: "override-model" }), chat));
    expect(chat.mock.calls[0][0].model).toBe("override-model");

    chat.mockClear();
    await generateSuggestions(makeRuntime(buildConfig(), chat, "runtime-model"));
    expect(chat.mock.calls[0][0].model).toBe("runtime-model");
  });

  it("falls back to the default prompt when config prompt is blank", async () => {
    const chat = chatReturning("one\ntwo");
    await generateSuggestions(makeRuntime(buildConfig({ prompt: "   " }), chat));
    expect(chat.mock.calls[0][0].messages[0].content).toBe(DEFAULT_SUGGESTIONS_PROMPT);
  });

  it("returns an empty list when the model produced nothing usable", async () => {
    const chat = chatReturning("Just one suggestion");
    const result = await generateSuggestions(makeRuntime(buildConfig(), chat));
    expect(result.suggestions).toEqual([]);
  });
});
