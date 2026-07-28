/**
 * De-role the task watcher (#204): worktree creation and the dispatch
 * preamble are driven by per-agent config (`worktree`, `taskPreamble`),
 * not by the hardcoded names "coder"/"reviewer".
 *
 * These tests run the watcher's `processEvent` end-to-end with `createWorktree`
 * and `runAgentLoop` mocked, asserting:
 *   - a worktree is created for an agent with `worktree: true` regardless of
 *     its name (here "fixer");
 *   - no worktree is created for an agent named "coder" that lacks the flag;
 *   - `taskPreamble` is expanded with the documented template vars and
 *     prepended to the dispatch prompt.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";

// Mock the worktree + loop + session modules so processEvent is reachable
// without a real git repo / provider.
const createWorktreeMock = vi.fn();
vi.mock("../worktree.js", () => ({
  createWorktree: (...args: unknown[]) => createWorktreeMock(...args),
}));

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", () => ({
  runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args),
}));

vi.mock("../agent/session.js", () => ({
  resetSession: () => ({ id: "s1", model: "m", provider: "p" }),
  findOrCreateSession: () => ({ id: "s1", model: "m", provider: "p" }),
}));

// pnpm install in the worktree shells out; stub it so the test doesn't try.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: (_cmd: string, _opts: unknown, cb: (e: null) => void) => cb(null) };
});

import { TaskWatcher } from "../task-watcher.js";

let db: Database.Database;

interface AgentDef {
  description?: string;
  worktree?: boolean;
  taskPreamble?: string;
}

function makeRuntime(agents: Record<string, AgentDef>): any {
  const config = {
    agents,
    providers: { local: { defaultModel: "m" } },
    agent: {
      defaultProvider: "local",
      extraInstructions: "",
      temperature: 0.3,
      maxToolRounds: 8,
    },
    channels: {},
    taskWatcher: {
      enabled: true,
      delivery: { channel: "log" },
      triggers: ["created", "updated"],
      debounceMs: 0,
      prompt: "Do the task.",
    },
    prompts: {},
  };
  return {
    db,
    events: new TypedEventBus(),
    contextDir: "/tmp/ctx",
    kbDir: "/tmp/kb",
    getConfig: () => config,
    getTools: () => [],
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => agents[name],
    getWorktreeAgentNames: () =>
      Object.entries(agents)
        .filter(([, d]) => d.worktree)
        .map(([n]) => n),
    getPrimaryOwner: () => ({ channelId: "c", userId: "u", displayName: "Owner" }),
    makeSessionKey: () => "key",
    resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
    buildLoopOptions: () => ({}),
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
  createWorktreeMock.mockReset();
  runAgentLoopMock.mockReset();
  runAgentLoopMock.mockResolvedValue("done");
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe("task-watcher worktree opt-in (#204)", () => {
  it("creates a worktree for a worktree-opted agent regardless of name", async () => {
    createWorktreeMock.mockResolvedValue({
      path: "/tmp/wt",
      branch: "agent/x",
      cleanup: async () => ({}),
    });
    createProject(db, { id: "proj1", title: "Repo", path: "/tmp/repo" });
    const runtime = makeRuntime({ fixer: { worktree: true } });
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "Fix it", assignee: "fixer", project_id: "proj1" });

    await watcher.processEvent({ action: "updated", task: { ...task, tags: [] } });

    expect(createWorktreeMock).toHaveBeenCalledTimes(1);
    const opts = createWorktreeMock.mock.calls[0][0];
    expect(opts.repoDir).toBe("/tmp/repo");
  });

  it("does NOT create a worktree for an agent named 'coder' that lacks the flag", async () => {
    createProject(db, { id: "proj1", title: "Repo", path: "/tmp/repo" });
    const runtime = makeRuntime({ coder: { description: "no flag" } });
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "Build", assignee: "coder", project_id: "proj1" });

    await watcher.processEvent({ action: "updated", task: { ...task, tags: [] } });

    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it("expands taskPreamble with template vars and prepends it to the prompt", async () => {
    createWorktreeMock.mockResolvedValue({
      path: "/tmp/wt-abc",
      branch: "agent/abc-fix",
      cleanup: async () => ({}),
    });
    createProject(db, { id: "proj1", title: "Repo", path: "/tmp/repo" });
    const preamble = [
      "Agent {{owner_name}} on branch {{worktree_branch}} at {{worktree_path}}.",
      "Task {{task_id}} ({{task_title}}) in project {{project_id}}.",
    ].join("\n");
    const runtime = makeRuntime({ fixer: { worktree: true, taskPreamble: preamble } });
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "Fix things", assignee: "fixer", project_id: "proj1" });

    await watcher.processEvent({ action: "updated", task: { ...task, tags: [] } });

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    const prompt = runAgentLoopMock.mock.calls[0][0] as string;
    expect(prompt).toContain("Agent Owner on branch agent/abc-fix at /tmp/wt-abc.");
    expect(prompt).toContain(`Task ${task.id} (Fix things) in project proj1.`);
    // Preamble leads the prompt.
    expect(prompt.startsWith("Agent Owner")).toBe(true);
  });

  it("leaves worktree vars empty when the agent has a preamble but no worktree", async () => {
    const runtime = makeRuntime({
      planner: { taskPreamble: "branch=[{{worktree_branch}}] path=[{{worktree_path}}]" },
    });
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "Plan", assignee: "planner" });

    await watcher.processEvent({ action: "updated", task: { ...task, tags: [] } });

    expect(createWorktreeMock).not.toHaveBeenCalled();
    const prompt = runAgentLoopMock.mock.calls[0][0] as string;
    expect(prompt).toContain("branch=[] path=[]");
  });
});
