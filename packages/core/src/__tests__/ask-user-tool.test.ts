/**
 * ask_user tool tests (#205). The tool no longer DMs the owner inline — it
 * emits `question.asked` (delivery owned by the owner-notifier plugin) and
 * writes out-of-autopilot questions to the configured inbox file.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, getProjectTask } from "../db/task-queries.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { AskUserTool } from "../tools/ask-user.js";
import type { ToolContext } from "../tools/interface.js";

let db: Database.Database;
let contextDir: string;

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  sessionId: "sess_1",
  workingDirectory: "/",
  env: {},
  ...over,
});

beforeEach(() => {
  db = initDatabase(":memory:");
  contextDir = mkdtempSync(join(tmpdir(), "ask-user-"));
});

afterEach(() => {
  db.close();
  rmSync(contextDir, { recursive: true, force: true });
});

describe("AskUserTool", () => {
  it("autopilot path blocks the task and emits question.asked with the task id", async () => {
    const events = new TypedEventBus();
    const received: RuntimeEventPayload<"question.asked">[] = [];
    events.on("question.asked", (e) => {
      received.push(e);
    });
    const task = createProjectTask(db, { title: "Book dentist", assignee: "default" });
    const tool = new AskUserTool({ contextDir, events, inboxFile: "inbox.md" });

    const res = await tool.execute(
      { question: "Which day works?" },
      ctx({ db, autopilotTaskId: task.id, agentName: "default" }),
    );

    expect(res.success).toBe(true);
    expect(getProjectTask(db, task.id)?.status).toBe("blocked");
    expect(getProjectTask(db, task.id)?.blocked_reason).toBe("question");
    expect(received).toEqual([{ question: "Which day works?", sessionId: "sess_1", taskId: task.id }]);
  });

  it("out-of-autopilot path writes the configured inbox file and emits question.asked", async () => {
    const events = new TypedEventBus();
    const received: RuntimeEventPayload<"question.asked">[] = [];
    events.on("question.asked", (e) => {
      received.push(e);
    });
    const tool = new AskUserTool({ contextDir, events, inboxFile: "questions.md" });

    const res = await tool.execute({ question: "Coffee or tea?" }, ctx());

    expect(res.success).toBe(true);
    expect(res.output).toContain("questions.md");
    const inbox = readFileSync(resolve(contextDir, "global", "questions.md"), "utf-8");
    expect(inbox).toContain("[QUESTION]");
    expect(inbox).toContain("Coffee or tea?");
    // No taskId on the out-of-autopilot event.
    expect(received).toEqual([{ question: "Coffee or tea?", sessionId: "sess_1" }]);
  });

  it("records to the inbox even when no event bus is wired", async () => {
    const tool = new AskUserTool({ contextDir, inboxFile: "inbox.md" });
    const res = await tool.execute({ question: "Anybody there?" }, ctx());
    expect(res.success).toBe(true);
    const inbox = readFileSync(resolve(contextDir, "global", "inbox.md"), "utf-8");
    expect(inbox).toContain("Anybody there?");
  });
});
