import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { GitHubTaskBackend } from "../tasks/github.js";
import { NativeTaskBackend } from "../tasks/native.js";
import { TasksTool } from "../tools/tasks.js";
import type { ToolContext } from "../tools/interface.js";

let db: Database.Database;
const ctx: ToolContext = {
  sessionId: "test",
  workingDirectory: "/tmp",
  env: {},
};

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function nativeTool() {
  return new TasksTool(new NativeTaskBackend(db), db);
}

function getStatusEnum(tool: TasksTool): string[] {
  const params = tool.parameters as { properties: { status: { enum: string[] } } };
  return params.properties.status.enum;
}

describe("TasksTool description and status enum", () => {
  it("native backend exposes backlog/in_progress/blocked/done plus in_review/archived", () => {
    const tool = nativeTool();
    const statuses = getStatusEnum(tool);
    expect(new Set(statuses)).toEqual(
      new Set(["backlog", "in_progress", "blocked", "done", "in_review", "archived"]),
    );
    expect(tool.description).toContain("backend: native");
  });

  it("github backend exposes backlog/in_progress/blocked/done plus in_review (no archived)", () => {
    const fakeOctokit = {
      rest: { issues: { create: async () => ({ data: {} }) } },
    } as unknown as import("@octokit/rest").Octokit;
    const tool = new TasksTool(
      new GitHubTaskBackend({ repo: "a/b", token: "x", octokit: fakeOctokit }),
    );
    const statuses = getStatusEnum(tool);
    expect(new Set(statuses)).toEqual(
      new Set(["backlog", "in_progress", "blocked", "done", "in_review"]),
    );
    expect(statuses).not.toContain("archived");
    expect(tool.description).toContain("backend: github");
  });
});

describe("TasksTool status validation", () => {
  it("create rejects an unknown status with the valid set in the error", async () => {
    const tool = nativeTool();
    const result = await tool.execute({ action: "create", title: "T1", status: "bogus" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid status "bogus"/);
    expect(result.error).toMatch(/native backend/);
    expect(result.error).toMatch(/backlog/);
  });

  it("create accepts a valid status from the backend's full enum", async () => {
    const tool = nativeTool();
    const result = await tool.execute({ action: "create", title: "T1", status: "in_review" }, ctx);
    expect(result.success).toBe(true);
  });

  it("update rejects an unknown status before reading the existing task", async () => {
    const tool = nativeTool();
    const created = await tool.execute({ action: "create", title: "T1" }, ctx);
    expect(created.success).toBe(true);
    const id = created.output.match(/\((ptask_[a-f0-9]+)\)/)?.[1];
    expect(id).toBeDefined();

    const result = await tool.execute(
      { action: "update", id, status: "bogus", comment: "trying to break things" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid status "bogus"/);
  });
});
