import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileLogStore,
  WorkflowEngine,
  WorkflowRegistry,
  initDatabase,
  type StepExecutor,
  type StepResult,
  type WorkflowStepDef,
} from "../index.js";

class FailingExec implements StepExecutor {
  type = "shell" as const;
  async execute(step: WorkflowStepDef): Promise<StepResult> {
    if ((step as { command: string }).command === "boom") {
      throw new Error("kaboom");
    }
    return { output: `ok:${(step as { command: string }).command}` };
  }
}

let tmp: string;
let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;
let store: FileLogStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wf-logs-"));
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [new FailingExec()],
  });
  store = new FileLogStore(join(tmp, "logs"));
  store.attach(engine);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("FileLogStore.attach", () => {
  it("creates a per-run directory and writes per-step log files", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "s1", type: "shell", command: "first" },
        { name: "s2", type: "shell", command: "second" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    const dir = store.runDir(run.id);
    expect(statSync(dir).isDirectory()).toBe(true);
    const s1 = readFileSync(store.stepLogPath(run.id, "s1"), "utf-8");
    expect(s1).toContain("[start] shell attempt 1");
    expect(s1).toContain("[done] ok:first");
    const s2 = readFileSync(store.stepLogPath(run.id, "s2"), "utf-8");
    expect(s2).toContain("ok:second");
  });

  it("captures failure messages in the step log", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "x", type: "shell", command: "boom" }],
    });
    await engine.runWorkflow("wf");
    const all = readdirSync(store.baseDir);
    expect(all.length).toBe(1);
    const log = readFileSync(store.stepLogPath(all[0], "x"), "utf-8");
    expect(log).toContain("[failed] kaboom");
  });

  it("captures run-level events in _run.log", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "ok", type: "shell", command: "fine" }],
    });
    const run = await engine.runWorkflow("wf");
    const runLog = readFileSync(store.stepLogPath(run.id, "_run"), "utf-8");
    expect(runLog).toContain("[start] workflow=wf");
    expect(runLog).toContain("[completed]");
  });

  it("sanitizes step names with unsafe characters", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "weird/name space", type: "shell", command: "x" }],
    });
    const run = await engine.runWorkflow("wf");
    const path = store.stepLogPath(run.id, "weird/name space");
    expect(path.endsWith("weird_name_space.log")).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("[done]");
  });
});

describe("FileLogStore.pruneOldRuns", () => {
  it("retains the N newest runs per workflow and deletes older log dirs", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "x" }],
    });
    // Need different started_at values; sleep 1s between two runs to advance
    // the second-resolution timestamp, then a third.
    const a = await engine.runWorkflow("wf");
    await new Promise((r) => setTimeout(r, 1100));
    const b = await engine.runWorkflow("wf");
    await new Promise((r) => setTimeout(r, 1100));
    const c = await engine.runWorkflow("wf");

    expect(readdirSync(store.baseDir).sort()).toEqual([a.id, b.id, c.id].sort());
    const deleted = store.pruneOldRuns(db, 2);
    expect(deleted).toBe(1);
    const remaining = readdirSync(store.baseDir);
    expect(remaining).toContain(c.id);
    expect(remaining).toContain(b.id);
    expect(remaining).not.toContain(a.id);
  }, 8000);

  it("keeps everything when retain >= run count", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "x" }],
    });
    const a = await engine.runWorkflow("wf");
    const deleted = store.pruneOldRuns(db, 10);
    expect(deleted).toBe(0);
    expect(readdirSync(store.baseDir)).toContain(a.id);
  });
});
