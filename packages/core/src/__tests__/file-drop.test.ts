import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { FileDropWatcher } from "../triggers/file-drop.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { StepContext, StepResult, StepExecutor } from "../workflows/engine.js";

let db: Database.Database;
let registry: WorkflowRegistry;
let dropDir: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  dropDir = mkdtempSync(join(tmpdir(), "file-drop-"));
});

afterEach(() => {
  db.close();
  rmSync(dropDir, { recursive: true, force: true });
});

class RecordingExecutor implements StepExecutor {
  type = "tool_call" as const;
  runs: Array<{ name: string; input: unknown; scope: unknown }> = [];

  async execute(step: { name: string }, ctx: StepContext): Promise<StepResult> {
    this.runs.push({
      name: step.name,
      input: ctx.scope.input,
      scope: ctx.scope,
    });
    return { output: ctx.scope.input };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("FileDropWatcher", () => {
  it("fires the workflow after a file becomes stable", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "ingest",
      steps: [{ name: "record", type: "tool_call", tool: "noop" }],
    });

    const watcher = new FileDropWatcher({ workflowEngine: engine });
    watcher.register("ingest", { kind: "file_drop", path: dropDir, stableForMs: 80 });

    writeFileSync(join(dropDir, "alpha.pdf"), "hello");
    await sleep(200);

    expect(exec.runs.length).toBe(1);
    const input = exec.runs[0].input as { file_path: string; file_name: string; file_ext: string };
    expect(input.file_name).toBe("alpha.pdf");
    expect(input.file_ext).toBe("pdf");
    expect(input.file_path.endsWith("alpha.pdf")).toBe(true);

    watcher.stop();
  });

  it("filters by extension when extensions is set", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "pdf-only",
      steps: [{ name: "record", type: "tool_call", tool: "noop" }],
    });

    const watcher = new FileDropWatcher({ workflowEngine: engine });
    watcher.register("pdf-only", {
      kind: "file_drop",
      path: dropDir,
      extensions: "pdf",
      stableForMs: 60,
    });

    writeFileSync(join(dropDir, "doc.txt"), "no");
    writeFileSync(join(dropDir, "doc.pdf"), "yes");
    await sleep(200);

    expect(exec.runs.length).toBe(1);
    const fired = exec.runs[0].input as { file_name: string };
    expect(fired.file_name).toBe("doc.pdf");

    watcher.stop();
  });

  it("stop() halts further dispatches", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "ingest",
      steps: [{ name: "record", type: "tool_call", tool: "noop" }],
    });

    const watcher = new FileDropWatcher({ workflowEngine: engine });
    watcher.register("ingest", { kind: "file_drop", path: dropDir, stableForMs: 60 });
    watcher.stop();

    writeFileSync(join(dropDir, "drop.txt"), "x");
    await sleep(150);

    expect(exec.runs).toEqual([]);
  });
});
