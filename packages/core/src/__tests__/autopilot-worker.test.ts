import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unblockBudgetTasks } from "../db/task-queries.js";
import {
  recordTokenUsage,
  updateAutopilotSettings,
} from "../db/autopilot-queries.js";
import { createProjectTask, getProjectTask, updateProjectTask } from "../db/task-queries.js";
import { initDatabase } from "../db/schema.js";
import { TasksTool } from "../tools/tasks.js";
import type { ToolContext } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// Full AutopilotWorker end-to-end requires a live provider + runtime; that's
// covered by manual dogfooding. These tests pin the DB-level behaviors that
// the worker relies on so regressions show up without needing a fixture LLM.
describe("autopilot worker DB contracts", () => {
  it("unblockBudgetTasks restores cards without touching question-blocked ones", () => {
    const budget = createProjectTask(db, { title: "Budget" });
    updateProjectTask(db, budget.id, { status: "blocked", blocked_reason: "budget" });
    const question = createProjectTask(db, { title: "Question" });
    updateProjectTask(db, question.id, { status: "blocked", blocked_reason: "question" });

    const restored = unblockBudgetTasks(db);
    expect(restored).toBe(1);
    expect(getProjectTask(db, budget.id)?.status).toBe("backlog");
    expect(getProjectTask(db, question.id)?.status).toBe("blocked");
  });

  it("records mid-task token usage against taskId", () => {
    const task = createProjectTask(db, { title: "t" });
    recordTokenUsage(db, {
      taskId: task.id,
      sessionId: "sess_x",
      promptTokens: 500,
      completionTokens: 100,
    });

    const row = db
      .prepare("SELECT prompt_tokens, completion_tokens, task_id FROM token_usage WHERE task_id = ?")
      .get(task.id) as { prompt_tokens: number; completion_tokens: number; task_id: string };
    expect(row.prompt_tokens).toBe(500);
    expect(row.completion_tokens).toBe(100);
    expect(row.task_id).toBe(task.id);
  });

  it("digest_time round-trips null to disable", () => {
    updateAutopilotSettings(db, { digest_time: null });
    const s = db.prepare("SELECT digest_time FROM autopilot_settings WHERE id = 1").get() as {
      digest_time: string | null;
    };
    expect(s.digest_time).toBeNull();
  });
});

describe("TasksTool update — status-change audit trail", () => {
  const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
    sessionId: "s",
    workingDirectory: "/",
    env: {},
    ...overrides,
  });

  it("rejects a status change without a comment", async () => {
    const task = createProjectTask(db, { title: "Do a thing", assignee: "default" });
    const tool = new TasksTool(db);

    const result = await tool.execute(
      { action: "update", id: task.id, status: "done" },
      ctx({ agentName: "default" }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/comment/i);

    const fresh = getProjectTask(db, task.id);
    expect(fresh?.status).toBe("backlog"); // untouched
  });

  it("allows status change with a comment and authors it as the agent", async () => {
    const task = createProjectTask(db, { title: "Do a thing", assignee: "default" });
    const tool = new TasksTool(db);

    const result = await tool.execute(
      {
        action: "update",
        id: task.id,
        status: "done",
        comment: "Saved the summary to memory.",
      },
      ctx({ agentName: "default" }),
    );

    expect(result.success).toBe(true);
    const fresh = getProjectTask(db, task.id);
    expect(fresh?.status).toBe("done");
    expect(fresh?.comments).toHaveLength(1);
    expect(fresh?.comments[0].author).toBe("default");
    expect(fresh?.comments[0].content).toBe("Saved the summary to memory.");
  });

  it("does not require a comment when status is unchanged", async () => {
    const task = createProjectTask(db, { title: "Tag me", assignee: "default" });
    const tool = new TasksTool(db);

    const result = await tool.execute(
      { action: "update", id: task.id, tags: "a,b" },
      ctx({ agentName: "default" }),
    );

    expect(result.success).toBe(true);
    const fresh = getProjectTask(db, task.id);
    expect(fresh?.tags).toEqual(["a", "b"]);
    expect(fresh?.comments).toHaveLength(0);
  });

  it("falls back to 'agent' author when no agentName in context", async () => {
    const task = createProjectTask(db, { title: "x" });
    const tool = new TasksTool(db);

    await tool.execute(
      { action: "update", id: task.id, status: "done", comment: "finished" },
      ctx(),
    );
    const fresh = getProjectTask(db, task.id);
    expect(fresh?.comments[0].author).toBe("agent");
  });
});

describe("buildTaskPrompt", () => {
  it("includes recent comments so resumed tasks have context", async () => {
    const { buildTaskPrompt } = await import("../autopilot/worker.js");
    const task = createProjectTask(db, {
      title: "Draft reply",
      description: "Reply to Alice about budget",
      assignee: "default",
    });
    db.prepare(
      "INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?)",
    ).run(task.id, "default", "**Question for user:** What's our Q2 budget cap?");
    db.prepare(
      "INSERT INTO task_comments (task_id, author, content) VALUES (?, ?, ?)",
    ).run(task.id, "user", "$50k");

    const fresh = getProjectTask(db, task.id)!;
    const prompt = buildTaskPrompt(fresh);

    expect(prompt).toContain("Prior activity");
    expect(prompt).toContain("What's our Q2 budget cap?");
    expect(prompt).toContain("$50k");
    expect(prompt).toContain("do not");
  });

  it("instructs the agent to in_review instead of looping when unreachable", async () => {
    const { buildTaskPrompt } = await import("../autopilot/worker.js");
    const task = createProjectTask(db, {
      title: "Book dentist",
      description: "Book dentist for next Tuesday",
    });
    const prompt = buildTaskPrompt(task);

    expect(prompt).toContain("Do NOT call");
    expect(prompt).toMatch(/in_review/);
    expect(prompt).toMatch(/no tool for/i);
  });
});
