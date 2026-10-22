/**
 * Upkeep: an agent, now and then, looks after what it owns. Each rule its
 * evidence is counted by, the message that carries it, the fingerprint that
 * skips a turn when nothing changed, and a whole turn against a real store
 * and the real tools, with what it changed counted from history.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCoreMemory } from "../db/core-memory-queries.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import {
  COMMITMENT_TYPE,
  DIRECTORY_TYPES,
  Directory,
  DOC_TYPE,
  MISS_TYPE,
  PAGE_TYPE,
  UPKEEP_TYPE,
} from "../plugins/directory-records.js";
import { CommitmentTool, DirectoryTool, WriteupTool } from "../plugins/directory-tools.js";
import {
  checkDate,
  classify,
  commitmentItems,
  docItems,
  duplicatePairs,
  fingerprint,
  type NoteView,
  noteItems,
  pageItems,
  parseUpkeep,
  UPKEEP_DEFAULTS,
  Upkeep,
  type UpkeepSettings,
  upkeepMessage,
} from "../plugins/directory-upkeep.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import type { Disposer } from "../registry.js";
import { registerStateType } from "../state/registry.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { StateChange, StateRecord } from "../state/types.js";
import type { Tool, ToolContext } from "../tools/interface.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-21T12:00:00.000Z");
const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * DAY).toISOString();

const DAYS = {
  waiting: UPKEEP_DEFAULTS.waitingDays,
  quiet: UPKEEP_DEFAULTS.quietDays,
  finished: UPKEEP_DEFAULTS.archiveAfterDays,
  review: UPKEEP_DEFAULTS.reviewDays,
  recall: UPKEEP_DEFAULTS.recallDays,
  expiring: UPKEEP_DEFAULTS.expiringDays,
};

function rec(type: string, id: string, data: Record<string, unknown>, extra: Partial<StateRecord> = {}): StateRecord {
  return {
    type,
    id,
    scope: "global",
    data: { owner: "planner", ...data },
    version: 1,
    createdAt: daysAgo(60),
    updatedAt: daysAgo(1),
    createdBy: { kind: "plugin", name: "directory" },
    updatedBy: { kind: "plugin", name: "directory" },
    ...extra,
  } as StateRecord;
}

function note(id: string, text: string, extra: Partial<NoteView> = {}): NoteView {
  return { id, text, createdAt: daysAgo(40), refCount: 0, kept: false, pinned: false, ...extra };
}

const lines = (items: { line: string }[]) => items.map((i) => i.line);

describe("the upkeep setting", () => {
  it("is off unless every and agents are given, and keeps every bar's default in one place", () => {
    const warn = vi.fn();
    const off = parseUpkeep(undefined, warn);
    expect(off.schedule).toBeUndefined();
    expect(off).toMatchObject({ maxRounds: 6, memoryBudget: 1500 });
    expect(off.days).toEqual({ waiting: 7, quiet: 14, finished: 7, review: 30, recall: 30, expiring: 3 });
    expect(warn).not.toHaveBeenCalled();

    expect(parseUpkeep({ every: "24h", agents: "all" }, warn).schedule).toEqual({ everyMs: DAY, agents: "all" });
    expect(parseUpkeep({ every: "12 hours", agents: ["planner", " writer "] }, warn).schedule).toEqual({
      everyMs: DAY / 2,
      agents: ["planner", "writer"],
    });
    // Bars on their own: a person can still start one from the page, against these.
    const bars = parseUpkeep({ maxRounds: 3, reviewDays: 60, memoryBudget: 800 }, warn);
    expect(bars.schedule).toBeUndefined();
    expect(bars).toMatchObject({ maxRounds: 3, memoryBudget: 800 });
    expect(bars.days.review).toBe(60);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says what's wrong with a value it can't use, and uses the default instead", () => {
    const warn = vi.fn();
    expect(parseUpkeep({ every: "10s", agents: "all" }, warn).schedule).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("upkeep.every is at least a minute"));
    expect(parseUpkeep({ every: "24h" }, warn).schedule).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("upkeep.agents is a list"));
    expect(parseUpkeep({ maxRounds: 50 }, warn).maxRounds).toBe(6);
    expect(warn).toHaveBeenLastCalledWith("upkeep.maxRounds should be a number from 1 to 20; using 6.");
    expect(parseUpkeep({ quietDays: "two weeks" }, warn).days.quiet).toBe(14);
    expect(parseUpkeep("daily", warn).schedule).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("it is off"));
  });
});

describe("a next check that reads as a date", () => {
  it("reads ISO dates and times, and dates with a year, and nothing else", () => {
    expect(checkDate("2026-10-18")).toBe(Date.parse("2026-10-18"));
    expect(checkDate("after 2026-10-18T09:30Z, once the quote is in")).toBe(Date.parse("2026-10-18T09:30Z"));
    expect(checkDate("Oct 25, 2026")).toBe(Date.parse("Oct 25, 2026"));
    expect(checkDate("Friday")).toBeUndefined();
    // The clock reads a month and day with no year as 2001; that is no date.
    expect(checkDate("October 25")).toBeUndefined();
    expect(checkDate("when the hotel replies")).toBeUndefined();
    expect(checkDate(undefined)).toBeUndefined();
  });
});

describe("commitment evidence", () => {
  it("names a next check that came, work waiting too long, work gone quiet, and finished work left out", () => {
    const records = [
      rec(COMMITMENT_TYPE, "planner-lisbon", { goal: "Lisbon trip", status: "open", nextCheck: "2026-10-18" }),
      rec(COMMITMENT_TYPE, "planner-venue", {
        goal: "Book the venue",
        status: "waiting",
        waitingOn: "the caterer",
        updates: [{ at: daysAgo(1), text: "Still waiting." }],
      }),
      rec(COMMITMENT_TYPE, "planner-flowers", {
        goal: "Flowers",
        status: "open",
        updates: [{ at: daysAgo(16), text: "Opened." }],
      }),
      rec(COMMITMENT_TYPE, "planner-cake", {
        goal: "Cake tasting",
        status: "done",
        updates: [{ at: daysAgo(10), text: "Done." }],
      }),
      rec(COMMITMENT_TYPE, "planner-ski", {
        goal: "Ski week",
        status: "dropped",
        updates: [{ at: daysAgo(3), text: "Dropped: no snow." }],
      }),
      rec(COMMITMENT_TYPE, "planner-fresh", {
        goal: "Fresh",
        status: "open",
        nextCheck: "Friday",
        updates: [{ at: daysAgo(1), text: "Opened." }],
      }),
      rec(
        COMMITMENT_TYPE,
        "planner-gone",
        { goal: "Gone", status: "done", updates: [{ at: daysAgo(40), text: "Done." }] },
        { archivedAt: daysAgo(30) },
      ),
    ];
    // The venue has waited since its history says, though it was updated yesterday.
    const items = commitmentItems(records, NOW, DAYS, new Map([["planner-venue", daysAgo(9)]]));
    expect(lines(items)).toEqual([
      '- planner-lisbon "Lisbon trip": its next check, 2026-10-18, has come',
      '- planner-venue "Book the venue": waiting on the caterer for 9 days',
      '- planner-flowers "Flowers": no update in 16 days',
      '- planner-cake "Cake tasting": done 10 days ago and still not archived',
    ]);
    expect(items[0].keys).toEqual(["commitment:planner-lisbon:check"]);
  });

  it("gives one line with every reason a commitment has, and uses its last update when history can't say", () => {
    const records = [
      rec(COMMITMENT_TYPE, "planner-venue", {
        goal: "Book the venue",
        status: "waiting",
        nextCheck: "2026-10-01",
        updates: [{ at: daysAgo(20), text: "Waiting on the caterer." }],
      }),
    ];
    const [item] = commitmentItems(records, NOW, DAYS);
    expect(item.line).toBe(
      '- planner-venue "Book the venue": its next check, 2026-10-01, has come; waiting for 20 days; no update in 20 days',
    );
    expect(item.keys).toEqual([
      "commitment:planner-venue:check",
      "commitment:planner-venue:waiting",
      "commitment:planner-venue:quiet",
    ]);
  });
});

describe("doc evidence", () => {
  const docs = [
    rec(DOC_TYPE, "planner-guests", { title: "Guest list", reviewedAt: daysAgo(45) }),
    rec(DOC_TYPE, "planner-checklist", { title: "Wedding checklist", reviewedAt: daysAgo(2) }),
    rec(DOC_TYPE, "planner-draft", { title: "Seating ideas" }, { createdAt: daysAgo(31) }),
  ];
  const misses = [
    rec(MISS_TYPE, "miss-1", { query: "seating chart rules", askedBy: ["writer", "assistant"], at: daysAgo(1) }),
  ];

  it("names docs not reviewed in a while, docs others read since the last upkeep, and misses in its area", () => {
    const items = docItems({
      docs,
      misses,
      reads: { "planner-checklist": { n: 5, by: ["writer", "assistant"] } },
      readsAtLast: { "planner-checklist": 2 },
      now: NOW,
      days: DAYS,
      first: false,
    });
    expect(lines(items)).toEqual([
      '- planner-guests "Guest list": not reviewed in 45 days',
      '- planner-checklist "Wedding checklist": read 3 times by other agents since your last upkeep, lately by writer and assistant',
      '- planner-draft "Seating ideas": never reviewed, written 31 days ago',
      '- Looked for in your area, with no doc or commitment to find: "seating chart rules", asked by writer and assistant',
    ]);
  });

  it("says nothing of reads that came before the last upkeep, and calls a first upkeep's reads all there are", () => {
    const before = docItems({
      docs,
      misses: [],
      reads: { "planner-checklist": { n: 2, by: ["writer"] } },
      readsAtLast: { "planner-checklist": 2 },
      now: NOW,
      days: DAYS,
      first: false,
    });
    expect(lines(before).some((l) => l.includes("read"))).toBe(false);
    const first = docItems({
      docs,
      misses: [],
      reads: { "planner-checklist": { n: 2, by: ["writer"] } },
      readsAtLast: {},
      now: NOW,
      days: DAYS,
      first: true,
    });
    expect(lines(first)).toContain(
      '- planner-checklist "Wedding checklist": read 2 times by other agents so far, lately by writer',
    );
  });
});

describe("page evidence", () => {
  const work = [
    rec(COMMITMENT_TYPE, "planner-venue", { goal: "Book the venue", status: "open" }, { createdAt: daysAgo(3) }),
    rec(
      COMMITMENT_TYPE,
      "planner-cake",
      { goal: "Cake tasting", status: "done", updates: [{ at: daysAgo(1), text: "Done." }] },
      { createdAt: daysAgo(20) },
    ),
  ];

  it("names a page with no note", () => {
    expect(lines(pageItems(null, work, NOW))).toEqual(["- Your page has no note for people."]);
    expect(lines(pageItems(rec(PAGE_TYPE, "planner", { note: " " }), work, NOW))).toEqual([
      "- Your page has no note for people.",
    ]);
  });

  it("names a note written before the newest work, counting finished work, and not one written since", () => {
    const old = rec(PAGE_TYPE, "planner", { note: "I plan weddings.", noteAt: daysAgo(5) });
    const [item] = pageItems(old, work, NOW);
    expect(item.line).toBe(
      '- Your page note was written before your newest work: commitment planner-cake "Cake tasting", 1 day ago.',
    );
    expect(item.keys).toEqual(["page:old:planner-cake"]);
    const fresh = rec(PAGE_TYPE, "planner", { note: "I plan weddings.", noteAt: daysAgo(0.5) });
    expect(pageItems(fresh, work, NOW)).toEqual([]);
    // A page written before noteAt was kept is dated by its last change.
    const unstamped = rec(PAGE_TYPE, "planner", { note: "I plan weddings." }, { updatedAt: daysAgo(0.5) });
    expect(pageItems(unstamped, work, NOW)).toEqual([]);
  });
});

describe("note evidence", () => {
  it("names notes not recalled in a while, never recalled, or about to expire, and leaves pinned and kept ones be", () => {
    const notes = [
      note("note:a", "The florist closes on Mondays.", { recalledAt: daysAgo(35), refCount: 2 }),
      note("note:b", "Ask about the gluten-free cake.", { createdAt: daysAgo(45) }),
      note("note:c", "Recalled before recall times were kept.", { refCount: 4 }),
      note("note:d", "A pinned preference.", { pinned: true, createdAt: daysAgo(90) }),
      note("note:e", "A kept note.", { kept: true, createdAt: daysAgo(90) }),
      note("note:f", "Recalled lately.", { recalledAt: daysAgo(3), refCount: 1 }),
      note("note:g", "Expires soon.", { recalledAt: daysAgo(1), ttlAt: "2026-10-23 08:00:00" }),
      note("note:h", "Expires later.", { recalledAt: daysAgo(1), ttlAt: "2026-11-30 08:00:00" }),
    ];
    const items = noteItems({ notes, pairs: [], now: NOW, days: DAYS });
    expect(lines(items)).toEqual([
      '- note:a "The florist closes on Mondays.": not recalled in 35 days',
      '- note:b "Ask about the gluten-free cake.": never recalled, written 45 days ago',
      '- note:g "Expires soon.": expires on 2026-10-23; keep it if it still matters',
    ]);
  });

  it("finds notes that say the same thing by their words, or by meaning when there are vectors", () => {
    const notes = [
      note("note:a", "The client prefers morning calls before ten."),
      note("note:b", "Client prefers morning calls, before ten."),
      note("note:c", "Book the string quartet for the ceremony."),
      note("note:d", "Reserve a string quartet to play at the ceremony."),
      note("note:e", "Buy stamps."),
    ];
    expect(duplicatePairs(notes).map(([a, b]) => `${a.id}+${b.id}`)).toEqual(["note:a+note:b"]);
    const vec = (x: number, y: number) => new Float32Array([x, y]);
    const vectors = new Map([
      ["note:a", vec(1, 0)],
      ["note:b", vec(1, 0.05)],
      ["note:c", vec(0, 1)],
      ["note:d", vec(0.02, 1)],
      ["note:e", vec(0.7, 0.7)],
    ]);
    // The same words count as fully the same, so that pair still comes first.
    expect(duplicatePairs(notes, vectors).map(([a, b]) => `${a.id}+${b.id}`)).toEqual([
      "note:a+note:b",
      "note:c+note:d",
    ]);
    const items = noteItems({ notes, pairs: duplicatePairs(notes, vectors), now: NOW, days: DAYS });
    expect(lines(items)).toContain(
      '- note:c "Book the string quartet for the ceremony." and note:d "Reserve a string quartet to play at the ceremony." look like the same note',
    );
  });

  it("says when what loads every turn is over its budget, and nothing when it's under", () => {
    const over = noteItems({
      notes: [],
      pairs: [],
      now: NOW,
      days: DAYS,
      loaded: { tokens: 1820, budget: 1500 },
      coreMemory: true,
    });
    expect(lines(over)).toEqual([
      "- Your pinned notes and core memory load on every turn: about 1,820 tokens, over your budget of 1,500.",
    ]);
    expect(noteItems({ notes: [], pairs: [], now: NOW, days: DAYS, loaded: { tokens: 900, budget: 1500 } })).toEqual(
      [],
    );
  });
});

describe("the fingerprint", () => {
  it("is the same for evidence that only got older, and changes when something new comes up", () => {
    const venue = (waited: number) =>
      rec(COMMITMENT_TYPE, "planner-venue", {
        goal: "Book the venue",
        status: "waiting",
        updates: [{ at: daysAgo(waited), text: "Waiting." }],
      });
    const today = [{ title: "Your commitments", items: commitmentItems([venue(9)], NOW, DAYS) }];
    const later = [
      { title: "Your commitments", items: commitmentItems([venue(9)], new Date(NOW.getTime() + 2 * DAY), DAYS) },
    ];
    expect(lines(later[0].items)).not.toEqual(lines(today[0].items));
    expect(fingerprint(later)).toBe(fingerprint(today));
    // Two more days and it has also had no update for a fortnight: that is new.
    const quiet = [
      { title: "Your commitments", items: commitmentItems([venue(9)], new Date(NOW.getTime() + 6 * DAY), DAYS) },
    ];
    expect(fingerprint(quiet)).not.toBe(fingerprint(today));
  });
});

describe("the upkeep message", () => {
  it("carries the evidence by section, names only the tools the agent has, says retiring is archiving, and asks for no reply", () => {
    const message = upkeepMessage({
      sections: [
        {
          title: "Your commitments",
          items: [{ keys: ["k"], line: '- planner-cake "Cake tasting": done 10 days ago' }],
        },
        { title: "Your docs", items: [] },
        { title: "Your page", items: [{ keys: ["p"], line: "- Your page has no note for people." }] },
      ],
      since: "2026-10-14T09:00:00.000Z",
      tools: ["commitment", "directory"],
      maxRounds: 6,
    });
    expect(message).toBe(
      [
        "Time to look after what you own. Counted from your records since your last upkeep on 2026-10-14:",
        "",
        "Your commitments",
        '- planner-cake "Cake tasting": done 10 days ago',
        "",
        "Your page",
        "- Your page has no note for people.",
        "",
        "Tidy what needs it with the tools you have: commitment to post an update, finish, drop or archive one; directory with action page to rewrite your page note. Retiring something means archiving it: nothing is deleted, and a person can bring it back. You have up to 6 rounds of tool calls for this. Leave what's in order as it is.",
        "Nobody reads a reply here; what you change is what people see.",
      ].join("\n"),
    );
    expect(message).not.toMatch(/writeup|recall/);
  });

  it("counts what it can't show, and says so when nothing stands out", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ keys: [`k${i}`], line: `- item ${i}` }));
    const long = upkeepMessage({ sections: [{ title: "Your notes", items }], tools: [], maxRounds: 1 });
    expect(long).toContain("Time to look after what you own: your commitments, docs, page and notes.");
    expect(long).toContain("- item 7\n- …and 3 more like these.");
    expect(long).toContain("up to 1 round of tool calls");
    expect(upkeepMessage({ sections: [], tools: [], maxRounds: 2 })).toContain("Nothing you own stands out right now.");
  });
});

describe("what a change in history counts as", () => {
  const change = (c: Partial<StateChange>): StateChange =>
    ({
      type: DOC_TYPE,
      id: "d",
      scope: "global",
      op: "update",
      version: 2,
      actor: { kind: "plugin", name: "directory" },
      at: daysAgo(0),
      ...c,
    }) as StateChange;

  it("tells archives, reviews, closes and updates apart", () => {
    expect(classify(change({ lifecycle: "archived" }))).toBe("archived");
    expect(classify(change({ lifecycle: "unarchived" }))).toBeUndefined();
    expect(
      classify(
        change({ before: { title: "A", reviewedAt: daysAgo(40) }, after: { title: "A", reviewedAt: daysAgo(0) } }),
      ),
    ).toBe("reviewed");
    expect(
      classify(
        change({ before: { title: "A", reviewedAt: daysAgo(40) }, after: { title: "B", reviewedAt: daysAgo(0) } }),
      ),
    ).toBe("updated");
    expect(classify(change({ type: COMMITMENT_TYPE, before: { status: "open" }, after: { status: "dropped" } }))).toBe(
      "closed",
    );
    expect(classify(change({ type: COMMITMENT_TYPE, before: { status: "done" }, after: { status: "done" } }))).toBe(
      "updated",
    );
    expect(classify(change({ type: COMMITMENT_TYPE, op: "create", after: { status: "open" } }))).toBe("updated");
  });
});

// --------------------------------------------------------------------------
// A whole turn
// --------------------------------------------------------------------------

describe("an upkeep turn", () => {
  const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };
  let db: Database.Database;
  let service: StateService;
  let directory: Directory;
  let memory: SqliteMemoryBackend;
  let clock: Date;
  let cleanup: Disposer[];
  let embedder: EmbeddingProvider | undefined;
  let tools: Record<string, Tool>;
  let runs: { agent: string; session: string; message: string; maxRounds: number }[];
  let turn: (agent: string, session: string) => Promise<void>;
  let settings: UpkeepSettings;

  const ctx = (agent: string, sessionId: string): ToolContext => ({
    sessionId,
    workingDirectory: "/",
    env: {},
    agentName: agent,
  });
  async function call(agent: string, tool: string, args: Record<string, unknown>, session = "chat") {
    const r = await tools[tool].execute(args, ctx(agent, session));
    if (!r.success) throw new Error(`${tool} ${JSON.stringify(args)} failed: ${r.error}`);
    return String(r.output);
  }
  /** Run `fn` with the clock `days` days before the turn. */
  async function back<T>(days: number, fn: () => Promise<T>): Promise<T> {
    const was = clock;
    clock = new Date(NOW.getTime() - days * DAY);
    try {
      return await fn();
    } finally {
      clock = was;
    }
  }
  const sqlTime = (iso: string) => iso.slice(0, 19).replace("T", " ");

  function upkeep(): Upkeep {
    return new Upkeep({
      directory,
      settings,
      has: () => true,
      memory: async () => memory,
      embedder: () => embedder,
      session: (agent) => ({ id: `upkeep-${agent}` }),
      run: async (agent, session, message, maxRounds) => {
        runs.push({ agent, session: session.id, message, maxRounds });
        await turn(agent, session.id);
      },
    });
  }

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    db = initDatabase(":memory:");
    clock = NOW;
    service = new StateService({ getConfig: () => ({ state: { backend: "sqlite" } }), db, now: () => clock });
    cleanup = DIRECTORY_TYPES.map((def) => registerStateType({ ...def }));
    directory = new Directory({
      getService: () => service,
      agents: () => ["planner", "writer"],
      describe: () => undefined,
      now: () => clock,
    });
    memory = new SqliteMemoryBackend(db);
    embedder = undefined;
    tools = {
      commitment: new CommitmentTool(directory),
      writeup: new WriteupTool(directory),
      directory: new DirectoryTool(directory),
    };
    runs = [];
    turn = async () => {};
    settings = parseUpkeep({}, () => {});

    // A month and a half of the planner's work, some of it gone stale.
    await back(50, () => call("planner", "commitment", { action: "open", goal: "Flowers", doneWhen: "Ordered" }));
    await back(40, () => call("planner", "commitment", { action: "open", goal: "Cake tasting", doneWhen: "Booked" }));
    await back(16, () => call("planner", "commitment", { action: "done", id: "planner-cake-tasting" }));
    await back(30, () => call("planner", "commitment", { action: "open", goal: "Book the venue", doneWhen: "Signed" }));
    await back(20, () =>
      call("planner", "commitment", { action: "update", id: "planner-book-the-venue", waitingOn: "the caterer" }),
    );
    await back(2, () =>
      call("planner", "commitment", { action: "update", id: "planner-book-the-venue", note: "Chased them." }),
    );
    await back(1, () =>
      call("planner", "commitment", { action: "open", goal: "Fresh thing", doneWhen: "Done", nextCheck: "Friday" }),
    );
    await back(50, () =>
      call("planner", "writeup", { action: "write", title: "Guest list", summary: "Who's coming.", body: "Everyone." }),
    );
    await back(5, () =>
      call("planner", "writeup", { action: "write", title: "Checklist", summary: "What's left.", body: "- Cake" }),
    );
    await back(1, () => call("writer", "writeup", { action: "read", id: "planner-checklist" }));
    await back(1, () => call("planner", "writeup", { action: "read", id: "planner-checklist" }));
    await back(1, () =>
      service.put(PERSON, {
        type: MISS_TYPE,
        id: "miss-seating",
        scope: "agent:planner",
        data: { owner: "planner", query: "seating chart rules", askedBy: ["writer"], at: daysAgo(1) },
      }),
    );
    const old = createNote(db, { agent: "planner", content: "The florist closes on Mondays." });
    db.prepare("UPDATE notes SET created_at = ? WHERE id = ?").run(sqlTime(daysAgo(45)), old.id);
    createNote(db, { agent: "writer", content: "The writer's own note, not the planner's." });
  });

  afterEach(async () => {
    for (const dispose of cleanup.splice(0)) dispose();
    await service.close();
    db.close();
    vi.restoreAllMocks();
  });

  it("counts a read only when another agent reads a doc, in the owner's upkeep record, which the owner can't write", async () => {
    const record = await directory.upkeep("planner");
    expect(record?.scope).toBe("agent:planner");
    expect(record?.data.reads).toEqual({ "planner-checklist": { n: 1, by: ["writer"], at: daysAgo(1) } });
    expect(record?.updatedBy).toEqual({ kind: "plugin", name: "directory" });
    expect(record?.source).toMatchObject({ tool: "writeup", onBehalfOf: "writer" });
    // The planner reading its own doc added nothing, and the planner has no way to write the count itself.
    expect(await directory.upkeep("writer")).toBeNull();
    await expect(
      service.patch({ actor: { kind: "agent", name: "planner" } }, { type: UPKEEP_TYPE, id: "planner" }, { reads: {} }),
    ).rejects.toThrow();
  });

  it("wakes the agent with the evidence, counts what its own turn changed from history, and keeps it", async () => {
    turn = async (agent, session) => {
      await call(agent, "commitment", { action: "archive", id: "planner-cake-tasting", reason: "Long done." }, session);
      await call(agent, "writeup", { action: "review", id: "planner-guest-list" }, session);
      // The same agent elsewhere at the same moment is not upkeep's doing.
      await call(agent, "commitment", { action: "update", id: "planner-flowers", note: "Asked the florist." });
      const [stale] = (await memory.list({ scope: "agent:planner", kind: "note", limit: 5 })).filter(
        (f) => f.metadata?.agent === "planner",
      );
      await memory.archive(stale.id as string, { by: agent, reason: "Stale." });
    };
    expect(await upkeep().turn("planner")).toBe("woken");
    expect(runs).toHaveLength(1);
    const { message, maxRounds, session } = runs[0];
    expect(session).toBe("upkeep-planner");
    expect(maxRounds).toBe(6);
    expect(message).toContain('- planner-flowers "Flowers": no update in 50 days');
    expect(message).toContain('- planner-cake-tasting "Cake tasting": done 16 days ago and still not archived');
    // It has waited since its history says, though it was chased two days ago.
    expect(message).toContain('- planner-book-the-venue "Book the venue": waiting on the caterer for 20 days');
    expect(message).not.toContain("planner-fresh-thing");
    expect(message).toContain('- planner-guest-list "Guest list": not reviewed in 50 days');
    expect(message).toContain('- planner-checklist "Checklist": read 1 time by other agents so far, lately by writer');
    expect(message).toContain('"seating chart rules", asked by writer');
    expect(message).toContain("- Your page has no note for people.");
    expect(message).toMatch(/note:note_\w+ "The florist closes on Mondays.": never recalled, written 45 days ago/);
    expect(message).not.toContain("The writer's own note");
    expect(message).toContain("Retiring something means archiving it");
    // Nothing loads over its budget here, so core memory isn't offered as something to tidy.
    expect(message).toContain("recall to keep a note or archive it.");
    expect(message).not.toContain("core_memory");

    const record = await directory.upkeep("planner");
    expect(record?.data).toMatchObject({
      at: NOW.toISOString(),
      started: NOW.toISOString(),
      changed: { archived: 2, reviewed: 1, updated: 0, closed: 0 },
      readsAtLast: { "planner-checklist": 1 },
    });
    expect(record?.data.error).toBeUndefined();
    // The archived commitment's history says it was done in upkeep, for the planner.
    const [archived] = await service.history(PERSON, { type: COMMITMENT_TYPE, id: "planner-cake-tasting" });
    expect(archived.source).toMatchObject({ surface: "upkeep", onBehalfOf: "planner", tool: "commitment" });
  });

  it("skips the next turn when nothing changed, wakes it when something did, and runs one when asked regardless", async () => {
    const keeper = upkeep();
    expect(await keeper.turn("planner")).toBe("woken");
    expect(await keeper.turn("planner")).toBe("quiet");
    clock = new Date(NOW.getTime() + DAY);
    // Only older: still nothing new.
    expect(await keeper.turn("planner")).toBe("quiet");
    // Another agent reads a doc: news since the last upkeep.
    await call("writer", "writeup", { action: "read", id: "planner-guest-list" });
    expect(await keeper.turn("planner")).toBe("woken");
    const second = runs.at(-1)?.message ?? "";
    expect(second).toContain(
      '"Guest list": not reviewed in 51 days; read 1 time by other agents since your last upkeep, lately by writer',
    );
    // What the first upkeep already saw doesn't come round again: the checklist's read, the miss.
    expect(second).not.toContain('"Checklist"');
    expect(second).not.toContain("seating chart rules");
    expect(await keeper.turn("planner")).toBe("quiet");
    expect(await keeper.turn("planner", { force: true })).toBe("woken");
    expect(runs).toHaveLength(3);
  });

  it("wakes nobody with no evidence at all, unless asked", async () => {
    // The writer owns nothing and has no notes of its own but one: give it a fresh note only.
    const keeper = new Upkeep({
      directory,
      settings,
      has: (_agent, tool) => tool === "commitment",
      session: (agent) => ({ id: `upkeep-${agent}` }),
      run: async (agent, session, message, maxRounds) => {
        runs.push({ agent, session: session.id, message, maxRounds });
      },
    });
    expect(await keeper.turn("writer")).toBe("quiet");
    expect(runs).toHaveLength(0);
    expect(await keeper.turn("writer", { force: true })).toBe("woken");
    expect(runs[0].message).toContain("Nothing you own stands out right now.");
  });

  it("keeps why a turn failed, and leaves its fingerprint so the next one tries again", async () => {
    turn = async () => {
      throw new Error("the model is unreachable");
    };
    const keeper = upkeep();
    await expect(keeper.turn("planner")).rejects.toThrow("the model is unreachable");
    expect((await directory.upkeep("planner"))?.data).toMatchObject({ error: "the model is unreachable" });
    expect((await directory.upkeep("planner"))?.data.fingerprint).toBeUndefined();
    turn = async () => {};
    expect(await keeper.turn("planner")).toBe("woken");
    expect((await directory.upkeep("planner"))?.data.error).toBeUndefined();
  });

  it("counts pinned notes and core memory against the budget, and offers core_memory only when they're over it", async () => {
    createNote(db, {
      agent: "planner",
      content: "Always book refundable rates; Sam hates losing deposits.",
      tags: ["pinned"],
    });
    setCoreMemory(db, {
      agent: "planner",
      project_id: null,
      section: "persona",
      content: "I plan events. ".repeat(20),
    });
    settings = parseUpkeep({ memoryBudget: 40 }, () => {});
    const over = await upkeep().gather("planner", { readsAtLast: {} });
    const notes = lines(over.sections.find((s) => s.title === "Your notes")?.items ?? []);
    expect(notes.at(-1)).toMatch(
      /^- Your pinned notes and core memory load on every turn: about \d+ tokens, over your budget of 40\.$/,
    );
    expect(over.tools).toContain("core_memory");
    settings = parseUpkeep({}, () => {});
    expect((await upkeep().gather("planner", { readsAtLast: {} })).tools).not.toContain("core_memory");
  });

  it("compares notes by meaning when the embedder answers, and by words when it fails", async () => {
    createNote(db, { agent: "planner", content: "Morning calls suit the client." });
    createNote(db, { agent: "planner", content: "The client likes being called in the morning." });
    embedder = {
      id: "fake",
      name: "fake",
      defaultModel: "f",
      defaultDim: 2,
      embed: async (inputs) => ({
        vectors: inputs.map((t) => (/morning/i.test(t) ? new Float32Array([1, 0]) : new Float32Array([0, 1]))),
        model: "f",
        dim: 2,
      }),
    };
    const found = await upkeep().gather("planner", { readsAtLast: {} });
    const notes = found.sections.find((s) => s.title === "Your notes")?.items ?? [];
    expect(lines(notes).some((l) => l.includes("Morning calls suit the client") && l.includes("same note"))).toBe(true);
    embedder = { ...embedder, embed: async () => Promise.reject(new Error("down")) };
    const words = await upkeep().gather("planner", { readsAtLast: {} });
    expect(
      lines(words.sections.find((s) => s.title === "Your notes")?.items ?? []).some((l) => l.includes("same note")),
    ).toBe(false);
  });
});

// The page note's time is kept when the agent writes it, so upkeep can tell it from later work.
describe("the page note's time", () => {
  it("is set when the note is written and cleared when it is taken away", async () => {
    const db = new Database(":memory:");
    const service = new StateService({ getConfig: () => ({ state: { backend: "sqlite" } }), db, now: () => NOW });
    const cleanup = DIRECTORY_TYPES.map((def) => registerStateType({ ...def }));
    const directory = new Directory({
      getService: () => service,
      agents: () => ["planner"],
      describe: () => undefined,
      now: () => NOW,
    });
    const tool = new DirectoryTool(directory);
    const context: ToolContext = { sessionId: "s", workingDirectory: "/", env: {}, agentName: "planner" };
    await tool.execute({ action: "page", note: "I plan weddings." }, context);
    const page = await service.get({ actor: { kind: "user", name: "owner" } }, { type: PAGE_TYPE, id: "planner" });
    expect(page?.data.noteAt).toBe(NOW.toISOString());
    await tool.execute({ action: "page", order: "waiting" }, context);
    await tool.execute({ action: "page", note: "" }, context);
    const cleared = await service.get({ actor: { kind: "user", name: "owner" } }, { type: PAGE_TYPE, id: "planner" });
    expect(cleared?.data.noteAt).toBeUndefined();
    for (const dispose of cleanup) dispose();
    await service.close();
    db.close();
  });
});
