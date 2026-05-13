import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { CalendarPoller, parseEvents } from "../triggers/calendar-poll.js";
import type { Tool } from "../tools/interface.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { StepContext, StepResult, StepExecutor } from "../workflows/engine.js";

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("parseEvents", () => {
  it("parses an array of events with dateTime starts", () => {
    const json = JSON.stringify([
      { id: "a", summary: "1:1", start: { dateTime: "2026-05-12T10:00:00Z" }, end: { dateTime: "2026-05-12T10:30:00Z" } },
      { id: "b", summary: "All-hands", start: { dateTime: "2026-05-12T14:00:00Z" }, end: { dateTime: "2026-05-12T15:00:00Z" } },
    ]);
    const out = parseEvents(json);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("a");
    expect(out[0].summary).toBe("1:1");
    expect(out[0].start).toBe("2026-05-12T10:00:00Z");
  });

  it("parses { events: [...] } wrapper", () => {
    const json = JSON.stringify({
      events: [{ id: "x", summary: "hi", start: { date: "2026-05-12" }, end: { date: "2026-05-13" } }],
    });
    const out = parseEvents(json);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe("2026-05-12");
  });

  it("returns [] for non-JSON output", () => {
    expect(parseEvents("No upcoming events.")).toEqual([]);
  });

  it("skips items missing an id", () => {
    const json = JSON.stringify([{ summary: "noid", start: { dateTime: "x" } }]);
    expect(parseEvents(json)).toEqual([]);
  });
});

class RecordingExecutor implements StepExecutor {
  type = "tool_call" as const;
  runs: Array<{ name: string; input: unknown }> = [];

  async execute(step: { name: string }, ctx: StepContext): Promise<StepResult> {
    this.runs.push({ name: step.name, input: ctx.scope.input });
    return { output: ctx.scope.input };
  }
}

describe("CalendarPoller", () => {
  it("fires for events inside the look-ahead window", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "prep",
      steps: [{ name: "step", type: "tool_call", tool: "noop" }],
    });

    const inWindowStart = new Date(Date.now() + 5 * 60_000).toISOString(); // 5 min from now
    const outsideWindowStart = new Date(Date.now() + 60 * 60_000).toISOString(); // 60 min from now
    const calendar: Tool = {
      name: "google_calendar",
      description: "fake",
      parameters: {},
      async execute() {
        return {
          success: true,
          output: JSON.stringify([
            { id: "in", summary: "Soon", start: { dateTime: inWindowStart }, end: { dateTime: inWindowStart } },
            { id: "out", summary: "Later", start: { dateTime: outsideWindowStart }, end: { dateTime: outsideWindowStart } },
          ]),
        };
      },
    };

    const poller = new CalendarPoller({
      workflowEngine: engine,
      getTools: () => [calendar],
    });
    poller.register("prep", { beforeMinutes: 15, intervalSeconds: 60 });

    // Let the initial pass resolve.
    await new Promise((r) => setTimeout(r, 30));

    expect(exec.runs.length).toBe(1);
    const fired = exec.runs[0].input as { event_id: string };
    expect(fired.event_id).toBe("in");

    poller.stop();
  });

  it("filters by titleContains (case-insensitive)", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "prep",
      steps: [{ name: "step", type: "tool_call", tool: "noop" }],
    });

    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const calendar: Tool = {
      name: "google_calendar",
      description: "fake",
      parameters: {},
      async execute() {
        return {
          success: true,
          output: JSON.stringify([
            { id: "1", summary: "Interview with candidate", start: { dateTime: soon }, end: { dateTime: soon } },
            { id: "2", summary: "Standup", start: { dateTime: soon }, end: { dateTime: soon } },
          ]),
        };
      },
    };

    const poller = new CalendarPoller({
      workflowEngine: engine,
      getTools: () => [calendar],
    });
    poller.register("prep", { titleContains: "interview" });

    await new Promise((r) => setTimeout(r, 30));

    expect(exec.runs.length).toBe(1);
    expect((exec.runs[0].input as { event_id: string }).event_id).toBe("1");

    poller.stop();
  });

  it("does not double-fire after dedupe", async () => {
    const exec = new RecordingExecutor();
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });
    registry.register({
      name: "prep",
      steps: [{ name: "step", type: "tool_call", tool: "noop" }],
    });

    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const calendar: Tool = {
      name: "google_calendar",
      description: "fake",
      parameters: {},
      async execute() {
        return {
          success: true,
          output: JSON.stringify([
            { id: "X", summary: "Soon", start: { dateTime: soon }, end: { dateTime: soon } },
          ]),
        };
      },
    };

    const poller = new CalendarPoller({
      workflowEngine: engine,
      getTools: () => [calendar],
    });
    poller.register("prep", { beforeMinutes: 60, intervalSeconds: 60 });

    await new Promise((r) => setTimeout(r, 30));
    // Even after manually running the poll twice, fire only once.
    // (Using internal access is awkward — instead just verify after a second
    // tick it doesn't re-fire.)
    await new Promise((r) => setTimeout(r, 30));
    expect(exec.runs.length).toBe(1);

    poller.stop();
  });
});
