import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  perWorkflowMetrics,
  stepHotspots,
  summarize,
} from "../workflows/analytics.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function seedRun(opts: {
  id: string;
  name: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  steps?: Array<{ name: string; type: string; status: string }>;
}) {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_name, status, trigger, started_at, finished_at)
     VALUES (?, ?, ?, 'programmatic', ?, ?)`,
  ).run(opts.id, opts.name, opts.status, opts.startedAt, opts.finishedAt ?? null);
  for (const s of opts.steps ?? []) {
    db.prepare(
      `INSERT INTO workflow_steps (id, run_id, step_name, step_type, status, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `${opts.id}:${s.name}`,
      opts.id,
      s.name,
      s.type,
      s.status,
      opts.startedAt,
      opts.finishedAt ?? null,
    );
  }
}

describe("workflow analytics", () => {
  it("summarize counts by status and computes success rate", () => {
    const past = new Date(Date.now() - 60_000).toISOString(); // 1 min ago — inside the default 7d window
    seedRun({ id: "r1", name: "a", status: "completed", startedAt: past, finishedAt: past });
    seedRun({ id: "r2", name: "a", status: "completed", startedAt: past, finishedAt: past });
    seedRun({ id: "r3", name: "a", status: "failed", startedAt: past });
    seedRun({ id: "r4", name: "b", status: "cancelled", startedAt: past });

    const s = summarize(db);
    expect(s.totalRuns).toBe(4);
    expect(s.byStatus).toEqual({ completed: 2, failed: 1, cancelled: 1 });
    expect(s.successRate).toBe(0.5);
  });

  it("perWorkflowMetrics groups counts and computes percentile durations", () => {
    const start = "2026-05-01T10:00:00.000Z";
    const fin1 = "2026-05-01T10:00:01.000Z"; // 1s
    const fin2 = "2026-05-01T10:00:03.000Z"; // 3s
    seedRun({ id: "r1", name: "fast", status: "completed", startedAt: start, finishedAt: fin1 });
    seedRun({ id: "r2", name: "fast", status: "completed", startedAt: start, finishedAt: fin2 });
    seedRun({ id: "r3", name: "fast", status: "failed", startedAt: start });

    const m = perWorkflowMetrics(db, { since: "2026-04-01T00:00:00.000Z" });
    expect(m).toHaveLength(1);
    const row = m[0];
    expect(row.workflow_name).toBe("fast");
    expect(row.total).toBe(3);
    expect(row.completed).toBe(2);
    expect(row.failed).toBe(1);
    expect(row.avgDurationMs).toBe(2000);
    expect(row.p50DurationMs).toBe(3000);
  });

  it("stepHotspots surfaces steps that have failures", () => {
    const start = "2026-05-01T10:00:00.000Z";
    seedRun({
      id: "r1",
      name: "wf",
      status: "failed",
      startedAt: start,
      steps: [
        { name: "ok", type: "tool_call", status: "completed" },
        { name: "boom", type: "shell", status: "failed" },
      ],
    });
    seedRun({
      id: "r2",
      name: "wf",
      status: "failed",
      startedAt: start,
      steps: [
        { name: "boom", type: "shell", status: "failed" },
      ],
    });

    const hs = stepHotspots(db, { since: "2026-04-01T00:00:00.000Z" });
    expect(hs).toHaveLength(1);
    expect(hs[0].step_name).toBe("boom");
    expect(hs[0].failures).toBe(2);
  });

  it("window filters out rows outside the range", () => {
    seedRun({ id: "old", name: "wf", status: "completed", startedAt: "2024-01-01T00:00:00.000Z", finishedAt: "2024-01-01T00:00:01.000Z" });
    seedRun({ id: "new", name: "wf", status: "completed", startedAt: "2026-05-01T00:00:00.000Z", finishedAt: "2026-05-01T00:00:01.000Z" });

    const s = summarize(db, { since: "2026-04-01T00:00:00.000Z" });
    expect(s.totalRuns).toBe(1);
  });
});
