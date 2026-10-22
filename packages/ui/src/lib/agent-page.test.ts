/**
 * What an agent's page shows, worked out from its records: the section order
 * the agent chose (mirroring the directory plugin's), and which commitments
 * land in which section.
 */
import { describe, expect, it } from "vitest";
import type { StateRecordInfo } from "../api";
import {
  checkWhen,
  groupCommitments,
  lastMoved,
  pageOrder,
  pageSections,
  progressOf,
  recentMisses,
} from "./agent-page";

const NOW = new Date("2026-10-21T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function rec(id: string, data: Record<string, unknown>, extra: Partial<StateRecordInfo> = {}): StateRecordInfo {
  return {
    type: "commitment",
    id,
    scope: "global",
    data,
    version: 1,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    updatedBy: { kind: "agent", name: "planner" },
    ...extra,
  };
}

describe("the page's sections", () => {
  it("starts from the usual order, puts the named ones first, and leaves the hidden out", () => {
    expect(pageOrder(undefined)).toEqual(["about", "working", "waiting", "results", "docs", "misses"]);
    const extra = [{ id: "shortlist", title: "Shortlist", query: { type: "hotel" } }];
    expect(pageOrder({ order: ["shortlist", "docs", "nope"], hide: ["about", "results"], extra })).toEqual([
      "shortlist",
      "docs",
      "working",
      "waiting",
      "misses",
    ]);
    // An extra section not named in the order follows the usual ones.
    expect(pageOrder({ extra }).at(-1)).toBe("shortlist");
  });

  it("drops sections a hand edit left unusable", () => {
    expect(
      pageSections({ extra: [{ id: "ok", title: "Ok", query: { type: "doc" } }, { id: "bad" }, "nope", null] }),
    ).toEqual([{ id: "ok", title: "Ok", query: { type: "doc" } }]);
  });
});

describe("commitments by section", () => {
  it("puts open, waiting and recently done work in their sections, most recently moved first", () => {
    const groups = groupCommitments(
      [
        rec("a", { status: "open", updates: [{ at: daysAgo(3), text: "x" }] }),
        rec("b", { status: "open", updates: [{ at: daysAgo(1), text: "x" }] }),
        rec("c", { status: "waiting" }),
        rec("d", { status: "done", updates: [{ at: daysAgo(2), text: "Done." }] }),
        rec("e", { status: "done", updates: [{ at: daysAgo(20), text: "Done." }] }),
        rec("f", { status: "dropped" }),
        rec("g", { status: "open" }, { archivedAt: daysAgo(1) }),
      ],
      NOW,
    );
    expect(groups.working.map((r) => r.id)).toEqual(["b", "a"]);
    expect(groups.waiting.map((r) => r.id)).toEqual(["c"]);
    expect(groups.results.map((r) => r.id)).toEqual(["d"]);
  });

  it("keeps misses from the last two weeks, newest first", () => {
    const misses = recentMisses(
      [rec("old", { at: daysAgo(15) }), rec("new", { at: daysAgo(1) }), rec("mid", { at: daysAgo(5) })],
      NOW,
    );
    expect(misses.map((m) => m.id)).toEqual(["new", "mid"]);
  });

  it("reads progress as a count to draw or a step to say", () => {
    expect(progressOf({ value: 3, max: 5 })).toEqual({ value: 3, max: 5 });
    expect(progressOf("drafting")).toEqual({ label: "drafting" });
    expect(progressOf({ value: 1, max: 0 })).toBeUndefined();
    expect(progressOf(undefined)).toBeUndefined();
  });
});

describe("a commitment's check", () => {
  const hoursOn = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

  // The time in this machine's zone, as the page says it.
  const LOCAL = /^check \w{3}, \w{3} \d{1,2}, \d{2}:\d{2}, /;

  it("says the time it was read as and how far off, or that it's due, with the words as written", () => {
    const friday = checkWhen({ nextCheck: "Friday 9am", checkAt: hoursOn(51) }, NOW);
    expect(friday?.label).toMatch(new RegExp(`${LOCAL.source}in 2d 3h$`));
    expect(friday?.title).toBe('"Friday 9am", as written');
    // Not the words, which go stale: "in 2 minutes" an hour after it was due.
    const late = checkWhen({ nextCheck: "in 2 minutes", checkAt: hoursOn(-1) }, NOW);
    expect(late?.label).toMatch(new RegExp(`${LOCAL.source}due now$`));
    expect(late?.label).not.toContain("in 2 minutes");
    // Moved on by the directory after a check that changed nothing.
    expect(checkWhen({ checkAt: hoursOn(24) }, NOW)?.label).toMatch(new RegExp(`${LOCAL.source}in 1d$`));
  });

  it("doesn't count a check that changed nothing as the work moving, by the mark the directory leaves", () => {
    const r = rec("a", {
      updates: [
        { at: hoursOn(-1), text: "Checked; no change.", kind: "check" },
        { at: hoursOn(-30), text: "Asked the hotel." },
      ],
    });
    expect(lastMoved(r)).toBe(hoursOn(-30));
    // The same words without the mark are an update someone wrote.
    const copied = rec("b", { updates: [{ at: hoursOn(-1), text: "Checked; no change." }] });
    expect(lastMoved(copied)).toBe(hoursOn(-1));
  });

  it("lets a check on a change say itself, and marks text it couldn't read as a note", () => {
    const watching = checkWhen(
      { nextCheck: "when plan/lisbon changes", checkOn: { type: "plan" }, checkAt: hoursOn(168) },
      NOW,
    );
    expect(watching?.label).toBe("check when plan/lisbon changes");
    expect(watching?.title).toMatch(/^Or .*, if nothing changes by then$/);
    expect(checkWhen({ nextCheck: "after Sam replies" }, NOW)?.label).toBe("check after Sam replies (a note)");
    expect(checkWhen({}, NOW)).toBeUndefined();
  });
});
