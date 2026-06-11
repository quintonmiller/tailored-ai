/**
 * Session-summarizer opt-in plugin tests. Covers:
 *   - register(ctx) returns a disposer and starts a sweep timer
 *   - the timer fires a sweep on the configured interval (fake timers)
 *   - the disposer clears the timer
 *   - no-op when ctx.runtime is absent
 *   - recent_summary is composed (newest-first), capped, and refreshed after
 *     a successful sweep
 *   - idempotence: a session that already has a summary note is not
 *     re-summarized (no second LLM call)
 *   - config knobs (idleMinutes, keyPrefixes, maxPerSweep, recentSummaryCount,
 *     recentSummaryMaxBytes, updateRecentSummary) are honored
 *
 * The provider is stubbed — these never hit a real LLM.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession } from "../agent/session.js";
import { SESSION_SUMMARY_TAG } from "../agent/summarize-session.js";
import { getCoreMemorySection } from "../db/core-memory-queries.js";
import { createNote, listNotes } from "../db/note-queries.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { createPluginContext } from "../plugin-context.js";
import sessionSummarizerPlugin, {
  composeRecentSummary,
  SessionSummarizer,
  type SessionSummarizerConfig,
} from "../plugins/session-summarizer.js";
import type { AIProvider } from "../providers/interface.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function stubProvider(chat: AIProvider["chat"]): AIProvider {
  return { id: "stub", name: "stub", supportsTools: true, chat };
}

/** Provider whose chat() returns a fixed summary and counts its calls. */
function countingProvider(summary = "discussed X; decided Y; pending Z"): {
  provider: AIProvider;
  calls: () => number;
} {
  let calls = 0;
  const provider = stubProvider(async () => {
    calls += 1;
    return { content: summary, usage: { input: 0, output: 0 }, finishReason: "stop" };
  });
  return { provider, calls: () => calls };
}

function makeRuntime(provider: AIProvider, model = "stub-model"): AgentRuntime {
  return {
    db,
    getProvider: () => provider,
    getModel: () => model,
  } as unknown as AgentRuntime;
}

/** Seed a conversation and back-date the session so it reads as idle. */
function seedIdleSession(opts: { key?: string; project?: string | null; msgCount?: number; idleMinutes?: number }) {
  const session = newSession(db, "m", "p", opts.key, opts.project ?? null);
  const count = opts.msgCount ?? 8;
  for (let i = 0; i < count; i++) {
    saveMessage(db, session.id, { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` });
  }
  if (opts.idleMinutes) {
    // Back-date updated_at so findIdleSessions treats it as idle.
    const old = new Date(Date.now() - opts.idleMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(old, session.id);
  }
  return session;
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("session-summarizer — register(ctx) contract", () => {
  it("starts a sweep timer and returns a disposer when ctx.runtime is present", async () => {
    vi.useFakeTimers();
    const { provider, calls } = countingProvider();
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "discord:u1", idleMinutes: 200 });

    const ctx = createPluginContext({ runtime, config: { intervalMinutes: 30, idleMinutes: 120 } });
    const stop = await sessionSummarizerPlugin(ctx);
    expect(typeof stop).toBe("function");

    // Nothing yet — timer hasn't fired.
    expect(calls()).toBe(0);

    // Advance one interval; the sweep fires (it's async, so flush microtasks).
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toBe(1);

    await (stop as () => void)();
    // After disposal the timer no longer fires.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls()).toBe(1);
  });

  it("no-ops (no disposer) when ctx.runtime is absent", async () => {
    const ctx = createPluginContext(); // no runtime
    const stop = await sessionSummarizerPlugin(ctx);
    expect(stop).toBeUndefined();
  });
});

describe("session-summarizer — sweep behavior", () => {
  it("summarizes idle sessions and refreshes recent_summary", async () => {
    const { provider } = countingProvider("owner asked about taxes; agent filed form 1040");
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "discord:u1", idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120 } });
    await s.runSweep();

    // A session-summary note was written.
    const notes = listNotes(db, { tag: SESSION_SUMMARY_TAG });
    expect(notes.length).toBe(1);

    // recent_summary core memory was refreshed for the default agent.
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "recent_summary");
    expect(row?.content).toContain("owner asked about taxes");
  });

  it("does not summarize sessions newer than idleMinutes", async () => {
    const { provider, calls } = countingProvider();
    const runtime = makeRuntime(provider);
    // Fresh session (no back-dating).
    seedIdleSession({ key: "discord:u1" });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120 } });
    await s.runSweep();

    expect(calls()).toBe(0);
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(0);
  });

  it("respects keyPrefixes — only matching sessions are summarized", async () => {
    const { provider } = countingProvider();
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "discord:u1", idleMinutes: 200 });
    seedIdleSession({ key: "autopilot:job-1", idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120, keyPrefixes: ["discord:"] } });
    await s.runSweep();

    const notes = listNotes(db, { tag: SESSION_SUMMARY_TAG });
    expect(notes.length).toBe(1);
  });

  it("caps the number of sessions summarized per sweep (maxPerSweep)", async () => {
    const { provider, calls } = countingProvider();
    const runtime = makeRuntime(provider);
    for (let i = 0; i < 5; i++) seedIdleSession({ key: `discord:u${i}`, idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120, maxPerSweep: 2 } });
    await s.runSweep();

    expect(calls()).toBe(2);
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(2);
  });

  it("is idempotent — a session already summarized is not re-summarized", async () => {
    const { provider, calls } = countingProvider();
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "discord:u1", idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120 } });
    await s.runSweep();
    expect(calls()).toBe(1);

    // Second sweep: the existing session-summary note short-circuits the LLM call.
    await s.runSweep();
    expect(calls()).toBe(1);
    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(1);
  });

  it("skips the recent_summary write when updateRecentSummary is false", async () => {
    const { provider } = countingProvider();
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "discord:u1", idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120, updateRecentSummary: false } });
    await s.runSweep();

    expect(listNotes(db, { tag: SESSION_SUMMARY_TAG }).length).toBe(1);
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "recent_summary");
    expect(row).toBeNull();
  });

  it("keys recent_summary by the session's project_id", async () => {
    const { provider } = countingProvider("project work happened");
    const runtime = makeRuntime(provider);
    seedIdleSession({ key: "web:k1", project: "proj_a", idleMinutes: 200 });

    const s = new SessionSummarizer({ runtime, config: { idleMinutes: 120 } });
    await s.runSweep();

    // Written under the project scope, not the global scope.
    const scoped = getCoreMemorySection(db, { agent: "default", project_id: "proj_a" }, "recent_summary");
    expect(scoped?.content).toContain("project work happened");
  });
});

describe("composeRecentSummary — composition + capping", () => {
  function seedSummaryNote(content: string, projectId: string | null = null) {
    createNote(db, {
      content,
      session_id: null,
      project_id: projectId,
      agent: "default",
      tags: [SESSION_SUMMARY_TAG],
      importance: 0.5,
      ttl_at: null,
    });
  }

  it("composes the most recent N summaries, newest first", () => {
    seedSummaryNote("oldest");
    seedSummaryNote("middle");
    seedSummaryNote("newest");

    const out = composeRecentSummary(db, null, { count: 2, maxBytes: 600 });
    const lines = out.split("\n");
    expect(lines).toEqual(["- newest", "- middle"]);
  });

  it("hard-caps to maxBytes, dropping whole summaries from the tail", () => {
    seedSummaryNote("A".repeat(50));
    seedSummaryNote("B".repeat(50));
    seedSummaryNote("C".repeat(50));

    // Cap fits ~1 line (52 chars: "- " + 50). Second line would exceed.
    const out = composeRecentSummary(db, null, { count: 3, maxBytes: 60 });
    expect(out).toBe(`- ${"C".repeat(50)}`);
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it("returns empty string when there are no summaries", () => {
    expect(composeRecentSummary(db, null, { count: 3, maxBytes: 600 })).toBe("");
  });

  it("filters by project scope", () => {
    seedSummaryNote("global one", null);
    seedSummaryNote("project one", "proj_a");

    const out = composeRecentSummary(db, "proj_a", { count: 5, maxBytes: 600 });
    expect(out).toBe("- project one");
  });
});

describe("session-summarizer — config defaults", () => {
  it("falls back to defaults for missing/invalid knobs", () => {
    const cfg: SessionSummarizerConfig = { intervalMinutes: -1, idleMinutes: 0, maxPerSweep: NaN };
    // Construction must not throw; invalid values are replaced by defaults.
    const { provider } = countingProvider();
    expect(() => new SessionSummarizer({ runtime: makeRuntime(provider), config: cfg })).not.toThrow();
  });
});
