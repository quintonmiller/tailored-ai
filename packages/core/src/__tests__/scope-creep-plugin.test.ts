/**
 * Scope-creep flagger default-plugin tests — Slice 3 step 2 of the
 * platform vision (`docs/platform-vision.md`). The plugin subscribes to
 * `agent.completed`; when the coder hands off to the reviewer on a
 * worktree branch, it shells out to git to count foreign ptask_ ids and
 * writes a SCOPE WARNING comment.
 *
 * These tests exercise the plugin's branching + comment-writing logic
 * against a real SQLite db, but mock the git side of `detectScopeCreep`
 * by spying on `child_process.execFile` so we don't need a temp repo.
 */
import { execFile } from "node:child_process";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { createProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { ScopeCreepFlagger, writeScopeWarning } from "../plugins/scope-creep-flagger.js";
import type { AgentRuntime } from "../runtime.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: vi.fn() };
});

const execFileMock = execFile as unknown as MockInstance;

let db: Database.Database;
let runtime: AgentRuntime;

function makeRuntime(): AgentRuntime {
  const events = new TypedEventBus();
  return { db, events, getConfig: () => ({}) } as unknown as AgentRuntime;
}

function readComments(db: Database.Database, taskId: string): Array<{ author: string; content: string }> {
  return db.prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id").all(taskId) as Array<{
    author: string;
    content: string;
  }>;
}

/**
 * Wire `execFile` so the first call (merge-base) returns a sha and the
 * second (git log) returns the supplied commit lines.
 */
function stubGit(mergeBase: string, logLines: string[]) {
  execFileMock.mockReset();
  let call = 0;
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], cb: (err: Error | null, out: { stdout: string }) => void) => {
      call++;
      if (call === 1) cb(null, { stdout: `${mergeBase}\n` });
      else cb(null, { stdout: `${logLines.join("\n")}\n` });
    },
  );
}

beforeEach(() => {
  db = initDatabase(":memory:");
  runtime = makeRuntime();
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe("ScopeCreepFlagger subscription gate", () => {
  it("ignores events when agentName is not coder", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "default",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("ignores events when finalTask.assignee is not reviewer", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "Quinton" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("ignores events with no worktree (non-coding agent path)", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("ScopeCreepFlagger comment-writing", () => {
  it("writes a SCOPE WARNING when branch has foreign ptask_ ids", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    // Branch contains a commit for the task itself + a foreign id.
    stubGit("abc123", [`${task.id}: implement`, "ptask_deadbeef: drive-by"]);

    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));

    const comments = readComments(db, task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("task-watcher");
    expect(comments[0].content).toContain("SCOPE WARNING");
    expect(comments[0].content).toContain("ptask_deadbeef");
  });

  it("writes NOTHING when the only ptask_ id on the branch is the task's own id", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    stubGit("abc123", [`${task.id}: implement`, `${task.id}: fix tests`]);

    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(readComments(db, task.id)).toHaveLength(0);
  });

  it("uses repoPath + branch (not worktreePath) so it survives worktree cleanup", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    stubGit("abc123", ["unrelated commit"]);

    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/parent-repo", worktreePath: "/tmp/wt", branch: "agent/T-slug", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));

    // First execFile call should be `git -C /tmp/parent-repo merge-base main agent/T-slug`.
    expect(execFileMock).toHaveBeenCalled();
    const firstCallArgs = execFileMock.mock.calls[0][1] as string[];
    expect(firstCallArgs).toEqual(["-C", "/tmp/parent-repo", "merge-base", "main", "agent/T-slug"]);
  });

  it("survives a git error without throwing or writing a comment", async () => {
    new ScopeCreepFlagger({ runtime });
    const task = createProjectTask(db, { title: "T" });
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: Error) => void) => {
      cb(new Error("git: not a repo"));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(readComments(db, task.id)).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("stop() disposes the subscription so later events are ignored", async () => {
    const flagger = new ScopeCreepFlagger({ runtime });
    flagger.stop();
    const task = createProjectTask(db, { title: "T" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "T", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "T", status: "in_review", assignee: "reviewer" },
      response: "",
      worktree: { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath: null },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe("writeScopeWarning", () => {
  it("formats the comment with leading SCOPE WARNING and lists every foreign id", () => {
    const task = createProjectTask(db, { title: "T" });
    writeScopeWarning(db, task.id, ["ptask_aaaaaaaa", "ptask_bbbbbbbb"]);
    const comments = readComments(db, task.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].content).toMatch(/^SCOPE WARNING:/);
    expect(comments[0].content).toContain("ptask_aaaaaaaa");
    expect(comments[0].content).toContain("ptask_bbbbbbbb");
  });
});
