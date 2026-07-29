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

  it("scopes to the caller, and still labels ownership when asked for everything", async () => {
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "mine", assignee: "coder" });
    await backend.create({ title: "theirs", assignee: "reviewer" });
    await backend.create({ title: "nobody's" });
    const tool = new TaskQueryTool(backend);

    const scoped = await tool.execute({ assignee: "me" }, { agentName: "coder" } as never);
    expect(scoped.output).toContain("mine");
    expect(scoped.output).not.toContain("theirs");

    const all = await tool.execute({ assignee: "all" }, { agentName: "coder" } as never);
    expect(all.output).toContain("yours");
    expect(all.output).toContain("assigned to reviewer");
    expect(all.output).toContain("unassigned (not yours)");
  });

  it("refuses to guess when nobody said whose tasks these are", async () => {
    // The old default was "everyone", so an agent asked what IT was working on
    // ran the widest query available and read back whatever came out — here,
    // two unassigned books from the owner's reading list. No default is right:
    // "everyone" is wrong for an agent reporting on itself, "me" is wrong for a
    // planner surveying the queue. So the caller has to say.
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "REAMDE by Neal Stephenson" });
    const tool = new TaskQueryTool(backend);

    const res = await tool.execute({}, { agentName: "coder" } as never);

    expect(res.success).toBe(false);
    expect(res.error).toContain("assignee is required");
    // The error has to teach the fix, because a model only gets one correction.
    for (const option of ["me", "all", "unassigned"]) expect(res.error).toContain(option);
    expect(res.output).not.toContain("REAMDE");
  });

  it("finds the tasks nobody owns, without them counting as anyone's", async () => {
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "REAMDE by Neal Stephenson" });
    await backend.create({ title: "ship the thing", assignee: "coder" });
    const tool = new TaskQueryTool(backend);

    const orphans = await tool.execute({ assignee: "unassigned" }, { agentName: "coder" } as never);
    expect(orphans.output).toContain("REAMDE");
    expect(orphans.output).not.toContain("ship the thing");

    const mine = await tool.execute({ assignee: "me" }, { agentName: "coder" } as never);
    expect(mine.output).toContain("ship the thing");
    expect(mine.output).not.toContain("REAMDE");
  });

  it("takes several names at once", async () => {
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "a-task", assignee: "coder" });
    await backend.create({ title: "b-task", assignee: "reviewer" });
    await backend.create({ title: "c-task", assignee: "planner" });
    const tool = new TaskQueryTool(backend);

    const res = await tool.execute({ assignee: ["coder", "reviewer"] }, { agentName: "coder" } as never);

    expect(res.output).toContain("a-task");
    expect(res.output).toContain("b-task");
    expect(res.output).not.toContain("c-task");
  });

  it('keeps "mine: true" working, because prompts already say it', async () => {
    const backend = new NativeTaskBackend(db);
    await backend.create({ title: "mine", assignee: "coder" });
    await backend.create({ title: "theirs", assignee: "reviewer" });
    const tool = new TaskQueryTool(backend);

    const res = await tool.execute({ mine: true }, { agentName: "coder" } as never);

    expect(res.output).toContain("mine");
    expect(res.output).not.toContain("theirs");
  });
});
