import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMorningDigest } from "../autopilot/digest.js";
import { recordTokenUsage } from "../db/autopilot-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, updateProjectTask } from "../db/task-queries.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildMorningDigest", () => {
  it("returns empty when there is nothing to report", () => {
    const digest = buildMorningDigest(db);
    expect(digest.empty).toBe(true);
    expect(digest.sections).toEqual([]);
  });

  it("groups completed, waiting, in-review, errored, and budget-deferred tasks", () => {
    const done = createProjectTask(db, { title: "Shipped it" });
    updateProjectTask(db, done.id, { status: "done" });

    const question = createProjectTask(db, { title: "Need input" });
    updateProjectTask(db, question.id, { status: "blocked", blocked_reason: "question" });

    const review = createProjectTask(db, { title: "Please review" });
    updateProjectTask(db, review.id, { status: "in_review" });

    const errored = createProjectTask(db, { title: "Crashed" });
    updateProjectTask(db, errored.id, { status: "blocked", blocked_reason: "error" });

    const budget = createProjectTask(db, { title: "Budget deferred" });
    updateProjectTask(db, budget.id, { status: "blocked", blocked_reason: "budget" });

    recordTokenUsage(db, { promptTokens: 500, completionTokens: 200 });

    const digest = buildMorningDigest(db);
    expect(digest.empty).toBe(false);
    expect(digest.sections.map((s) => s.heading.split(" (")[0])).toEqual([
      "Completed",
      "Waiting on you",
      "In review",
      "Errored",
      "Budget-deferred",
    ]);
    expect(digest.totalTokens).toBe(700);
    expect(digest.content).toContain("Shipped it");
    expect(digest.content).toContain("Need input");
    expect(digest.content).toContain("Token usage: 700");
  });

  it("excludes done tasks older than the window", () => {
    const old = createProjectTask(db, { title: "Stale done" });
    db.prepare("UPDATE project_tasks SET status = 'done', updated_at = datetime('now', '-48 hours') WHERE id = ?").run(
      old.id,
    );

    const digest = buildMorningDigest(db, 24);
    expect(digest.content).not.toContain("Stale done");
  });

  it("includes all question-blocked tasks regardless of age", () => {
    const old = createProjectTask(db, { title: "Old question" });
    db.prepare(
      "UPDATE project_tasks SET status = 'blocked', blocked_reason = 'question', updated_at = datetime('now', '-7 days') WHERE id = ?",
    ).run(old.id);

    const digest = buildMorningDigest(db, 24);
    expect(digest.content).toContain("Old question");
  });
});
