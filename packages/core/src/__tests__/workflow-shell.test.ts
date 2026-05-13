import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
} from "../sandboxes/interface.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ShellExecutor } from "../workflows/executors/shell.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-shell-"));
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [new ShellExecutor({ cwd: tmpDir, defaultTimeoutMs: 5000 })],
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ShellExecutor", () => {
  it("captures stdout and resolves ${...} in the command", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "echo",
          type: "shell",
          command: "echo hello-${input.who}",
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { who: "world" });
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe("hello-world");
  });

  it("respects step.cwd", async () => {
    writeFileSync(join(tmpDir, "marker.txt"), "yes\n");
    registry.register({
      name: "wf",
      steps: [{ name: "ls", type: "shell", command: "cat marker.txt", cwd: tmpDir }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe("yes");
  });

  it("merges env from step.env (resolved against scope)", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "show",
          type: "shell",
          command: 'echo "$GREETING $NAME"',
          env: { GREETING: "hi", NAME: "${input.who}" },
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { who: "alice" });
    expect(String(run.output).trim()).toBe("hi alice");
  });

  it("non-zero exit fails the run with stderr in the error", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "boom", type: "shell", command: "echo nope >&2 && exit 7" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/nope|exit 7/);
  });

  it("threads stdout into a downstream tool/shell step via ${steps.<n>}", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "first", type: "shell", command: "printf raw" },
        {
          name: "second",
          type: "shell",
          command: 'printf "got: ${steps.first}"',
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toBe("got: raw");
  });

  it("routes shell commands through a run-level sandbox when configured", async () => {
    const calls: Array<{ command: string; cwd?: string }> = [];
    const handle: SandboxHandle = { kind: "docker", cwd: "/work" };
    const fakeSandbox: Sandbox = {
      kind: "docker",
      prepare: vi.fn(async () => handle),
      cleanup: vi.fn(async () => {}),
      exec: vi.fn(
        async (
          _h: SandboxHandle,
          command: string,
          opts?: SandboxExecOptions,
        ): Promise<SandboxExecResult> => {
          calls.push({ command, cwd: opts?.cwd });
          return { exitCode: 0, stdout: "sandboxed-stdout", stderr: "" };
        },
      ),
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
    };

    db.close();
    db = initDatabase(":memory:");
    registry = new WorkflowRegistry();
    engine = new WorkflowEngine({
      db,
      registry,
      createSandbox: () => fakeSandbox,
      executors: [new ShellExecutor({ cwd: tmpDir, defaultTimeoutMs: 5000 })],
    });

    registry.register({
      name: "wf",
      sandbox: "docker",
      steps: [
        { name: "first", type: "shell", command: "echo a" },
        { name: "second", type: "shell", command: "echo b" },
      ],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toBe("sandboxed-stdout");
    expect(calls.map((c) => c.command)).toEqual(["echo a", "echo b"]);
    expect(fakeSandbox.prepare).toHaveBeenCalledTimes(1);
    expect(fakeSandbox.cleanup).toHaveBeenCalledTimes(1);
  });

  it("step deadline cancels a hanging shell", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "sleep",
          type: "shell",
          command: "sleep 5",
          deadlineMs: 100,
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    const steps = listWorkflowSteps(db, run.id);
    expect(steps[0].status).toBe("failed");
  });
});
