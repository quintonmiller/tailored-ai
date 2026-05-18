import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCoreMemory,
  CORE_MEMORY_SECTIONS,
  clearCoreMemorySection,
  getCoreMemory,
  getCoreMemorySection,
  removeCoreMemoryLine,
  renderCoreMemory,
  setCoreMemory,
} from "../db/core-memory-queries.js";
import {
  filterUnseenIds,
  isEmailSeen,
  listEmailSeen,
  markEmailSeen,
  updateEmailDisposition,
} from "../db/email-seen-queries.js";
import { initDatabase } from "../db/schema.js";
import {
  appendTickLog,
  getTickOutcomesWindow,
  listTickLogs,
  sweepOldTickLogs,
} from "../db/tick-log-queries.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("core_memory", () => {
  it("sets and retrieves a section atomically", () => {
    setCoreMemory(db, {
      agent: "default",
      project_id: null,
      section: "persona",
      content: "Calm. Direct. Skeptical of own conclusions.",
      updated_by: "test",
    });
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "persona");
    expect(row?.content).toContain("Calm");
    expect(row?.updated_by).toBe("test");
  });

  it("upserts on (agent, project_id, section)", () => {
    setCoreMemory(db, { agent: "default", project_id: null, section: "persona", content: "v1" });
    setCoreMemory(db, { agent: "default", project_id: null, section: "persona", content: "v2" });
    const all = getCoreMemory(db, { agent: "default", project_id: null });
    expect(all.filter((r) => r.section === "persona")).toHaveLength(1);
    expect(all.find((r) => r.section === "persona")?.content).toBe("v2");
  });

  it("falls back to global section when project-specific is missing", () => {
    setCoreMemory(db, { agent: "default", project_id: null, section: "persona", content: "global" });
    const got = getCoreMemorySection(
      db,
      { agent: "default", project_id: "proj_x" },
      "persona",
    );
    expect(got?.content).toBe("global");
    expect(got?.project_id).toBeNull();
  });

  it("prefers project-specific section over global", () => {
    setCoreMemory(db, { agent: "default", project_id: null, section: "persona", content: "global" });
    setCoreMemory(db, { agent: "default", project_id: "proj_x", section: "persona", content: "project" });
    const got = getCoreMemorySection(db, { agent: "default", project_id: "proj_x" }, "persona");
    expect(got?.content).toBe("project");
    expect(got?.project_id).toBe("proj_x");
  });

  it("appends to a list section and trims oldest lines past maxBytes", () => {
    for (let i = 0; i < 50; i++) {
      appendCoreMemory(db, {
        agent: "default",
        project_id: null,
        section: "active_threads",
        item: `line ${i} ${"x".repeat(80)}`,
        maxBytes: 500,
      });
    }
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "active_threads")!;
    expect(row.content.length).toBeLessThanOrEqual(500);
    // Oldest lines should have been trimmed.
    expect(row.content).not.toContain("line 0 ");
    expect(row.content).toContain("line 49 ");
  });

  it("removes a specific line by substring match", () => {
    appendCoreMemory(db, { agent: "default", project_id: null, section: "open_questions", item: "Q: about X" });
    appendCoreMemory(db, { agent: "default", project_id: null, section: "open_questions", item: "Q: about Y" });
    removeCoreMemoryLine(db, { agent: "default", project_id: null }, "open_questions", "about X");
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "open_questions")!;
    expect(row.content).not.toContain("about X");
    expect(row.content).toContain("about Y");
  });

  it("clearCoreMemorySection removes the row entirely", () => {
    setCoreMemory(db, { agent: "default", project_id: null, section: "user_state", content: "x" });
    expect(clearCoreMemorySection(db, { agent: "default", project_id: null }, "user_state")).toBe(true);
    expect(getCoreMemorySection(db, { agent: "default", project_id: null }, "user_state")).toBeNull();
  });

  it("renderCoreMemory emits sections in stable order and skips empties", () => {
    setCoreMemory(db, { agent: "d", project_id: null, section: "persona", content: "P" });
    setCoreMemory(db, { agent: "d", project_id: null, section: "open_questions", content: "Q" });
    const rows = getCoreMemory(db, { agent: "d", project_id: null });
    const rendered = renderCoreMemory(rows);
    expect(rendered.indexOf("## persona")).toBeLessThan(rendered.indexOf("## open_questions"));
    expect(rendered).not.toContain("## recent_summary");
  });

  it("renderCoreMemory respects maxBytes budget", () => {
    setCoreMemory(db, { agent: "d", project_id: null, section: "persona", content: "x".repeat(200) });
    setCoreMemory(db, { agent: "d", project_id: null, section: "user_state", content: "y".repeat(200) });
    setCoreMemory(db, { agent: "d", project_id: null, section: "recent_summary", content: "z".repeat(200) });
    const rendered = renderCoreMemory(getCoreMemory(db, { agent: "d", project_id: null }), { maxBytes: 300 });
    // persona fits; the rest may be partially included or skipped.
    expect(rendered.length).toBeLessThanOrEqual(300);
    expect(rendered).toContain("## persona");
  });

  it("CORE_MEMORY_SECTIONS lists every documented section", () => {
    expect(CORE_MEMORY_SECTIONS).toEqual([
      "persona", "active_threads", "recent_summary", "open_questions", "user_state",
    ]);
  });
});

describe("tick_log", () => {
  it("appends and lists in reverse-chronological order", () => {
    appendTickLog(db, { tick_id: "xrun_a", agent: "default", kind: "start" });
    appendTickLog(db, { tick_id: "xrun_a", agent: "default", kind: "material", summary: "did a thing" });
    appendTickLog(db, { tick_id: "xrun_b", agent: "default", kind: "noop" });
    const all = listTickLogs(db, { agent: "default" });
    expect(all).toHaveLength(3);
    expect(all[0].kind).toBe("noop");
    expect(all[2].kind).toBe("start");
  });

  it("serializes object payloads as JSON", () => {
    appendTickLog(db, {
      tick_id: "xrun_a",
      agent: "default",
      kind: "delegate",
      payload: { specialist: "researcher", task: "look at X" },
    });
    const row = listTickLogs(db, { tick_id: "xrun_a" })[0];
    expect(JSON.parse(row.payload!)).toEqual({ specialist: "researcher", task: "look at X" });
  });

  it("getTickOutcomesWindow flags stagnation when no material ticks in window", () => {
    for (let i = 0; i < 10; i++) {
      appendTickLog(db, { tick_id: `xrun_${i}`, agent: "default", kind: "start" });
      appendTickLog(db, { tick_id: `xrun_${i}`, agent: "default", kind: "noop" });
    }
    const outcome = getTickOutcomesWindow(db, "default", 10);
    expect(outcome.ticks).toBe(10);
    expect(outcome.materialTicks).toBe(0);
    expect(outcome.noopTicks).toBe(10);
    expect(outcome.stagnation).toBe(true);
  });

  it("getTickOutcomesWindow does NOT flag stagnation when material ticks exist", () => {
    for (let i = 0; i < 10; i++) {
      const kind = i % 3 === 0 ? "material" : "noop";
      appendTickLog(db, { tick_id: `xrun_${i}`, agent: "default", kind });
    }
    const outcome = getTickOutcomesWindow(db, "default", 10);
    expect(outcome.materialTicks).toBeGreaterThan(0);
    expect(outcome.stagnation).toBe(false);
  });

  it("sweepOldTickLogs removes rows older than the cutoff", () => {
    appendTickLog(db, { tick_id: "old", agent: "default", kind: "start" });
    // Backdate the row.
    db.prepare("UPDATE tick_log SET created_at = datetime('now','-60 days') WHERE tick_id = 'old'").run();
    appendTickLog(db, { tick_id: "new", agent: "default", kind: "start" });
    const removed = sweepOldTickLogs(db, 30);
    expect(removed).toBe(1);
    expect(listTickLogs(db).some((r) => r.tick_id === "old")).toBe(false);
    expect(listTickLogs(db).some((r) => r.tick_id === "new")).toBe(true);
  });
});

describe("email_seen", () => {
  it("marks and detects a single message", () => {
    expect(isEmailSeen(db, "msg_a")).toBe(false);
    markEmailSeen(db, { message_id: "msg_a", from_addr: "noreply@example.com", subject: "Test" });
    expect(isEmailSeen(db, "msg_a")).toBe(true);
  });

  it("filters unseen ids from a batch", () => {
    markEmailSeen(db, { message_id: "msg_a" });
    markEmailSeen(db, { message_id: "msg_b" });
    const unseen = filterUnseenIds(db, ["msg_a", "msg_b", "msg_c", "msg_d"]);
    expect(unseen).toEqual(["msg_c", "msg_d"]);
  });

  it("filterUnseenIds returns empty array when input is empty", () => {
    expect(filterUnseenIds(db, [])).toEqual([]);
  });

  it("re-marking the same id updates disposition without duplicate row", () => {
    markEmailSeen(db, { message_id: "msg_a", disposition: "noted" });
    markEmailSeen(db, { message_id: "msg_a", disposition: "ignored" });
    const all = listEmailSeen(db);
    expect(all).toHaveLength(1);
    expect(all[0].disposition).toBe("ignored");
  });

  it("updateEmailDisposition updates and returns the row", () => {
    markEmailSeen(db, { message_id: "msg_a" });
    const updated = updateEmailDisposition(db, "msg_a", "archived", "auto-archived");
    expect(updated?.disposition).toBe("archived");
    expect(updated?.notes).toBe("auto-archived");
  });

  it("updateEmailDisposition returns null for unknown id", () => {
    expect(updateEmailDisposition(db, "nope", "ignored")).toBeNull();
  });

  it("hashes subject for stable dedup signature", () => {
    markEmailSeen(db, { message_id: "msg_a", subject: "Important: Q3 results" });
    markEmailSeen(db, { message_id: "msg_b", subject: "IMPORTANT: q3 results  " });
    const a = listEmailSeen(db).find((r) => r.message_id === "msg_a")!;
    const b = listEmailSeen(db).find((r) => r.message_id === "msg_b")!;
    // After trim+lowercase, both subjects produce the same hash.
    expect(a.subject_hash).toBe(b.subject_hash);
  });

  it("listEmailSeen filters by disposition", () => {
    markEmailSeen(db, { message_id: "msg_a", disposition: "ignored" });
    markEmailSeen(db, { message_id: "msg_b", disposition: "triaged" });
    markEmailSeen(db, { message_id: "msg_c", disposition: "ignored" });
    const ignored = listEmailSeen(db, { disposition: "ignored" });
    expect(ignored.map((r) => r.message_id).sort()).toEqual(["msg_a", "msg_c"]);
  });
});
