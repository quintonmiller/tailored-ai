import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCoreMemory } from "../db/core-memory-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, updateProjectTask } from "../db/task-queries.js";
import { appendTickLog } from "../db/tick-log-queries.js";
import { buildTickContext, renderTickSituation } from "../exploratory/tick-context.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildTickContext", () => {
  it("returns empty sections for a fresh DB", () => {
    const ctx = buildTickContext(db, "default", null);
    expect(ctx.backlog.untouched).toHaveLength(0);
    expect(ctx.backlog.staleInReview).toHaveLength(0);
    expect(ctx.exploration.openQuestions).toHaveLength(0);
    expect(ctx.outcomes.ticks).toBe(0);
  });

  it("includes top backlog tasks ordered by updated_at", () => {
    createProjectTask(db, { title: "Older task", description: "first" });
    createProjectTask(db, { title: "Newer task", description: "second" });
    const ctx = buildTickContext(db, "default", null, { backlogLimit: 5 });
    expect(ctx.backlog.untouched.length).toBeGreaterThan(0);
    expect(ctx.backlog.untouched.some((t) => t.title === "Older task")).toBe(true);
  });

  it("respects backlogLimit", () => {
    for (let i = 0; i < 10; i++) {
      createProjectTask(db, { title: `Task ${i}`, description: "" });
    }
    const ctx = buildTickContext(db, "default", null, { backlogLimit: 3 });
    expect(ctx.backlog.untouched).toHaveLength(3);
  });

  it("flags stale in_review tasks past the cutoff", () => {
    const t = createProjectTask(db, { title: "Stuck review", description: "" });
    updateProjectTask(db, t.id, { status: "in_review" });
    // Backdate updated_at so it counts as stale.
    db.prepare("UPDATE project_tasks SET updated_at = datetime('now','-3 days') WHERE id = ?").run(t.id);
    const ctx = buildTickContext(db, "default", null, { staleReviewDays: 1 });
    expect(ctx.backlog.staleInReview.some((s) => s.id === t.id)).toBe(true);
  });

  it("excludes recent in_review tasks", () => {
    const t = createProjectTask(db, { title: "Just submitted", description: "" });
    updateProjectTask(db, t.id, { status: "in_review" });
    const ctx = buildTickContext(db, "default", null, { staleReviewDays: 1 });
    expect(ctx.backlog.staleInReview).toHaveLength(0);
  });

  it("pulls open_questions and active_threads from core_memory", () => {
    setCoreMemory(db, {
      agent: "default",
      project_id: null,
      section: "open_questions",
      content: "Q1: about X\nQ2: about Y",
    });
    setCoreMemory(db, {
      agent: "default",
      project_id: null,
      section: "active_threads",
      content: "Researching iMessage path",
    });
    const ctx = buildTickContext(db, "default", null);
    expect(ctx.exploration.openQuestions).toContain("Q1: about X");
    expect(ctx.exploration.openQuestions).toContain("Q2: about Y");
    expect(ctx.exploration.staleThreads).toContain("Researching iMessage path");
  });

  it("includes outcomes window with stagnation flag when all-noop", () => {
    for (let i = 0; i < 10; i++) {
      appendTickLog(db, { tick_id: `xrun_${i}`, agent: "default", kind: "noop" });
    }
    const ctx = buildTickContext(db, "default", null, { outcomesWindowTicks: 10 });
    expect(ctx.outcomes.ticks).toBe(10);
    expect(ctx.outcomes.stagnation).toBe(true);
  });

  it("respects project_id scoping for tasks", () => {
    db.prepare("INSERT INTO projects (id, title) VALUES (?, ?), (?, ?)").run("proj_a", "A", "proj_b", "B");
    createProjectTask(db, { title: "Project A task", description: "", project_id: "proj_a" });
    createProjectTask(db, { title: "Project B task", description: "", project_id: "proj_b" });
    const ctxA = buildTickContext(db, "default", "proj_a");
    expect(ctxA.backlog.untouched.some((t) => t.title === "Project A task")).toBe(true);
    expect(ctxA.backlog.untouched.some((t) => t.title === "Project B task")).toBe(false);
  });
});

describe("renderTickSituation", () => {
  it("renders the candidate menu even with empty context", () => {
    const ctx = buildTickContext(db, "default", null);
    const rendered = renderTickSituation(ctx);
    expect(rendered).toContain("Your move this tick");
    expect(rendered).toMatch(/A\. `delegate/);
    expect(rendered).toMatch(/F\. `Sleep`/);
  });

  it("surfaces backlog titles into the rendered block", () => {
    createProjectTask(db, { title: "Add iMessage channel", description: "needs scoping" });
    const ctx = buildTickContext(db, "default", null);
    const rendered = renderTickSituation(ctx);
    expect(rendered).toContain("Add iMessage channel");
  });

  it("calls out stagnation when present", () => {
    for (let i = 0; i < 10; i++) {
      appendTickLog(db, { tick_id: `xrun_${i}`, agent: "default", kind: "noop" });
    }
    const ctx = buildTickContext(db, "default", null, { outcomesWindowTicks: 10 });
    const rendered = renderTickSituation(ctx);
    expect(rendered.toLowerCase()).toContain("stagnation");
  });

  it("warns against writing 'tick: idle' notes after Sleep", () => {
    const ctx = buildTickContext(db, "default", null);
    const rendered = renderTickSituation(ctx);
    expect(rendered.toLowerCase()).toContain("do not write a recall note");
  });
});
