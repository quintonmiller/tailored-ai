import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assembleBriefingContext,
  type BriefingRuntime,
  DEFAULT_BRIEFING_PROMPT,
  generateBriefing,
} from "../briefing.js";
import type { AgentConfig } from "../config.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, updateProjectTask } from "../db/task-queries.js";
import { createWorkflowRun, updateWorkflowRun } from "../db/workflow-queries.js";
import type { AIProvider, ChatParams } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function buildConfig(overrides: Partial<AgentConfig["briefing"]> = {}): AgentConfig {
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
    briefing: { enabled: true, prompt: DEFAULT_BRIEFING_PROMPT, ttlMinutes: 30, ...overrides },
  } as AgentConfig;
}

function makeRuntime(config: AgentConfig, chat: AIProvider["chat"], model = "default-model"): BriefingRuntime {
  return {
    db,
    getConfig: () => config,
    getProvider: () => ({ id: "stub", name: "stub", supportsTools: true, chat }),
    getModel: () => model,
  };
}

describe("assembleBriefingContext", () => {
  it("reports nothing-notable when the database is empty", () => {
    const ctx = assembleBriefingContext(
      makeRuntime(buildConfig(), async () => ({}) as never),
      24,
    );
    expect(ctx).toContain("Nothing notable happened");
  });

  it("includes blocked tasks, recent done tasks, completed runs, and cron jobs", () => {
    const blocked = createProjectTask(db, { title: "Stuck task" });
    updateProjectTask(db, blocked.id, { status: "blocked", blocked_reason: "question" });

    const done = createProjectTask(db, { title: "Finished task" });
    updateProjectTask(db, done.id, { status: "done" });

    const run = createWorkflowRun(db, { workflow_name: "nightly", trigger: "manual" });
    updateWorkflowRun(db, run.id, { status: "completed" });

    createNote(db, { content: "Talked about the migration plan", tags: ["session-summary"] });

    const config = buildConfig();
    config.cron.jobs = [{ name: "morning-digest", schedule: "0 8 * * *", prompt: "go" }];

    const ctx = assembleBriefingContext(
      makeRuntime(config, async () => ({}) as never),
      24,
    );
    expect(ctx).toContain("Stuck task");
    expect(ctx).toContain("(question)");
    expect(ctx).toContain("Finished task");
    expect(ctx).toContain("nightly");
    expect(ctx).toContain("morning-digest");
    expect(ctx).toContain("migration plan");
  });

  it("caps each list at 5 items and the total context length", () => {
    for (let i = 0; i < 12; i++) {
      const t = createProjectTask(db, { title: `Blocked ${i}` });
      updateProjectTask(db, t.id, { status: "blocked", blocked_reason: "error" });
    }
    const ctx = assembleBriefingContext(
      makeRuntime(buildConfig(), async () => ({}) as never),
      24,
    );
    // Only 5 of the 12 blocked tasks should appear.
    const matches = ctx.match(/Blocked \d+/g) ?? [];
    expect(matches.length).toBe(5);
    expect(ctx.length).toBeLessThanOrEqual(1500);
  });

  it("excludes done tasks older than the window", () => {
    const old = createProjectTask(db, { title: "Old done" });
    db.prepare("UPDATE project_tasks SET status = 'done', updated_at = datetime('now', '-48 hours') WHERE id = ?").run(
      old.id,
    );
    const ctx = assembleBriefingContext(
      makeRuntime(buildConfig(), async () => ({}) as never),
      24,
    );
    expect(ctx).not.toContain("Old done");
  });
});

describe("generateBriefing", () => {
  it("runs one provider call with the config prompt as the system message", async () => {
    const blocked = createProjectTask(db, { title: "Needs review" });
    updateProjectTask(db, blocked.id, { status: "blocked", blocked_reason: "question" });

    const chat = vi.fn(async (_params: ChatParams) => ({
      content: "Good morning! One thing needs you.",
      usage: { input: 0, output: 0 },
      finishReason: "stop" as const,
    }));

    const result = await generateBriefing(makeRuntime(buildConfig(), chat));

    expect(chat).toHaveBeenCalledTimes(1);
    const params = chat.mock.calls[0][0];
    expect(params.messages[0].role).toBe("system");
    expect(params.messages[0].content).toBe(DEFAULT_BRIEFING_PROMPT);
    expect(params.messages[1].role).toBe("user");
    expect(params.messages[1].content).toContain("Needs review");
    expect(result.content).toBe("Good morning! One thing needs you.");
    expect(result.generatedAt).toBeGreaterThan(0);
  });

  it("uses briefing.model when set, otherwise the runtime model", async () => {
    const chat = vi.fn(async (_params: ChatParams) => ({
      content: "ok",
      usage: { input: 0, output: 0 },
      finishReason: "stop" as const,
    }));

    await generateBriefing(makeRuntime(buildConfig({ model: "override-model" }), chat));
    expect(chat.mock.calls[0][0].model).toBe("override-model");

    chat.mockClear();
    await generateBriefing(makeRuntime(buildConfig(), chat, "runtime-model"));
    expect(chat.mock.calls[0][0].model).toBe("runtime-model");
  });

  it("falls back to the default prompt when config prompt is blank", async () => {
    const chat = vi.fn(async (_params: ChatParams) => ({
      content: "ok",
      usage: { input: 0, output: 0 },
      finishReason: "stop" as const,
    }));
    await generateBriefing(makeRuntime(buildConfig({ prompt: "   " }), chat));
    expect(chat.mock.calls[0][0].messages[0].content).toBe(DEFAULT_BRIEFING_PROMPT);
  });
});
