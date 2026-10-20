import { describe, expect, it } from "vitest";
import { asleepWords } from "../lib/did";
import { type AgentActivity, behaviorFor, chatsAt, seatToTake } from "./doing";
import {
  chatDue,
  chatMove,
  chatPause,
  drawNotes,
  flowRows,
  inkFor,
  isOut,
  notesFrom,
  occupied,
  outingNow,
  outWords,
  talkedAt,
  talkedWords,
  withRoutines,
} from "./routines";
import { type TownPlan, windowLook } from "./town";

const NOW = Date.parse("2026-10-20T12:30:00Z");
const later = "2026-10-20T13:00:00Z";
const idle = (agent: string): AgentActivity => ({ agent, doing: "idle", what: "idle" });

describe("an agent's day, as the world shows it", () => {
  const visits = {
    writer: {
      place: "town",
      until: later,
      spot: "cafe-1-a",
      errand: "cafe",
      with: ["planner"],
      what: "having a coffee at the café",
    },
    planner: {
      place: "town",
      until: later,
      spot: "cafe-1-b",
      errand: "cafe",
      with: ["writer"],
      what: "having a coffee at the café",
    },
    coach: { place: "home:coach", until: later, spot: "bed", errand: "sleep", what: "asleep for the night" },
    guest: {
      place: "home:host",
      until: later,
      spot: "couch",
      errand: "friend",
      with: ["host"],
      what: "dropping in on host",
    },
    talker: { place: "room:local:trip", until: later },
  };
  const activities = Object.fromEntries(
    ["writer", "planner", "coach", "guest", "host", "talker"].map((a) => [a, idle(a)]),
  );

  it("counts those out on their day as out, by where they are: not the host at home, the asleep, or a talk", () => {
    // The status board said "Everyone is idle or asleep" with six out at the café and on benches.
    const shown = withRoutines(
      { ...activities, sitter: idle("sitter") },
      {
        ...visits,
        sitter: { place: "town", until: later, spot: "bench-2", errand: "bench", what: "sitting on a bench" },
      },
      NOW,
    );
    expect(
      Object.keys(shown)
        .filter((a) => isOut(shown[a]))
        .sort(),
    ).toEqual(["guest", "planner", "sitter", "writer"]);
    expect(outWords(shown)).toBe("4 out: café, benches, visiting");
    // Called away to work, it is busy, not out; and nobody out says nothing.
    expect(isOut({ ...shown.writer, doing: "working" })).toBe(false);
    expect(outWords(activities)).toBeUndefined();
  });

  it("says what each is doing out, and who with, in the words the server gave", () => {
    const shown = withRoutines(activities, visits, NOW);
    expect(shown.writer).toMatchObject({ doing: "idle", what: "having a coffee at the café with planner" });
    expect(shown.host).toMatchObject({ doing: "idle", what: "having guest round" });
    // Dropping in on its host, it is with its host by the words already: only other guests are named.
    expect(shown.guest.what).toBe("dropping in on host");
    const two = withRoutines(
      { ...activities, other: idle("other") },
      { ...visits, other: { ...visits.guest, spot: "armchair", with: ["guest", "host"] } },
      NOW,
    );
    expect(two.other.what).toBe("dropping in on host with guest");
    // A visit to talk is no outing: the talk says what it is doing.
    expect(shown.talker).toBe(activities.talker);
  });

  it("puts one to bed for the night until it gets up, said once, and how long it has been idle goes", () => {
    const since = { ...activities, coach: { ...idle("coach"), since: "2026-10-20T02:00:00Z" } };
    const coach = withRoutines(since, visits, NOW).coach;
    expect(coach).toMatchObject({ doing: "asleep", what: "asleep", detail: "overnight", until: later });
    expect(coach.since).toBeUndefined();
    expect(asleepWords(coach, () => "13:00")).toBe("overnight until 13:00");
    // Up close, its tag says it in one line a tag has room for, in a twelve-hour clock too.
    expect(`asleep · ${asleepWords(coach, () => "10:22 AM")}`.length).toBeLessThanOrEqual(34);
    const out = withRoutines(
      { ...activities, writer: { ...idle("writer"), since: "2026-10-20T02:00:00Z" } },
      visits,
      NOW,
    );
    expect(out.writer.since).toBeUndefined();
  });

  it("gives the seat and the company only to bodies in the place on the stage", () => {
    const away = withRoutines(activities, visits, NOW);
    expect(away.writer.routine).toEqual({ errand: "cafe" });
    const here = withRoutines(activities, visits, NOW, "town");
    expect(here.writer.routine).toEqual({ errand: "cafe", spot: "cafe-1-a", with: ["planner"] });
    expect(withRoutines(activities, visits, NOW, "home:host").host.routine).toEqual({
      errand: "host",
      with: ["guest"],
    });
  });

  it("leaves work alone: one busy, waiting or paused isn't out, whatever its record says", () => {
    const busy = { ...activities, writer: { agent: "writer", doing: "working" as const, what: "writing code" } };
    expect(withRoutines(busy, visits, NOW).writer).toBe(busy.writer);
    const paused = {
      ...activities,
      coach: { agent: "coach", doing: "asleep" as const, what: "asleep", detail: "agents are paused" },
    };
    expect(withRoutines(paused, visits, NOW).coach).toBe(paused.coach);
  });

  it("keeps no company that has gone, though the server hasn't said so yet", () => {
    const { planner: _, ...left } = visits;
    const shown = withRoutines(activities, left, NOW, "town");
    expect(shown.writer.routine).toEqual({ errand: "cafe", spot: "cafe-1-a" });
    expect(shown.writer.what).toBe("having a coffee at the café");
    // Called away to work, it is no outing any more: the host still keeps its guest company at home.
    expect(withRoutines(activities, visits, NOW, "home:host").guest.routine?.with).toEqual(["host"]);
  });

  it("lets an outing go once it has run out", () => {
    expect(outingNow(visits.writer, Date.parse(later) + 1)).toBeUndefined();
    expect(withRoutines(activities, visits, Date.parse(later) + 1)).toBe(activities);
    expect(outingNow({ place: "town", until: later }, NOW)).toBeUndefined();
  });

  it("sits a body at its seat with what it went for in its hand, chatting with its company, its words up close", () => {
    const here = withRoutines(activities, visits, NOW, "town");
    expect(behaviorFor(here.writer)).toMatchObject({
      spot: "cafe-1-a",
      stays: true,
      chat: true,
      face: "planner",
      sign: "chat",
      prop: "mug",
      quiet: true,
    });
    // On its own it sits there, quietly, with nothing over its head.
    const alone = withRoutines(
      activities,
      { reader: { place: "town", until: later, spot: "bench-1-a", errand: "read" } },
      NOW,
      "town",
    );
    expect(behaviorFor(alone.reader)).toMatchObject({ spot: "bench-1-a", stays: true, prop: "book" });
    expect(behaviorFor(alone.reader).sign).toBeUndefined();
    // Asleep for the night, it goes to its bed.
    expect(behaviorFor(withRoutines(activities, visits, NOW, "home:coach").coach)).toMatchObject({
      asleep: true,
      sign: "sleep",
      spot: "bed",
    });
    // Not here, it has only the words, and is free to wander.
    expect(behaviorFor(withRoutines(activities, visits, NOW).writer)).toMatchObject({ stays: false });
  });
});

describe("chatting", () => {
  it("waits for a gesture of the body's own to play out, and goes on a little after", () => {
    const c = { n: 0, at: 10 };
    expect(chatDue(c, "writer", 9)).toBeUndefined();
    // An emote it chose is still going at 10: the chat is put off until after it ends at 14.
    expect(chatDue(c, "writer", 10, 14)).toBeUndefined();
    expect(c.at).toBeGreaterThan(14);
    expect(chatDue(c, "writer", 13, 14)).toBeUndefined();
    expect(chatDue(c, "writer", c.at, 14)).toBe(chatMove("writer", 0));
    expect(c.n).toBe(1);
  });

  it("chats wherever it has settled, and a host about its home whenever it has guests", () => {
    expect(chatsAt({ chat: true, spot: "cafe-1-a" }, "cafe-1-a")).toBe(true);
    // Sat at another seat, its own taken: still chatting.
    expect(chatsAt({ chat: true, spot: "cafe-1-a" }, "cafe-1-b")).toBe(true);
    expect(chatsAt({ chat: true, spot: "cafe-1-a" }, undefined)).toBe(false);
    // A host has no seat of its own: on its couch, or between spots.
    expect(chatsAt({ chat: true }, "couch")).toBe(true);
    expect(chatsAt({ chat: true }, undefined)).toBe(true);
    expect(chatsAt({ spot: "cafe-1-a" }, "cafe-1-a")).toBe(false);
  });

  it("sits at its own seat while it is free, and at the nearest free one while someone else has it", () => {
    const spots = [
      { id: "couch", at: [0, 0] as [number, number], activity: "sit" },
      { id: "armchair", at: [2, 0] as [number, number], activity: "sit" },
      { id: "stool", at: [6, 0] as [number, number], activity: "sit" },
      { id: "middle", at: [1, 1] as [number, number] },
    ];
    expect(seatToTake("couch", spots, { x: 1, z: 1, spot: "middle" }, new Set())).toBe("couch");
    // The host is on the couch: the guest takes the armchair, nearest.
    expect(seatToTake("couch", spots, { x: 1, z: 1, spot: "middle" }, new Set(["couch"]))).toBe("armchair");
    // Sat in the armchair already, it stays there until the couch is free.
    expect(seatToTake("couch", spots, { x: 2, z: 0, spot: "armchair", spotActivity: "sit" }, new Set(["couch"]))).toBe(
      undefined,
    );
  });

  it("gestures every few seconds, the same run for the same agent, and two at a table not in step", () => {
    for (let n = 0; n < 20; n++) {
      expect(chatPause("writer", n)).toBeGreaterThanOrEqual(3.5);
      expect(chatPause("writer", n)).toBeLessThanOrEqual(8.5);
    }
    expect(chatPause("writer", 3)).toBe(chatPause("writer", 3));
    const run = (a: string) => Array.from({ length: 6 }, (_, n) => chatMove(a, n));
    expect(new Set(run("writer"))).toEqual(new Set(["chat", "nod", "laugh"]));
    expect(run("writer")).not.toEqual(run("planner"));
  });
});

describe("the buildings with someone in them", () => {
  const plan = {
    buildings: [
      { id: "home:writer", kind: "house" },
      { id: "home:planner", kind: "house" },
      { id: "office", kind: "office" },
      { id: "room:local:campaign", kind: "tavern" },
    ],
  } as unknown as TownPlan;
  it("are those the map has a body in, the office for a meeting room in it", () => {
    const got = occupied(
      [
        { id: "home:writer", agents: ["writer"] },
        { id: "home:planner", agents: [] },
        { id: "room:local:standup", agents: ["coder"] },
        { id: "room:local:campaign", agents: [] },
        { id: "town", agents: ["planner"] },
      ],
      plan,
    );
    expect([...got].sort()).toEqual(["home:writer", "office"]);
  });

  it("light their windows, and the rest go dark at night", () => {
    expect(windowLook("office", 21, undefined, true)).toBe("lit");
    expect(windowLook("office", 21, undefined, false)).toBe("dark");
    expect(windowLook("tavern", 13, undefined, true)).toBe("lit");
    expect(windowLook("tavern", 13, undefined, false)).toBe("day");
    // A home whose owner is out after dark is dark; the town hall is lit every evening.
    expect(windowLook("house", 21, "idle", false)).toBe("dark");
    expect(windowLook("house", 21, "idle", true)).toBe("lit");
    expect(windowLook("hall", 21, undefined, false)).toBe("lit");
    // Not knowing who is in, as before.
    expect(windowLook("office", 21)).toBe("lit");
    expect(windowLook("house", 21, "idle")).toBe("lit");
  });
});

describe("what a meeting room's whiteboard and door say", () => {
  const chatter = {
    room: "standup",
    last: "2026-10-20T12:20:00Z",
    lines: [{ id: "1", who: "planner", agent: "planner", words: "Release notes are due…", at: "2026-10-20T12:20:00Z" }],
  };

  it("writes up its room's last lines, and how long ago it talked", () => {
    expect(notesFrom(chatter, "standup", NOW)).toEqual({
      room: "standup",
      talked: "talked 10 min ago",
      lines: [{ who: "planner", agent: "planner", words: "Release notes are due…", ink: inkFor("planner") }],
    });
    // In the colour planner chose for its body, when it chose one.
    expect(notesFrom(chatter, "standup", NOW, { planner: "#e04040" }).lines[0].ink).toBe("hsl(0 70% 32%)");
    expect(notesFrom(undefined, "standup", NOW)).toEqual({ room: "standup", lines: [] });
    expect(talkedWords(undefined, NOW)).toBeUndefined();
    // When the door says the room talked later (it woke someone since), the board says the same.
    expect(notesFrom(chatter, "standup", NOW, {}, "2026-10-20T12:25:00Z").talked).toBe("talked 5 min ago");
  });

  it("lays a line out as the page does: on from who said it, two rows at most, cut short to fit", () => {
    // Ten units a character, rows a hundred wide.
    const measure = (s: string) => s.length * 10;
    expect(flowRows("Train booked for Friday", 30, 100, measure)).toEqual(["Train", "booked…"]);
    expect(flowRows("Done.", 30, 100, measure)).toEqual(["Done."]);
    expect(flowRows("All set", 30, 100, measure)).toEqual(["All set"]);
    // A name taking most of the first row: the words start on the next.
    expect(flowRows("All set", 80, 100, measure)).toEqual(["", "All set"]);
    expect(flowRows("We should book the train now", 80, 100, measure)).toEqual(["", "We should…"]);
  });

  it("leaves a whiteboard with nothing to say about a room clean, and says so only in a meeting room", () => {
    const said: string[] = [];
    const ctx = {
      fillRect: () => {},
      fillText: (text: string) => said.push(text),
      measureText: () => ({ width: 10 }),
    };
    const canvas = { width: 640, height: 418, getContext: () => ctx } as unknown as HTMLCanvasElement;
    drawNotes(canvas, undefined);
    expect(said).toEqual([]);
    drawNotes(canvas, { room: "standup", lines: [] });
    expect(said).toEqual(["#standup", "Nothing said here yet."]);
  });

  it("takes the later of what a room said and when the map saw it wake someone", () => {
    expect(
      talkedAt({ "room:local:standup": chatter }, [
        { id: "room:local:standup", talked: "2026-10-20T11:00:00Z" },
        { id: "room:local:trip", talked: "2026-10-20T10:00:00Z" },
        { id: "room:local:quiet" },
      ]),
    ).toEqual({ "room:local:standup": "2026-10-20T12:20:00Z", "room:local:trip": "2026-10-20T10:00:00Z" });
  });

  it("writes each name in the colour its body is drawn in, and a person's plainly", () => {
    expect(inkFor("planner")).toMatch(/^hsl\(\d+ 60% 32%\)$/);
    expect(inkFor("planner", "#3080e0")).toMatch(/^hsl\(21\d 70% 32%\)$/);
    expect(inkFor(undefined)).toBe("#3b4252");
  });
});
