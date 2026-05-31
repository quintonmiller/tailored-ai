import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  createWorkflowRun,
  deleteWorkflowRun,
  getWorkflowRun,
  getWorkflowStep,
  listInterruptibleRuns,
  listWorkflowRuns,
  listWorkflowSteps,
  recordWorkflowStep,
  updateWorkflowRun,
  updateWorkflowStep,
} from "../db/workflow-queries.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workflow_runs schema and queries", () => {
  it("creates a run with defaults and an id prefix", () => {
    const run = createWorkflowRun(db, {
      workflow_name: "review-pr",
      trigger: "http",
      input: { pr: 42 },
      generation: 3,
    });
    expect(run.id).toMatch(/^wfrun_[0-9a-f]{8}$/);
    expect(run.workflow_name).toBe("review-pr");
    expect(run.status).toBe("pending");
    expect(run.trigger).toBe("http");
    expect(run.input).toEqual({ pr: 42 });
    expect(run.output).toBeNull();
    expect(run.error).toBeNull();
    expect(run.started_at).toBeTruthy();
    expect(run.finished_at).toBeNull();
    expect(run.generation).toBe(3);
  });

  it("round-trips structured input via JSON", () => {
    const created = createWorkflowRun(db, {
      workflow_name: "wf",
      trigger: "programmatic",
      input: { nested: { items: [1, 2, 3] } },
    });
    const fetched = getWorkflowRun(db, created.id);
    expect(fetched?.input).toEqual({ nested: { items: [1, 2, 3] } });
  });

  it("rejects invalid status via CHECK constraint", () => {
    expect(() =>
      db
        .prepare("INSERT INTO workflow_runs (id, workflow_name, status, trigger, input_json) VALUES (?, ?, ?, ?, ?)")
        .run("wfrun_bad", "x", "BOGUS", "http", "{}"),
    ).toThrow(/CHECK constraint/);
  });

  it("updateWorkflowRun patches status, output, error, finished_at", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "cron" });
    const updated = updateWorkflowRun(db, run.id, {
      status: "completed",
      output: { result: "ok" },
      finished_at: "2026-05-03T10:00:00Z",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.output).toEqual({ result: "ok" });
    expect(updated?.finished_at).toBe("2026-05-03T10:00:00Z");
    expect(updated?.error).toBeNull();
  });

  it("updateWorkflowRun no-op patch returns current state", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const updated = updateWorkflowRun(db, run.id, {});
    expect(updated?.id).toBe(run.id);
  });

  it("listWorkflowRuns filters by name and status, ordered by started_at desc", () => {
    const a = createWorkflowRun(db, { workflow_name: "alpha", trigger: "http" });
    const b = createWorkflowRun(db, { workflow_name: "beta", trigger: "http" });
    updateWorkflowRun(db, a.id, { status: "completed" });
    updateWorkflowRun(db, b.id, { status: "failed" });
    const all = listWorkflowRuns(db);
    expect(all).toHaveLength(2);
    const onlyAlpha = listWorkflowRuns(db, { workflow_name: "alpha" });
    expect(onlyAlpha.map((r) => r.id)).toEqual([a.id]);
    const onlyFailed = listWorkflowRuns(db, { status: "failed" });
    expect(onlyFailed.map((r) => r.id)).toEqual([b.id]);
  });

  it("deleteWorkflowRun cascades to its steps", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    recordWorkflowStep(db, { run_id: run.id, step_name: "s1", step_type: "shell" });
    expect(listWorkflowSteps(db, run.id)).toHaveLength(1);
    expect(deleteWorkflowRun(db, run.id)).toBe(true);
    expect(getWorkflowRun(db, run.id)).toBeNull();
    expect(listWorkflowSteps(db, run.id)).toHaveLength(0);
  });

  it("listInterruptibleRuns returns pending and running rows", () => {
    const a = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const b = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const c = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    updateWorkflowRun(db, a.id, { status: "running" });
    updateWorkflowRun(db, c.id, { status: "completed" });
    const interruptible = listInterruptibleRuns(db)
      .map((r) => r.id)
      .sort();
    expect(interruptible).toEqual([a.id, b.id].sort());
  });
});

describe("workflow_steps schema and queries", () => {
  it("records a step with defaults", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const step = recordWorkflowStep(db, {
      run_id: run.id,
      step_name: "research",
      step_type: "agent_run",
    });
    expect(step.id).toMatch(/^wfstep_[0-9a-f]{8}$/);
    expect(step.status).toBe("pending");
    expect(step.attempt).toBe(1);
    expect(step.parent_step_id).toBeNull();
    expect(step.output).toBeNull();
    expect(step.created_at).toBeTruthy();
  });

  it("rejects invalid step status via CHECK constraint", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    expect(() =>
      db
        .prepare("INSERT INTO workflow_steps (id, run_id, step_name, step_type, status) VALUES (?, ?, ?, ?, ?)")
        .run("wfstep_bad", run.id, "x", "shell", "BOGUS"),
    ).toThrow(/CHECK constraint/);
  });

  it("foreign key to workflow_runs is enforced", () => {
    expect(() =>
      recordWorkflowStep(db, {
        run_id: "wfrun_doesnotexist",
        step_name: "x",
        step_type: "shell",
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("updateWorkflowStep patches status/output/timing/attempt", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const step = recordWorkflowStep(db, {
      run_id: run.id,
      step_name: "s",
      step_type: "tool_call",
    });
    const updated = updateWorkflowStep(db, step.id, {
      status: "completed",
      output: { stdout: "hi" },
      attempt: 2,
      started_at: "2026-05-03T10:00:00Z",
      finished_at: "2026-05-03T10:00:01Z",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.output).toEqual({ stdout: "hi" });
    expect(updated?.attempt).toBe(2);
    expect(updated?.started_at).toBe("2026-05-03T10:00:00Z");
    expect(updated?.finished_at).toBe("2026-05-03T10:00:01Z");
  });

  it("blocked_on is queryable for queue surfacing", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const step = recordWorkflowStep(db, {
      run_id: run.id,
      step_name: "s",
      step_type: "agent_run",
      blocked_on: "agent:researcher",
    });
    const fetched = getWorkflowStep(db, step.id);
    expect(fetched?.blocked_on).toBe("agent:researcher");
    updateWorkflowStep(db, step.id, { blocked_on: null });
    expect(getWorkflowStep(db, step.id)?.blocked_on).toBeNull();
  });

  it("listWorkflowSteps returns steps ordered by creation", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const first = recordWorkflowStep(db, { run_id: run.id, step_name: "first", step_type: "shell" });
    const second = recordWorkflowStep(db, { run_id: run.id, step_name: "second", step_type: "shell" });
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it("supports nested steps via parent_step_id (loop/parallel children)", () => {
    const run = createWorkflowRun(db, { workflow_name: "wf", trigger: "http" });
    const parent = recordWorkflowStep(db, { run_id: run.id, step_name: "p", step_type: "loop" });
    const child = recordWorkflowStep(db, {
      run_id: run.id,
      step_name: "p[0]",
      step_type: "tool_call",
      parent_step_id: parent.id,
    });
    expect(child.parent_step_id).toBe(parent.id);
    const all = listWorkflowSteps(db, run.id);
    expect(all).toHaveLength(2);
  });
});
