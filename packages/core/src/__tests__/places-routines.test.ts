import { describe, expect, it, vi } from "vitest";
import { homePlace, meetingRoom, sharedPlace } from "../plugins/places-rooms.js";
import {
  AFTER_WORK,
  bedIn,
  type DayOf,
  DENSITY,
  dayNow,
  dayPlan,
  decide,
  dmOf,
  type Errand,
  type Everyone,
  errandWeights,
  HOME_BEFORE_WAKE,
  hoursOf,
  isOuting,
  minuteOf,
  outingWords,
  parseRoutines,
  Routines,
  type Seat,
  sameOuting,
  seatEveryone,
  seatsIn,
  tiesFrom,
  townSeats,
  type Visit,
} from "../plugins/places-routines.js";
import { townPlace } from "../plugins/places-town.js";
import { layWorld } from "../plugins/places-world.js";

const NAMES = ["analyst", "archivist", "artist", "coach", "coder", "editor", "planner", "reporter", "tutor", "writer"];
const day = (agent: string, density: DayOf["density"] = "normal", role?: string): DayOf => ({
  agent,
  ...(role ? { role } : {}),
  hours: hoursOf(agent, role),
  density,
});

describe("the routines setting", () => {
  it("is on, at normal, unless said otherwise, and off when asked", () => {
    expect(parseRoutines(undefined)).toBe("normal");
    expect(parseRoutines(true)).toBe("normal");
    expect(parseRoutines("busy")).toBe("busy");
    expect(parseRoutines("quiet")).toBe("quiet");
    expect(parseRoutines("off")).toBeNull();
    expect(parseRoutines(false)).toBeNull();
    expect(parseRoutines("loud")).toEqual({ problem: expect.stringMatching(/quiet, normal, busy or off/) });
  });
});

describe("an agent's hours", () => {
  it("are its own, the same every time, up in the morning and in bed at night", () => {
    for (const agent of NAMES) {
      const h = hoursOf(agent);
      expect(hoursOf(agent)).toEqual(h);
      expect(h.wake, agent).toBeGreaterThanOrEqual(6 * 60);
      expect(h.wake, agent).toBeLessThanOrEqual(9 * 60);
      expect(h.sleep, agent).toBeGreaterThanOrEqual(21 * 60);
      expect(h.sleep, agent).toBeLessThanOrEqual(24 * 60 + 30);
    }
    expect(new Set(NAMES.map((a) => hoursOf(a).wake)).size).toBeGreaterThan(5);
  });

  it("start earlier for an early role and later for a late one", () => {
    expect(hoursOf("analyst", "housekeeper").wake).toBeLessThan(hoursOf("analyst").wake);
    expect(hoursOf("analyst", "coder").sleep).toBeGreaterThan(hoursOf("analyst").sleep);
  });

  it("are round the hours an agent keeps of its own, and never all day", () => {
    const h = hoursOf("analyst", undefined, { start: "05:00", end: "23:30" });
    expect(h.wake).toBe(4 * 60 + 30);
    expect(h.sleep).toBeGreaterThanOrEqual(24 * 60 + 30);
    // Round the clock still sleeps a while.
    const always = hoursOf("analyst", undefined, { start: "00:00", end: "23:59" });
    expect(always.wake).toBeGreaterThanOrEqual(240);
    expect(always.sleep - always.wake).toBeLessThanOrEqual(20 * 60);
    // Hours past midnight count on into the next day.
    expect(hoursOf("analyst", undefined, { start: "20:00", end: "02:00" }).sleep).toBeGreaterThan(24 * 60);
    expect(minuteOf("7:05")).toBe(425);
    expect(minuteOf("25:00")).toBeUndefined();
  });
});

describe("an agent's day", () => {
  it("runs from getting up to going to bed without a gap, home first and last", () => {
    for (const agent of NAMES)
      for (let d = 0; d < 20; d++) {
        const of = day(agent);
        const plan = dayPlan(of, 20_000 + d);
        expect(plan[0].from).toBe(of.hours.wake);
        expect(plan.at(-1)?.to).toBe(of.hours.sleep);
        expect(plan[0].errand).toBeUndefined();
        expect(plan.at(-1)?.errand).toBeUndefined();
        for (let i = 1; i < plan.length; i++) expect(plan[i].from).toBe(plan[i - 1].to);
        // Out for half an hour to eighty minutes at a time, a few times an hour at most.
        for (const s of plan.filter((x) => x.errand)) {
          expect(s.to - s.from).toBeGreaterThanOrEqual(30);
          expect(s.to - s.from).toBeLessThanOrEqual(80);
        }
      }
  });

  it("is the same day for the same agent and date, and another day the next", () => {
    expect(dayPlan(day("coder"), 20_100)).toEqual(dayPlan(day("coder"), 20_100));
    expect(dayPlan(day("coder"), 20_101)).not.toEqual(dayPlan(day("coder"), 20_100));
  });

  it("spends about the density's share of its waking day out", () => {
    for (const density of ["quiet", "normal", "busy"] as const) {
      let out = 0;
      let awake = 0;
      for (const agent of NAMES)
        for (let d = 0; d < 30; d++) {
          const plan = dayPlan(day(agent, density), 20_000 + d);
          awake += plan.at(-1)?.to ?? 0;
          awake -= plan[0].from;
          out += plan.filter((s) => s.errand).reduce((n, s) => n + s.to - s.from, 0);
        }
      const share = DENSITY[density].share;
      expect(out / awake, density).toBeGreaterThan(share * 0.6);
      expect(out / awake, density).toBeLessThan(share * 1.25);
    }
  });

  it("leans to coffee in the morning and the park in the evening, and to what its role likes", () => {
    const morning = errandWeights(9);
    const evening = errandWeights(19);
    expect(morning.cafe / morning.park).toBeGreaterThan(evening.cafe / evening.park);
    expect(evening.park).toBeGreaterThan(morning.park);
    expect(errandWeights(15, "researcher").read).toBe(errandWeights(15).read * 2);
    // Over many days, mornings out are coffee more often than evenings out are.
    const counts = { morning: { cafe: 0, all: 0 }, evening: { cafe: 0, park: 0, all: 0 } };
    for (const agent of NAMES)
      for (let d = 0; d < 60; d++)
        for (const s of dayPlan(day(agent, "busy"), 20_000 + d)) {
          if (!s.errand) continue;
          const hour = (s.from + s.to) / 120;
          if (hour < 11) {
            counts.morning.all++;
            if (s.errand === "cafe") counts.morning.cafe++;
          } else if (hour >= 18) {
            counts.evening.all++;
            if (s.errand === "cafe") counts.evening.cafe++;
            if (s.errand === "park") counts.evening.park++;
          }
        }
    expect(counts.morning.cafe / counts.morning.all).toBeGreaterThan(counts.evening.cafe / counts.evening.all + 0.15);
    expect(counts.evening.park / counts.evening.all).toBeGreaterThan(0.25);
  });

  it("is asleep before getting up and after bed, and still up past midnight on the day before", () => {
    const of: DayOf = { agent: "coder", hours: { wake: 480, sleep: 1500 }, density: "normal" };
    expect(dayNow(of, 20_000, 300)).toEqual({ asleep: true, left: 180 });
    // 00:30 the next day, with bed at 01:00: still the day before's evening, at home.
    expect(dayNow(of, 20_001, 30)).toMatchObject({ asleep: false, left: 30 });
    expect(dayNow(of, 20_001, 60)).toEqual({ asleep: true, left: 420 });
    const early: DayOf = { agent: "coder", hours: { wake: 420, sleep: 1320 }, density: "normal" };
    expect(dayNow(early, 20_000, 1330)).toEqual({ asleep: true, left: 420 + 1440 - 1330 });
    // In the day, the stretch it is in, and what is left of it.
    const plan = dayPlan(early, 20_000);
    const out = plan.find((s) => s.errand);
    expect(dayNow(early, 20_000, (out?.from ?? 0) + 5)).toEqual({
      asleep: false,
      errand: out?.errand,
      left: (out?.to ?? 0) - (out?.from ?? 0) - 5,
    });
  });
});

describe("where everyone sits", () => {
  const cafe = (table: number, letter: string): Seat => ({
    place: "town",
    spot: `cafe-${table}-${letter}`,
    group: `town\ncafe-${table}`,
    kind: "cafe",
    where: "at the café",
  });
  const bench = (n: number, letter: string): Seat => ({
    place: "town",
    spot: `bench-${n}-${letter}`,
    group: `town\nbench-${n}`,
    kind: "bench",
    where: "on a bench on the square",
  });
  const seats = [cafe(1, "a"), cafe(1, "b"), cafe(2, "a"), cafe(2, "b"), bench(1, "a"), bench(1, "b")];
  const none = () => [] as string[];
  const opts = { held: new Map(), ties: none, hosts: new Set<string>(), most: 10, seed: "s" };

  it("puts each at a table of its own before it sits with strangers", () => {
    const sat = seatEveryone(
      [
        { agent: "a", errand: "cafe" },
        { agent: "b", errand: "cafe" },
      ],
      seats,
      opts,
    );
    expect(new Set(sat.map((s) => s.seat.group)).size).toBe(2);
    expect(sat.every((s) => s.with.length === 0)).toBe(true);
  });

  it("sits with someone it knows, and they keep each other company", () => {
    const ties = (a: string) => (a === "a" ? ["b"] : a === "b" ? ["a"] : []);
    const sat = seatEveryone(
      [
        { agent: "a", errand: "cafe" },
        { agent: "b", errand: "cafe" },
      ],
      seats,
      { ...opts, ties },
    );
    expect(sat[0].seat.group).toBe(sat[1].seat.group);
    expect(sat.find((s) => s.agent === "a")?.with).toEqual(["b"]);
    expect(sat.find((s) => s.agent === "b")?.with).toEqual(["a"]);
  });

  it("keeps a seat it already has, and gives no seat twice", () => {
    const held = new Map([["b", { place: "town", spot: "cafe-2-b" }]]);
    const sat = seatEveryone(
      [
        { agent: "a", errand: "cafe" },
        { agent: "b", errand: "cafe" },
        { agent: "c", errand: "cafe" },
        { agent: "d", errand: "cafe" },
        { agent: "e", errand: "cafe" },
      ],
      seats,
      { ...opts, held },
    );
    expect(sat.find((s) => s.agent === "b")?.seat.spot).toBe("cafe-2-b");
    const spots = sat.map((s) => s.seat.spot);
    expect(new Set(spots).size).toBe(spots.length);
    // Four chairs at the café; the fifth sits on the bench.
    expect(sat.filter((s) => s.errand === "cafe")).toHaveLength(4);
    expect(sat.filter((s) => s.errand === "bench")).toHaveLength(1);
  });

  it("does what it can where there is room for it, reading wherever it sits", () => {
    const sat = seatEveryone(
      [
        { agent: "a", errand: "meeting" },
        { agent: "b", errand: "read" },
      ],
      seats,
      opts,
    );
    expect(sat.find((s) => s.agent === "a")).toMatchObject({ errand: "cafe" });
    expect(sat.find((s) => s.agent === "b")).toMatchObject({ errand: "read", seat: { kind: "bench" } });
    expect(outingWords("read", sat.find((s) => s.agent === "b")?.seat)).toBe("reading on a bench on the square");
  });

  it("seats only a room's members in its meeting room, round the one table", () => {
    const room = meetingRoom("standup", 4);
    const meeting = seatsIn("room:local:standup", room, {
      kind: "meeting",
      where: "#standup's meeting room",
      members: ["a", "b"],
    });
    expect(meeting.map((s) => s.spot).sort()).toEqual(["seat-1", "seat-2", "seat-3", "seat-4"]);
    const sat = seatEveryone(
      [
        { agent: "a", errand: "meeting" },
        { agent: "b", errand: "meeting" },
        { agent: "c", errand: "meeting" },
      ],
      [...meeting, ...seats],
      opts,
    );
    expect(sat.find((s) => s.agent === "a")?.seat.place).toBe("room:local:standup");
    expect(sat.find((s) => s.agent === "b")?.seat.place).toBe("room:local:standup");
    expect(sat.find((s) => s.agent === "a")?.with).toEqual(["b"]);
    expect(sat.find((s) => s.agent === "c")?.seat.place).toBe("town");
  });

  it("drops in only on someone it knows who is home with nothing on, never in its bed", () => {
    const home = homePlace("home:planner", "planner's room");
    const visit = seatsIn("home:planner", home, { kind: "friend", where: "planner", host: "planner" });
    expect(visit.length).toBeGreaterThan(0);
    const kindOf = new Map(home.props.map((p) => [p.id, p.kind]));
    for (const s of visit) expect(kindOf.get(home.spots.find((x) => x.id === s.spot)?.item ?? "")).not.toBe("bed");
    const ties = (a: string) => (a === "a" ? ["planner"] : []);
    const want = [
      { agent: "a", errand: "friend" as Errand },
      { agent: "b", errand: "friend" as Errand },
    ];
    const home_ = seatEveryone(want, [...visit, ...seats], { ...opts, ties, hosts: new Set(["planner"]) });
    expect(home_.find((s) => s.agent === "a")).toMatchObject({ errand: "friend", with: ["planner"] });
    expect(home_.find((s) => s.agent === "b")?.errand).toBe("cafe");
    // The host out, or busy: nobody drops in.
    const out = seatEveryone(want, [...visit, ...seats], { ...opts, ties, hosts: new Set() });
    expect(out.find((s) => s.agent === "a")?.errand).toBe("cafe");
  });

  it("reads alone in a shared place", () => {
    const lounge = sharedPlace("shared:lounge", "the lounge");
    const reading = seatsIn("shared:lounge", lounge, { kind: "read", where: "in the lounge" });
    expect(new Set(reading.map((s) => s.group)).size).toBe(reading.length);
    const sat = seatEveryone(
      [
        { agent: "a", errand: "read" },
        { agent: "b", errand: "read" },
      ],
      reading,
      opts,
    );
    expect(sat.every((s) => s.with.length === 0 && s.seat.place === "shared:lounge")).toBe(true);
    expect(outingWords("read", sat[0].seat)).toBe("reading in the lounge");
  });

  it("lets no more out than the density allows", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ agent: `x${i}`, errand: "cafe" as Errand }));
    expect(seatEveryone(many, seats, { ...opts, most: 3 })).toHaveLength(3);
  });
});

describe("the town's seats", () => {
  const world = layWorld([
    ...NAMES.map((n) => ({ id: `home:${n}`, name: n, kind: "home" as const, owner: n })),
    { id: "room:local:a", name: "a", kind: "room" as const },
  ]);
  const town = townPlace(world.town);
  const seats = townSeats("town", town);

  it("are the café's chairs, two to a table, and both halves of every bench", () => {
    const by = (kind: Errand) => seats.filter((s) => s.kind === kind);
    expect(by("cafe")).toHaveLength(6);
    expect(new Set(by("cafe").map((s) => s.group)).size).toBe(3);
    expect(by("bench")).toHaveLength(8);
    expect(by("park")).toHaveLength(8);
    for (const s of seats) expect(town.spots.find((x) => x.id === s.spot)?.activity, s.spot).toBe("sit");
  });

  it("face each other at a café table, and sit side by side on a bench", () => {
    const spot = (id: string) => town.spots.find((s) => s.id === id);
    const [a, b] = [spot("cafe-2-a"), spot("cafe-2-b")];
    expect(Math.abs(Math.abs((a?.facing ?? 0) - (b?.facing ?? 0)) - 180)).toBeLessThan(1);
    const table = town.props.find((p) => p.id === "cafe-2");
    // Where you stand to sit is clear of the table top; where you sit is the chair.
    for (const s of [a, b]) {
      const off = Math.hypot((s?.at[0] ?? 0) - (table?.at[0] ?? 0), (s?.at[1] ?? 0) - (table?.at[1] ?? 0));
      expect(off).toBeGreaterThan(0.36);
      expect(s?.seat).toBeDefined();
    }
    const [l, r] = [spot("bench-1-a"), spot("bench-1-b")];
    expect(l?.facing).toBe(r?.facing);
    expect(
      Math.hypot((l?.seat?.at[0] ?? 0) - (r?.seat?.at[0] ?? 0), (l?.seat?.at[1] ?? 0) - (r?.seat?.at[1] ?? 0)),
    ).toBeCloseTo(0.64, 1);
  });

  it("put a sleeping agent in its bed, or on the couch without one", () => {
    const home = homePlace("home:planner", "planner's room");
    const bed = bedIn(home);
    expect(bed).toBeDefined();
    const kindOf = new Map(home.props.map((p) => [p.id, p.kind]));
    const item = home.spots.find((s) => s.id === bed)?.item ?? "";
    expect(["bed", "couch"]).toContain(kindOf.get(item));
  });
});

describe("who knows whom", () => {
  it("counts direct messages over shared rooms, best first, five at most, never itself", () => {
    const ties = tiesFrom(
      [{ members: ["a", "b", "c"] }, { members: ["a", "c"] }, { members: ["a", "d", "e", "f", "g", "h"] }],
      [
        { from: "a", to: "h", count: 3 },
        { from: "b", to: "a", count: 1 },
      ],
    );
    expect(ties.get("a")?.[0]).toBe("h");
    expect(ties.get("a")?.[1]).toBe("b");
    expect(ties.get("a")).toHaveLength(5);
    expect(ties.get("a")).not.toContain("a");
    expect(ties.get("h")).toContain("a");
    expect(dmOf("dm:planner:writer")).toEqual({ from: "planner", to: "writer" });
    expect(dmOf("room:all:writer")).toBeUndefined();
  });
});

describe("deciding where everyone is", () => {
  // 12:30 on a day, local and UTC alike.
  const DAY = 20_000;
  const at = DAY * 86_400_000 + 12 * 3_600_000 + 30 * 60_000 + 17_000;
  const all = (over: Partial<Everyone> = {}): Everyone => ({
    agents: ["a", "b"],
    now: { at, day: DAY, minute: 12 * 60 + 30 },
    density: "normal",
    // Out on an errand the whole day long.
    dayOf: (agent) => ({ agent, hours: { wake: 420, sleep: 1380 }, density: "normal" }),
    activities: new Map(),
    visits: new Map(),
    seats: [
      { place: "town", spot: "cafe-1-a", group: "t1", kind: "cafe", where: "at the café" },
      { place: "town", spot: "cafe-1-b", group: "t1", kind: "cafe", where: "at the café" },
      { place: "town", spot: "bench-1-a", group: "b1", kind: "bench", where: "on a bench on the square" },
      { place: "town", spot: "pond-bench-a", group: "p1", kind: "park", where: "on a bench by the pond" },
    ],
    ties: () => [],
    homes: new Map([
      ["a", { place: "home:a", bed: "bed" }],
      ["b", { place: "home:b" }],
    ]),
    ...over,
  });
  // The minute both agents' days have them out.
  const outAt = (() => {
    for (let m = 420; m < 1380; m++) {
      const both = ["a", "b"].every((agent) => {
        const now = dayNow({ agent, hours: { wake: 420, sleep: 1380 }, density: "normal" }, DAY, m);
        return !now.asleep && now.errand;
      });
      if (both) return m;
    }
    throw new Error("no minute with both out");
  })();
  const outNow = (over: Partial<Everyone> = {}) =>
    all({ now: { at: DAY * 86_400_000 + outAt * 60_000 + 17_000, day: DAY, minute: outAt }, ...over });

  it("sends those with nothing to do out, with words for what they are doing", () => {
    const got = decide(outNow());
    for (const agent of ["a", "b"]) {
      const v = got.get(agent);
      expect(v, agent).toMatchObject({ place: "town", errand: expect.any(String), what: expect.any(String) });
      expect(isOuting(v ?? undefined)).toBe(true);
    }
  });

  it("ends every outing for a stretch at the same time, however far into a minute it looks", () => {
    const first = decide(outNow()).get("a");
    const later = decide(
      outNow({ now: { at: DAY * 86_400_000 + outAt * 60_000 + 59_000, day: DAY, minute: outAt } }),
    ).get("a");
    expect(later?.until).toBe(first?.until);
    expect(sameOuting(first ?? undefined, later ?? null)).toBe(true);
  });

  it("leaves a body that is busy, paused or due to wake at home, and one gone to talk where it is", () => {
    const soon = new Date(DAY * 86_400_000 + outAt * 60_000 + (HOME_BEFORE_WAKE - 2) * 60_000).toISOString();
    const got = decide(
      outNow({
        agents: ["a", "b", "c", "d"],
        activities: new Map([
          ["a", { doing: "working" }],
          ["b", { doing: "asleep" }],
          ["c", { doing: "idle", next: soon }],
        ]),
        visits: new Map([["d", { place: "room:local:trip", until: "2099-01-01T00:00:00Z" }]]),
      }),
    );
    expect(got.get("a")).toBeNull();
    expect(got.get("b")).toBeNull();
    expect(got.get("c")).toBeNull();
    expect(got.has("d")).toBe(false);
  });

  it("lets an agent that just did something finish up at home, but not call one already out back", () => {
    const now = DAY * 86_400_000 + outAt * 60_000;
    const just = new Date(now - (AFTER_WORK - 3) * 60_000).toISOString();
    const activities = new Map([["a", { doing: "idle", last: { at: just } }]]);
    expect(decide(outNow({ activities })).get("a")).toBeNull();
    const out: Visit = { place: "town", until: "2099-01-01T00:00:00Z", spot: "bench-1-a", errand: "bench" };
    expect(decide(outNow({ activities, visits: new Map([["a", out]]) })).get("a")).toMatchObject({ place: "town" });
  });

  it("leaves one where it chose to be itself, and ends any outing it was on", () => {
    const out: Visit = { place: "town", until: "2099-01-01T00:00:00Z", spot: "bench-1-a", errand: "bench" };
    const got = decide(outNow({ chose: new Set(["a"]), visits: new Map([["a", out]]) }));
    expect(got.get("a")).toBeNull();
    expect(got.get("b")).toMatchObject({ place: "town" });
  });

  it("keeps one a person sent home there, until the outing it was on would have ended", () => {
    const now = DAY * 86_400_000 + outAt * 60_000;
    expect(decide(outNow({ sentHome: new Map([["a", now + 10 * 60_000]]) })).get("a")).toBeNull();
    expect(decide(outNow({ sentHome: new Map([["a", now - 1]]) })).get("a")).toMatchObject({ place: "town" });
  });

  it("puts everyone to bed at night, in bed, until it gets up", () => {
    const night = all({ now: { at: DAY * 86_400_000 + 2 * 3_600_000, day: DAY, minute: 120 } });
    const got = decide(night);
    expect(got.get("a")).toMatchObject({ place: "home:a", spot: "bed", errand: "sleep", what: "asleep for the night" });
    expect(got.get("a")?.until).toBe(new Date(DAY * 86_400_000 + 420 * 60_000).toISOString());
    expect(got.get("b")).toMatchObject({ place: "home:b", errand: "sleep" });
    expect(got.get("b")?.spot).toBeUndefined();
  });

  it("keeps those at one table together, each the other's company", () => {
    const got = decide(outNow({ ties: () => ["a", "b"], seats: all().seats.filter((s) => s.kind === "cafe") }));
    const a = got.get("a");
    const b = got.get("b");
    // Whatever their errands, the café's two chairs are all there is.
    expect(a?.place).toBe("town");
    expect(b?.place).toBe("town");
    expect(a?.with).toEqual(["b"]);
    expect(b?.with).toEqual(["a"]);
  });
});

describe("the minute's look", () => {
  it("writes only what changed, and nothing for one at home that stays home", async () => {
    const DAY = 20_000;
    const keep = vi.fn(async () => {});
    let visits = new Map<string, Visit>();
    const look = async (): Promise<Everyone> => ({
      agents: ["a"],
      now: { at: DAY * 86_400_000 + 2 * 3_600_000, day: DAY, minute: 120 },
      density: "normal",
      dayOf: (agent) => ({ agent, hours: { wake: 420, sleep: 1380 }, density: "normal" }),
      activities: new Map(),
      visits,
      seats: [],
      ties: () => [],
      homes: new Map([["a", { place: "home:a" }]]),
    });
    const routines = new Routines({ look, keep });
    await routines.tick();
    expect(keep).toHaveBeenCalledTimes(1);
    const written = (keep.mock.calls[0] as unknown as [string, Visit])[1];
    visits = new Map([["a", written]]);
    await routines.tick();
    expect(keep).toHaveBeenCalledTimes(1);
    // Paused: the night's sleep ends, once.
    const busy = async () => ({ ...(await look()), activities: new Map([["a", { doing: "working" }]]) });
    const again = new Routines({ look: busy, keep });
    await again.tick();
    expect(keep).toHaveBeenLastCalledWith("a", null);
    visits = new Map();
    await again.tick();
    expect(keep).toHaveBeenCalledTimes(2);
  });
});
