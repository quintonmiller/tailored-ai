/**
 * Regression coverage for #64: workflow steps anchor to the active project
 * root instead of process.cwd(). Verifies the engine snapshots
 * `getProjectPath` at run start and threads it onto every
 * `StepContext.projectPath`, and that the shell + tool_call + worktree
 * executors prefer it over their own constructor defaults.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { type StepContext, type StepExecutor, type StepResult, WorkflowEngine } from "../workflows/engine.js";
import { ShellExecutor } from "../workflows/executors/shell.js";
import { ToolCallExecutor } from "../workflows/executors/tool-call.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

/** Captures the StepContext so tests can assert what the engine threaded in. */
class CaptureExecutor implements StepExecutor {
  type = "shell" as const;
  contexts: StepContext[] = [];
  async execute(_step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    this.contexts.push(ctx);
    return { output: ctx.projectPath ?? null };
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

describe("workflow project path (#64)", () => {
  it("threads getProjectPath() onto StepContext.projectPath", async () => {
    const exec = new CaptureExecutor();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [exec],
      getProjectPath: () => "/srv/projects/alpha",
    });
    registry.register({
      name: "wf",
      steps: [{ name: "s1", type: "shell", command: "echo hi" }],
    });
    await engine.runWorkflow("wf");
    expect(exec.contexts).toHaveLength(1);
    expect(exec.contexts[0].projectPath).toBe("/srv/projects/alpha");
  });

  it("leaves projectPath undefined when no resolver is wired", async () => {
    const exec = new CaptureExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "wf",
      steps: [{ name: "s1", type: "shell", command: "echo hi" }],
    });
    await engine.runWorkflow("wf");
    expect(exec.contexts[0].projectPath).toBeUndefined();
  });

  it("snapshots the project path at run start so a mid-run switch doesn't affect in-flight steps", async () => {
    const exec = new CaptureExecutor();
    let current = "/srv/projects/alpha";
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [exec],
      getProjectPath: () => current,
    });
    registry.register({
      name: "wf",
      steps: [
        { name: "s1", type: "shell", command: "echo a" },
        { name: "s2", type: "shell", command: "echo b" },
      ],
    });
    // Flip the active project between steps. The run is already in flight so
    // both steps should see the value captured at start.
    const original = exec.execute.bind(exec);
    exec.execute = async (step, ctx) => {
      const r = await original(step, ctx);
      current = "/srv/projects/beta";
      return r;
    };
    await engine.runWorkflow("wf");
    expect(exec.contexts).toHaveLength(2);
    expect(exec.contexts[0].projectPath).toBe("/srv/projects/alpha");
    expect(exec.contexts[1].projectPath).toBe("/srv/projects/alpha");
  });

  it("swallows resolver errors and runs in global mode", async () => {
    const exec = new CaptureExecutor();
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (msg: string) => warned.push(msg);
    try {
      const engine = new WorkflowEngine({
        db,
        registry,
        executors: [exec],
        getProjectPath: () => {
          throw new Error("boom");
        },
      });
      registry.register({
        name: "wf",
        steps: [{ name: "s1", type: "shell", command: "echo hi" }],
      });
      await engine.runWorkflow("wf");
    } finally {
      console.warn = warn;
    }
    expect(exec.contexts[0].projectPath).toBeUndefined();
    expect(warned.some((w) => w.includes("getProjectPath threw"))).toBe(true);
  });
});

describe("ShellExecutor — projectPath fallback (#64)", () => {
  it("runs commands in ctx.projectPath when step.cwd is unset", async () => {
    const projectPath = process.cwd(); // any real directory works
    const shell = new ShellExecutor({ cwd: "/should/not/be/used" });
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [shell],
      getProjectPath: () => projectPath,
    });
    registry.register({
      name: "wf",
      steps: [{ name: "pwd", type: "shell", command: "pwd" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe(projectPath);
  });

  it("explicit step.cwd still wins over ctx.projectPath", async () => {
    const overrideCwd = process.cwd();
    const shell = new ShellExecutor();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [shell],
      getProjectPath: () => "/nonexistent/should/be/ignored",
    });
    registry.register({
      name: "wf",
      steps: [{ name: "pwd", type: "shell", command: "pwd", cwd: overrideCwd }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe(overrideCwd);
  });
});

describe("ToolCallExecutor — projectPath fallback (#64)", () => {
  it("passes ctx.projectPath as ToolContext.workingDirectory", async () => {
    let observedWorkingDir: string | undefined;
    const fakeTool: Tool = {
      name: "probe",
      description: "captures workingDirectory",
      parameters: { type: "object" },
      async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        observedWorkingDir = ctx.workingDirectory;
        return { success: true, output: ctx.workingDirectory };
      },
    };
    const toolCall = new ToolCallExecutor({
      getTools: () => [fakeTool],
      workingDirectory: "/constructor-default",
    });
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [toolCall],
      getProjectPath: () => "/srv/projects/gamma",
    });
    registry.register({
      name: "wf",
      steps: [{ name: "call", type: "tool_call", tool: "probe", args: {} } as WorkflowStepDef],
    });
    await engine.runWorkflow("wf");
    expect(observedWorkingDir).toBe("/srv/projects/gamma");
  });
});
