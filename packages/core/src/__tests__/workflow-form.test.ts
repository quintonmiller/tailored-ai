import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFormPendingByStep, listFormPending } from "../db/form-queries.js";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { FormExecutor } from "../workflows/executors/form.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({ db, registry });
  engine.registerExecutor(new FormExecutor({ registry: engine.forms, log: () => {} }));
});

afterEach(() => {
  db.close();
});

describe("FormExecutor", () => {
  it("pauses the run until submit() resolves, then returns the values", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ask",
          type: "form",
          prompt: "What's your name?",
          fields: { name: { type: "string", required: true } },
        },
      ],
    });

    // Kick off the run; don't await yet — it's waiting on the form.
    const runPromise = engine.runWorkflow("wf", { topic: "intro" });

    // Wait for the form to be registered.
    let pending = listFormPending(db, { status: "pending" });
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      pending = listFormPending(db, { status: "pending" });
    }
    expect(pending).toHaveLength(1);
    expect(pending[0].step_name).toBe("ask");
    expect(pending[0].prompt).toBe("What's your name?");

    // Submit valid values.
    const result = engine.forms.submit(pending[0].run_id, "ask", { name: "alice" });
    expect(result.ok).toBe(true);

    const finished = await runPromise;
    expect(finished.status).toBe("completed");
    expect(finished.output).toEqual({ fields: { name: "alice" }, formId: pending[0].id });
    const persisted = getFormPendingByStep(db, finished.id, "ask");
    expect(persisted?.status).toBe("submitted");
    expect(persisted?.submitted).toEqual({ name: "alice" });
  });

  it("rejects submissions that fail schema validation", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ask",
          type: "form",
          prompt: "Pick one",
          fields: { choice: { type: "string", enum: ["yes", "no"], required: true } },
        },
      ],
    });
    const runPromise = engine.runWorkflow("wf");
    let pending = listFormPending(db, { status: "pending" });
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      pending = listFormPending(db, { status: "pending" });
    }
    const bad = engine.forms.submit(pending[0].run_id, "ask", { choice: "maybe" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.details?.[0]).toMatch(/must be one of/);
    }

    // Good submit unblocks.
    const good = engine.forms.submit(pending[0].run_id, "ask", { choice: "yes" });
    expect(good.ok).toBe(true);
    const finished = await runPromise;
    expect(finished.status).toBe("completed");
  });

  it("times out the form when timeoutMs elapses", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ask",
          type: "form",
          prompt: "Quick — what?",
          fields: { name: { type: "string" } },
          timeoutMs: 30,
        },
      ],
    });
    const finished = await engine.runWorkflow("wf");
    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/timed out/);
    const persisted = getFormPendingByStep(db, finished.id, "ask");
    expect(persisted?.status).toBe("expired");
  });

  it("synthesizes defaults under dry-run instead of pausing", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ask",
          type: "form",
          prompt: "Name & age",
          fields: {
            name: { type: "string", default: "anon" },
            age: { type: "number" },
            opt: { type: "boolean" },
          },
        },
      ],
    });
    const finished = await engine.runWorkflow("wf", {}, "programmatic", { dryRun: true });
    expect(finished.status).toBe("completed");
    expect(finished.output).toEqual({
      fields: { name: "anon", age: 0, opt: false },
      formId: null,
      dryRun: true,
    });
  });

  it("cancels the form when the run is cancelled mid-wait", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ask",
          type: "form",
          prompt: "Wait forever",
          fields: { x: { type: "string" } },
          timeoutMs: 60_000,
        },
      ],
    });
    const runPromise = engine.runWorkflow("wf");
    let pending = listFormPending(db, { status: "pending" });
    for (let i = 0; i < 20 && pending.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      pending = listFormPending(db, { status: "pending" });
    }
    expect(pending).toHaveLength(1);
    const runId = pending[0].run_id;
    engine.cancel(runId);
    const finished = await runPromise;
    expect(finished.status).toBe("cancelled");
    const persisted = getFormPendingByStep(db, runId, "ask");
    expect(persisted?.status).toBe("cancelled");
  });
});
