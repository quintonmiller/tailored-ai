import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { NativeTaskBackend } from "../tasks/native.js";
import { describeOwner, TaskQueryTool } from "../tools/tasks.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("TaskQueryTool description", () => {
  it("description contains the word example", () => {
    const tool = new TaskQueryTool(new NativeTaskBackend(db));
    expect(tool.description.toLowerCase()).toContain("example");
  });

  it("description contains task_query(", () => {
    const tool = new TaskQueryTool(new NativeTaskBackend(db));
    expect(tool.description).toContain("task_query(");
  });
});

describe("task_query ownership", () => {
  it("says who owns a task, including when nobody does", () => {
    // An unassigned task rendered as bare text, so "no assignee" read as "no
    // information" — and eleven agents reported the same two unassigned tasks
    // as their own work when asked what they were doing.
    expect(describeOwner(null, "coder")).toBe("unassigned (not yours)");
    expect(describeOwner("", "coder")).toBe("unassigned (not yours)");
  });

  it("distinguishes yours from someone else's", () => {
    expect(describeOwner("coder", "coder")).toBe("yours");
    expect(describeOwner("Coder", "coder")).toBe("yours");
    expect(describeOwner("reviewer", "coder")).toBe("assigned to reviewer");
  });

  it("names the owner when there is no reader to compare against", () => {
    expect(describeOwner("coder")).toBe("assigned to coder");
  });

  it("scopes to the caller with mine, and shows everything without it", async () => {
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "mine", assignee: "coder" });
    await backend.create({ title: "theirs", assignee: "reviewer" });
    await backend.create({ title: "nobody's" });
    const tool = new TaskQueryTool(backend);

    const scoped = await tool.execute({ mine: true }, { agentName: "coder" } as never);
    expect(scoped.output).toContain("mine");
    expect(scoped.output).not.toContain("theirs");

    const all = await tool.execute({}, { agentName: "coder" } as never);
    expect(all.output).toContain("yours");
    expect(all.output).toContain("assigned to reviewer");
    expect(all.output).toContain("unassigned (not yours)");
  });
});
