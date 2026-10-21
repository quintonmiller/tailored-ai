/**
 * The one line an agent reads per event. Written when the event arrives, so
 * these are what a digest delivered hours later will still say.
 */
import { describe, expect, it } from "vitest";
import type { StateChange } from "../state/types.js";
import { describeEvent, renderEventLines } from "../subscriptions/describe.js";

const base: StateChange = {
  type: "plan",
  id: "trip",
  scope: "global",
  op: "update",
  version: 2,
  actor: { kind: "user", name: "owner" },
  source: { surface: "web" },
  at: "2026-01-01T09:30:00.000Z",
};

describe("describeEvent", () => {
  it("says which fields of a record changed, and from what to what", () => {
    expect(
      describeEvent("state.changed", {
        ...base,
        before: { name: "Trip", status: "draft", owner: "sam" },
        after: { name: "Trip", status: "active", due: "friday" },
      }),
    ).toBe("plan/trip updated by a person (web): status: draft → active; owner removed; due set to friday");
  });

  it("names the agent that made a change, and describes creates and deletes", () => {
    const byAgent = { ...base, actor: { kind: "agent" as const, name: "planner" }, source: undefined };
    expect(describeEvent("state.changed", { ...byAgent, op: "create", after: { name: "Trip" } })).toBe(
      'plan/trip created by planner: {"name":"Trip"}',
    );
    expect(describeEvent("state.changed", { ...byAgent, op: "delete", before: { name: "Trip" } })).toBe(
      "plan/trip deleted by planner",
    );
  });

  it("says when a record was archived, and why, or brought back", () => {
    const same = { before: { name: "Trip" }, after: { name: "Trip" } };
    expect(
      describeEvent("state.changed", { ...base, ...same, lifecycle: "archived", archiveReason: "trip is over" }),
    ).toBe("plan/trip archived by a person (web): trip is over");
    expect(describeEvent("state.changed", { ...base, ...same, lifecycle: "unarchived" })).toBe(
      "plan/trip unarchived by a person (web)",
    );
    expect(describeEvent("state.changed", { ...base, ...same, after: { name: "New" }, lifecycle: "unarchived" })).toBe(
      "plan/trip unarchived by a person (web): name: Trip → New",
    );
  });

  it("caps how many fields and how much of each value it shows", () => {
    const before = Object.fromEntries("abcdefg".split("").map((k) => [k, 0]));
    const after = Object.fromEntries("abcdefg".split("").map((k) => [k, "x".repeat(60)]));
    const line = describeEvent("state.changed", { ...base, before, after });
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line).toContain(`a: 0 → ${"x".repeat(39)}…`);
    const shown = (line.match(/: 0 → /g) ?? []).length;
    expect(line.endsWith(`; +${7 - shown} more`)).toBe(true);
  });

  it("falls back to the event name and its payload for anything else", () => {
    expect(describeEvent("task.created", { taskId: "t1", projectId: "p" })).toBe(
      'task.created: {"taskId":"t1","projectId":"p"}',
    );
  });
});

describe("renderEventLines", () => {
  it("lists events oldest first, then the subscription's instructions", () => {
    const lines = renderEventLines(
      {
        deliver: "batch",
        instructions: "Reconcile the calendar.",
        events: [
          { event: "state.changed", summary: "plan/trip updated", at: "2026-01-01T09:30:00.000Z" },
          { event: "state.changed", summary: "plan/trip deleted", at: "2026-01-01T09:31:00.000Z" },
        ],
      },
      "UTC",
    );
    expect(lines).toEqual([
      "What happened (2, oldest first):",
      "- Thu, Jan 1, 09:30: plan/trip updated",
      "- Thu, Jan 1, 09:31: plan/trip deleted",
      "",
      "Your instructions for this subscription: Reconcile the calendar.",
    ]);
  });
});
