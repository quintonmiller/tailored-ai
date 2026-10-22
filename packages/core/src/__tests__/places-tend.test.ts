/**
 * Tending: agents look at their rooms in the light of what they've been
 * doing, now and then, each at a time of its own. What they did is counted
 * from what the runtime keeps anyway, and the message invites a change
 * without a word to answer with.
 */
import { describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  busy,
  type Done,
  dbTime,
  doneLines,
  everyWords,
  gatherDone,
  nextTend,
  offsetOf,
  parseTend,
  quiet,
  runNow,
  TEND_TICK_MS,
  Tender,
  tendMessage,
  turnSession,
  UPKEEP_KIND,
} from "../plugins/places-tend.js";
import type { Task, TaskBackend } from "../tasks/interface.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("the tend setting", () => {
  it("is off when absent, and says what is wrong with one it can't use", () => {
    expect(parseTend(undefined)).toBeUndefined();
    expect(parseTend(false)).toBeUndefined();
    expect(parseTend({ every: "24h", agents: "all" })).toEqual({ everyMs: DAY, agents: "all" });
    expect(parseTend({ every: "30 minutes", agents: ["planner", " writer ", "planner"] })).toEqual({
      everyMs: 30 * 60_000,
      agents: ["planner", "writer"],
    });
    expect(parseTend({ every: "soon", agents: "all" })).toMatch(/length of time/);
    expect(parseTend({ every: "10s", agents: "all" })).toMatch(/at least a minute/);
    expect(parseTend({ every: "24h", agents: [] })).toMatch(/list of agent names/);
    expect(parseTend("daily")).toMatch(/every/);
  });

  it("says an interval the way a person would", () => {
    expect(everyWords(DAY)).toBe("day");
    expect(everyWords(2 * DAY)).toBe("2 days");
    expect(everyWords(12 * HOUR)).toBe("12 hours");
    expect(everyWords(HOUR)).toBe("hour");
    expect(everyWords(90 * 60_000)).toBe("90 minutes");
  });
});

describe("when each agent's tend comes round", () => {
  const names = Array.from({ length: 44 }, (_, i) => `agent-${i}`);

  it("is at a time of its own in each interval, the same every time", () => {
    for (const name of names) {
      const at = offsetOf(name, DAY);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(DAY);
      expect(offsetOf(name, DAY)).toBe(at);
    }
  });

  it("spreads agents across the interval instead of waking them together", () => {
    const times = names.map((n) => offsetOf(n, DAY)).sort((a, b) => a - b);
    // Not bunched: they span most of the day, and no hour holds more than a handful.
    expect(times.at(-1)! - times[0]).toBeGreaterThan(DAY * 0.75);
    const perHour = new Map<number, number>();
    for (const t of times) perHour.set(Math.floor(t / HOUR), (perHour.get(Math.floor(t / HOUR)) ?? 0) + 1);
    expect(Math.max(...perHour.values())).toBeLessThanOrEqual(7);
    expect(new Set(times).size).toBe(names.length);
  });

  it("comes strictly after the time asked from, an interval apart, at the agent's own time", () => {
    const from = Date.parse("2026-10-19T10:00:00Z");
    const first = nextTend("planner", DAY, from);
    expect(first).toBeGreaterThan(from);
    expect(first - from).toBeLessThanOrEqual(DAY);
    expect(first % DAY).toBe(offsetOf("planner", DAY));
    expect(nextTend("planner", DAY, first)).toBe(first + DAY);
    expect(nextTend("planner", DAY, first - 1)).toBe(first);
  });
});

describe("what an agent has done, in words", () => {
  const busy: Done = {
    tools: [
      ["web_search", 14],
      ["edit", 9],
      ["exec", 6],
      ["tasks", 5],
      ["place", 3],
      ["read", 2],
      ["recall", 1],
      ["schedule", 1],
    ],
    tasks: { count: 4, titles: ["Draft the itinerary", "Book the hotel", "Check the visas", "Pack"] },
    rooms: ["trip-planning", "budget"],
    photos: 2,
  };

  it("counts a line a kind, naming the most used and counting the rest", () => {
    expect(doneLines(busy)).toEqual([
      "- called tools 41 times: web_search 14, edit 9, exec 6, tasks 5, place 3, read 2, and 2 other calls",
      '- finished 4 tasks: "Draft the itinerary", "Book the hotel", "Check the visas", and 1 more',
      "- talked in #trip-planning and #budget",
      "- took 2 photos",
    ]);
    expect(doneLines({ tools: [["edit", 1]], tasks: { count: 0, titles: [] }, rooms: [], photos: 0 })).toEqual([
      "- called tools 1 time: edit 1",
    ]);
  });

  it("is quiet when there is nothing for a room to show", () => {
    expect(quiet({ tools: [], tasks: { count: 0, titles: [] }, rooms: [], photos: 0 })).toBe(true);
    expect(quiet(busy)).toBe(false);
  });

  it("invites a change, or none, with no word to answer with", () => {
    const message = tendMessage({
      every: "day",
      done: busy,
      room: "the den: 6 m wide",
      away: "the lounge",
      meetings: ["trip-planning"],
    });
    expect(message).toMatch(/^Time to look at your room/);
    expect(message).toMatch(/In the last day, you:\n- called tools 41 times/);
    expect(message).toMatch(/Your room, as the place tool's look shows it:\nthe den: 6 m wide/);
    expect(message).toMatch(/If it already fits, leave it as it is\./);
    expect(message).toMatch(/You're in the lounge at the moment: go home/);
    expect(message).toMatch(/meeting rooms of #trip-planning are yours to change too/);
    expect(message).not.toMatch(/NO_REPLY|reply with|respond with|say (?:only|just)/i);
    expect(message.length).toBeLessThan(1200);
  });
});

describe("what an agent has done, from what the runtime keeps", () => {
  const since = Date.parse("2026-10-18T10:00:00Z");
  const at = (ms: number) => dbTime(ms);

  type Seeding = {
    session: (id: string, key: string) => void;
    used: (sessionId: string, agent: string | null, when: number) => void;
    called: (sessionId: string, calls: { name: string; arguments?: unknown }[], when: number) => void;
  };
  function seed(more?: (seeding: Seeding) => void) {
    const db = initDatabase(":memory:");
    const session = (id: string, key: string) =>
      db.prepare("INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, 'm', 'p')").run(id, key);
    const used = (sessionId: string, agent: string | null, when: number) =>
      db
        .prepare(
          "INSERT INTO token_usage (session_id, agent, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, 1, 1, ?)",
        )
        .run(sessionId, agent, at(when));
    const called = (sessionId: string, calls: { name: string; arguments?: unknown }[], when: number) =>
      db
        .prepare(
          "INSERT INTO messages (session_id, role, content, tool_calls, created_at) VALUES (?, 'assistant', '', ?, ?)",
        )
        .run(sessionId, JSON.stringify(calls.map((c, i) => ({ id: `c${i}`, ...c }))), at(when));
    session("s-chat", "web:1");
    session("s-room", "room:local.trip:planner");
    session("s-tend", "tend:planner");
    session("s-other", "web:2");
    used("s-chat", "planner", since + HOUR);
    used("s-room", "planner", since + 2 * HOUR);
    used("s-tend", "planner", since + 3 * HOUR);
    used("s-other", "writer", since + HOUR);
    called("s-chat", [{ name: "web_search" }, { name: "web_search" }, { name: "edit" }], since + HOUR);
    // Before the interval: not counted.
    called("s-chat", [{ name: "exec" }], since - HOUR);
    called("s-room", [{ name: "place", arguments: { action: "photo" } }, { name: "room" }], since + 2 * HOUR);
    called("s-tend", [{ name: "place", arguments: { action: "add" } }], since + 3 * HOUR);
    called("s-other", [{ name: "exec" }], since + HOUR);
    more?.({ session, used, called });
    return db;
  }

  const task = (title: string, updated: string, assignee = "planner"): Task => ({
    id: title,
    title,
    description: "",
    status: "done",
    author: "",
    tags: [],
    assignee,
    rank: 0,
    blocked_reason: null,
    project_id: null,
    created_at: updated,
    updated_at: updated,
  });
  const backend = (tasks: Task[]) =>
    ({
      statuses: { backlog: "backlog", inProgress: "in_progress", blocked: "blocked", done: "done" },
      query: async (filter: { assignee?: string; status?: string }) => {
        const found = tasks.filter((t) => t.assignee === filter.assignee && t.status === filter.status);
        return { tasks: found, total: found.length };
      },
    }) as unknown as TaskBackend;

  it("counts its tool calls, the rooms it talked in, its photos and the tasks it finished, since then only", async () => {
    const done = await gatherDone({
      // Its upkeep tidied what it owns: not news for its room, and left out with its tend's own session.
      db: seed(({ session, used, called }) => {
        session("s-upkeep", "upkeep:planner");
        used("s-upkeep", "planner", since + 4 * HOUR);
        called("s-upkeep", [{ name: "commitment" }, { name: "commitment" }], since + 4 * HOUR);
      }),
      agent: "planner",
      since,
      rooms: [
        { ref: "local:trip", name: "trip" },
        { ref: "local:budget", name: "budget" },
      ],
      tasks: backend([
        task("Book the hotel", dbTime(since + HOUR)),
        task("Old news", dbTime(since - DAY)),
        task("Draft the itinerary", new Date(since + 5 * HOUR).toISOString()),
        task("Someone else's", dbTime(since + HOUR), "writer"),
      ]),
      skip: [turnSession("tend", "planner"), turnSession(UPKEEP_KIND, "planner")],
    });
    expect(done.tools).toEqual([
      ["web_search", 2],
      ["edit", 1],
      ["place", 1],
      ["room", 1],
    ]);
    expect(done.photos).toBe(1);
    expect(done.rooms).toEqual(["trip"]);
    expect(done.tasks).toEqual({ count: 2, titles: ["Book the hotel", "Draft the itinerary"] });
  });

  it("counts the default agent's calls, whether they carry no name or the name default", async () => {
    // A config with an `agents.default` has the default agent's calls say "default"; one without, nothing.
    const db = seed(({ session, used, called }) => {
      session("s-plain", "web:3");
      session("s-named", "web:4");
      used("s-plain", null, since + HOUR);
      used("s-named", "default", since + HOUR);
      called("s-plain", [{ name: "exec" }], since + HOUR);
      called("s-named", [{ name: "exec" }, { name: "edit" }], since + HOUR);
    });
    const done = await gatherDone({ db, agent: "default", since, rooms: [] });
    expect(done.tools).toEqual([
      ["exec", 2],
      ["edit", 1],
    ]);
  });

  it("finds nothing for an agent that did nothing, and does without a task backend", async () => {
    const done = await gatherDone({ db: seed(), agent: "editor", since, rooms: [] });
    expect(quiet(done)).toBe(true);
  });
});

describe("tending, as time goes by", () => {
  function setup(opts: { unready?: (agent: string) => string | null; slow?: boolean } = {}) {
    let clock = Date.parse("2026-10-19T00:00:00Z");
    const tended: { agent: string; since: number; at: number }[] = [];
    const finish: (() => void)[] = [];
    const logs: string[] = [];
    const agents = ["planner", "writer", "reviewer", "editor"];
    const tender = new Tender({
      settings: { everyMs: HOUR, agents: ["planner", "writer", "reviewer", "ghost"] },
      agents: () => agents,
      unready: opts.unready ?? (() => null),
      tend: (agent, since) => {
        tended.push({ agent, since, at: clock });
        return opts.slow ? new Promise((done) => finish.push(() => done("woken"))) : Promise.resolve("woken");
      },
      now: () => clock,
      log: (line) => logs.push(line),
    });
    /** Move the clock on, looking for due tends every tick on the way, as the timer would. */
    const pass = async (ms: number) => {
      const end = clock + ms;
      while (clock < end) {
        clock = Math.min(end, clock + TEND_TICK_MS);
        tender.tick();
        await tender.idle();
      }
    };
    const advance = (ms: number) => {
      clock += ms;
    };
    return { tender, tended, finish, logs, pass, advance, now: () => clock };
  }

  it("tends each agent asked for once an interval, at its own time, and nobody else", async () => {
    const { tender, tended, pass } = setup();
    tender.tick();
    await pass(3 * HOUR);
    const by = (a: string) => tended.filter((t) => t.agent === a);
    for (const agent of ["planner", "writer", "reviewer"]) {
      expect(by(agent)).toHaveLength(3);
      // Within a tick of its own time, and an interval apart.
      for (const t of by(agent)) expect((t.at - offsetOf(agent, HOUR)) % HOUR).toBeLessThan(TEND_TICK_MS);
      // Each covers the interval that ended at its time.
      for (const t of by(agent)) expect(t.at - t.since).toBeGreaterThanOrEqual(HOUR);
    }
    expect(by("editor")).toHaveLength(0);
    expect(by("ghost")).toHaveLength(0);
  });

  it("runs one at a time, so never two for one agent, and the others wait their turn", async () => {
    const { tender, tended, finish, advance } = setup({ slow: true });
    tender.tick();
    // Every agent comes due, twice over, while the first tend is still going: none starts beside it.
    for (let i = 0; i < (3 * HOUR) / TEND_TICK_MS; i++) {
      advance(TEND_TICK_MS);
      tender.tick();
    }
    expect(tended).toHaveLength(1);
    // Once it ends, the ones kept waiting go next, one a look, each once.
    for (let i = 0; i < 3; i++) {
      finish.shift()?.();
      await tender.idle();
      advance(TEND_TICK_MS);
      tender.tick();
    }
    expect(tended.map((t) => t.agent).sort()).toEqual(["planner", "reviewer", "writer", tended[0].agent].sort());
    expect(new Set(tended.slice(0, 3).map((t) => t.agent)).size).toBe(3);
    // Let the last one finish, so nothing is left going.
    while (finish.length) finish.shift()?.();
    await tender.idle();
  });

  it("starts nothing while a tend is going, even from a tender made since: not for that agent, nor another", async () => {
    let clock = Date.parse("2026-10-19T00:00:00Z");
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const make = () =>
      new Tender({
        settings: { everyMs: HOUR, agents: ["planner", "writer"] },
        agents: () => ["planner", "writer"],
        unready: () => null,
        tend: (agent) => {
          started.push(agent);
          return new Promise((done) => releases.push(() => done("woken")));
        },
        now: () => clock,
        log: () => {},
      });
    const before = make();
    before.tick();
    clock = Math.min(before.dueAt("planner") as number, before.dueAt("writer") as number);
    before.tick();
    expect(started).toHaveLength(1);
    const [first] = started;
    // A reload: the old tender stops, a new one starts, and the turn the old one began is still going.
    before.stop();
    const after = make();
    after.tick();
    // Both agents come due in the new tender while that turn goes on: neither starts beside it.
    clock = Math.max(after.dueAt("planner") as number, after.dueAt("writer") as number);
    after.tick();
    expect(started).toEqual([first]);
    releases.shift()?.();
    await before.idle();
    // Then one at a time again, each once.
    after.tick();
    expect(started).toHaveLength(2);
    after.tick();
    expect(started).toHaveLength(2);
    releases.shift()?.();
    await after.idle();
    after.tick();
    expect(started.slice(1).sort()).toEqual(["planner", "writer"]);
    releases.shift()?.();
    await after.idle();
  });

  it("gives another kind of turn times of its own, says it in its own words, and shares one turn at a time with tends", async () => {
    let clock = Date.parse("2026-10-19T00:00:00Z");
    const logs: string[] = [];
    const releases: (() => void)[] = [];
    const tends: string[] = [];
    const tend = new Tender({
      settings: { everyMs: HOUR, agents: ["planner"] },
      agents: () => ["planner"],
      unready: () => null,
      tend: (agent) => {
        tends.push(agent);
        return new Promise((done) => releases.push(() => done("woken")));
      },
      now: () => clock,
      log: () => {},
    });
    const upkeeps: string[] = [];
    const upkeep = new Tender({
      kind: "upkeep",
      settings: { everyMs: HOUR, agents: ["planner"] },
      agents: () => ["planner"],
      unready: () => null,
      tend: async (agent) => {
        upkeeps.push(agent);
        return "quiet";
      },
      now: () => clock,
      log: (line) => logs.push(line),
      said: { woken: (a) => `${a} woke`, quiet: (a) => `${a} stayed asleep`, failed: (a) => `${a} failed` },
    });
    expect(offsetOf("planner", HOUR, "upkeep")).not.toBe(offsetOf("planner", HOUR));
    tend.tick();
    upkeep.tick();
    expect(upkeep.dueAt("planner")).toBe(nextTend("planner", HOUR, clock, "upkeep"));
    expect(tend.dueAt("planner")).toBe(nextTend("planner", HOUR, clock));
    // The tend comes due and is still going when the upkeep comes due: the upkeep waits.
    clock = tend.dueAt("planner") as number;
    tend.tick();
    expect(busy("tend", "planner")).toBe(true);
    clock = Math.max(clock, upkeep.dueAt("planner") as number) + HOUR;
    upkeep.tick();
    expect(upkeeps).toEqual([]);
    releases.shift()?.();
    await tend.idle();
    expect(busy("tend", "planner")).toBe(false);
    upkeep.tick();
    await upkeep.idle();
    expect(upkeeps).toEqual(["planner"]);
    expect(logs).toEqual(["planner stayed asleep"]);
  });

  it("runs one turn by hand, counted in flight so no tender starts another beside it, and only one at once", async () => {
    let release = () => {};
    const first = runNow(
      "upkeep",
      "writer",
      () =>
        new Promise<string>((done) => {
          release = () => done("woken");
        }),
    );
    expect(first).toBeDefined();
    expect(busy("upkeep", "writer")).toBe(true);
    expect(runNow("upkeep", "writer", async () => "again")).toBeUndefined();
    // One at a time holds for every kind and agent, not only this one.
    expect(runNow("upkeep", "planner", async () => "beside")).toBeUndefined();
    expect(runNow("tend", "writer", async () => "beside")).toBeUndefined();
    let clock = Date.parse("2026-10-19T00:00:00Z");
    const started: string[] = [];
    const tender = new Tender({
      settings: { everyMs: HOUR, agents: ["planner"] },
      agents: () => ["planner"],
      unready: () => null,
      tend: async (agent) => {
        started.push(agent);
        return "woken";
      },
      now: () => clock,
      log: () => {},
    });
    tender.tick();
    clock = (tender.dueAt("planner") as number) + 1;
    tender.tick();
    expect(started).toEqual([]);
    release();
    expect(await first).toBe("woken");
    expect(busy("upkeep", "writer")).toBe(false);
  });

  it("skips a turn while an agent can't be tended, and doesn't save it up for after", async () => {
    let paused = true;
    const { tender, tended, logs, pass } = setup({ unready: () => (paused ? "agents are paused" : null) });
    tender.tick();
    await pass(2 * HOUR);
    expect(tended).toHaveLength(0);
    expect(logs.some((l) => /planner's tend skipped: agents are paused/.test(l))).toBe(true);
    paused = false;
    // Lifting the pause wakes nobody at once: each waits for its own time.
    await pass(TEND_TICK_MS);
    expect(tended).toHaveLength(0);
    await pass(HOUR);
    expect(new Set(tended.map((t) => t.agent))).toEqual(new Set(["planner", "writer", "reviewer"]));
  });

  it("wakes nobody on starting, however long it was down: each agent's next time is still ahead", async () => {
    const { tender, tended, now } = setup();
    tender.tick();
    await tender.idle();
    expect(tended).toHaveLength(0);
    for (const agent of ["planner", "writer", "reviewer"]) expect(tender.dueAt(agent)).toBeGreaterThan(now());
  });
});
