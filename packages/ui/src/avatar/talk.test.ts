import { describe, expect, it } from "vitest";
import type { AgentActivity } from "./doing";
import { standsClear } from "./doors";
import {
  byPhone,
  heardThrough,
  SPACING,
  STAND_OFF,
  standBy,
  TALK_APART,
  talkingHere,
  talkMove,
  talkNow,
  talkWords,
  withTalks,
  YOU,
} from "./talk";

const room = { width: 8, depth: 6 };
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The way from `p` to `q`, as the walker keeps a facing. */
const toward = (p: [number, number], q: [number, number]) => Math.atan2(q[0] - p[0], q[1] - p[1]);

describe("standing with someone", () => {
  it("stands near enough to talk, on the side it comes from, facing the one it came to see", () => {
    const host: [number, number] = [1, -1];
    const door: [number, number] = [1, 2.6];
    const { at, facing } = standBy(room, [], host, { from: door });
    expect(dist(at, host)).toBeCloseTo(STAND_OFF, 2);
    // Between the host and the door it came in by.
    expect(at[0]).toBeCloseTo(1, 2);
    expect(at[1]).toBeGreaterThan(host[1]);
    expect(facing).toBeCloseTo(toward(at, host), 5);
  });

  it("goes round the furniture, and stays inside the walls", () => {
    const host: [number, number] = [0, 0];
    // A desk across the side it comes from.
    const desk = { minX: -1, maxX: 1, minZ: 0.4, maxZ: 1.4 };
    const { at } = standBy(room, [desk], host, { from: [0, 2.5] });
    expect(standsClear(room, [desk], at)).toBe(true);
    expect(dist(at, host)).toBeLessThan(STAND_OFF + 0.5);
    // In a corner, it still stands in the room.
    const corner: [number, number] = [3.7, 2.7];
    const there = standBy(room, [], corner, { from: [4, 3] });
    expect(standsClear(room, [], there.at)).toBe(true);
  });

  it("stands several visitors round one agent, never on top of each other", () => {
    const host: [number, number] = [0, -0.5];
    const door: [number, number] = [0, 2.6];
    const taken: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const { at, facing } = standBy(room, [], host, { from: door, others: taken });
      for (const o of taken) expect(dist(at, o)).toBeGreaterThanOrEqual(SPACING);
      expect(facing).toBeCloseTo(toward(at, host), 5);
      taken.push(at);
    }
    // The first came straight in; the next stood either side of it.
    expect(taken[0][0]).toBeCloseTo(0, 2);
    expect(Math.sign(taken[1][0])).toBe(-Math.sign(taken[2][0]));
  });

  it("comes to stand beside you as the camera sees you, never behind you, the side it comes from first", () => {
    const you: [number, number] = [0, 0];
    // The camera south of you, looking north; the agent coming from the north, behind you.
    const eye: [number, number] = [0, 6];
    const plain = standBy(room, [], you, { from: [0, -3] });
    // Without the camera to go by, it stands on the side it came from: right behind you, hidden by you.
    expect(plain.at[1]).toBeLessThan(-0.9);
    const { at, facing } = standBy(room, [], you, { from: [0, -3], eye });
    expect(dist(at, you)).toBeCloseTo(STAND_OFF, 2);
    // Beside you on the screen, a little further from the camera than you are: both in the picture, turned to it.
    expect(Math.abs(at[0])).toBeGreaterThan(0.8);
    expect(at[1]).toBeLessThan(0);
    expect(at[1]).toBeGreaterThan(-0.5);
    expect(facing).toBeCloseTo(toward(at, you), 5);
    // Coming from the east, it stands on your east side; with that side blocked, on the other.
    expect(standBy(room, [], you, { from: [3, -1], eye }).at[0]).toBeGreaterThan(0.8);
    const shelf = { minX: 0.4, maxX: 1.6, minZ: -1.2, maxZ: 0.6 };
    const other = standBy(room, [shelf], you, { from: [3, -1], eye });
    expect(other.at[0]).toBeLessThan(-0.8);
    expect(standsClear(room, [shelf], other.at)).toBe(true);
  });

  it("finds somewhere even when nowhere is clear", () => {
    const host: [number, number] = [0, 0];
    const everything = { minX: -4, maxX: 4, minZ: -3, maxZ: 3 };
    const { at } = standBy(room, [everything], host, { from: [0, 2] });
    expect(at).toEqual([0, STAND_OFF]);
  });
});

const NOW = Date.parse("2026-10-19T12:00:00Z");
const later = (ms: number) => new Date(NOW + ms).toISOString();
const idle = (agent: string): AgentActivity => ({
  agent,
  doing: "idle",
  what: "idle",
  last: { what: "reading", at: later(-60_000) },
});

describe("a talk in words", () => {
  it("says on the phone or face to face, with whom", () => {
    expect(talkWords({ with: "writer", phone: true })).toBe("on the phone with writer");
    expect(talkWords({ with: "writer" })).toBe("talking with writer");
    expect(talkWords({ with: YOU })).toBe("talking with you");
    expect(talkWords({ with: "default", phone: true })).toBe("on the phone with Default agent");
  });

  it("reads a talk while it lasts, and nothing after", () => {
    expect(talkNow({ with: "writer", until: later(1000) }, NOW)?.with).toBe("writer");
    expect(talkNow({ with: "writer", until: later(-1) }, NOW)).toBeUndefined();
    expect(talkNow({ with: "", until: later(1000) }, NOW)).toBeUndefined();
    expect(talkNow({ until: later(1000) }, NOW)).toBeUndefined();
    expect(talkNow(undefined, NOW)).toBeUndefined();
  });
});

describe("activities with the talks going on", () => {
  it("has an idle agent talking, in the talk's words, and leaves out what an idle one did last", () => {
    const out = withTalks({ host: idle("host") }, { host: { with: "guest", phone: true, until: later(5000) } }, NOW);
    expect(out.host).toEqual({
      agent: "host",
      doing: "talking",
      what: "on the phone with guest",
      with: "guest",
      talk: { with: "guest", phone: true },
    });
  });

  it("says face to face for one talking to someone in the same place, as the talk says over the activity", () => {
    const talking: AgentActivity = { agent: "host", doing: "talking", what: "talking to guest", with: "guest" };
    const out = withTalks({ host: talking }, { host: { with: "guest", started: true, until: later(5000) } }, NOW);
    expect(out.host).toMatchObject({ what: "talking with guest", talk: { with: "guest", started: true } });
  });

  it("keeps a thinking or working agent's own words, with the talk alongside", () => {
    const thinking: AgentActivity = { agent: "host", doing: "thinking", what: "thinking" };
    const out = withTalks({ host: thinking }, { host: { with: YOU, phone: true, until: later(5000) } }, NOW);
    expect(out.host).toEqual({ ...thinking, talk: { with: YOU, phone: true } });
  });

  it("leaves alone one talking to someone else, waiting on you, asleep, or whose talk has run out", () => {
    const activities: Record<string, AgentActivity> = {
      a: { agent: "a", doing: "talking", what: "handing work to c", with: "c" },
      b: { agent: "b", doing: "waiting", what: "waiting for your OK" },
      c: { agent: "c", doing: "asleep", what: "asleep" },
      d: idle("d"),
    };
    const talks = {
      a: { with: "b", phone: true, until: later(5000) },
      b: { with: "a", phone: true, until: later(5000) },
      c: { with: "d", until: later(5000) },
      d: { with: "c", until: later(-1) },
    };
    // Nothing changed at all: the very same object comes back.
    expect(withTalks(activities, talks, NOW)).toBe(activities);
  });

  it("takes a call naming the other by its label in rooms as the talk with it, but not one to an agent besides", () => {
    const calling = (label: string): AgentActivity => ({
      agent: "host",
      doing: "talking",
      what: `talking to ${label}`,
      with: label,
    });
    const activities = { guest: idle("guest"), other: idle("other") };
    const talks = { host: { with: "guest", phone: true, started: true, until: later(5000) } };
    for (const label of ["Guest", "GUEST", "guest-", "an-alias-only-rooms-know"])
      expect(withTalks({ ...activities, host: calling(label) }, talks, NOW).host).toMatchObject({
        what: "on the phone with guest",
        talk: { with: "guest", phone: true },
      });
    expect(withTalks({ ...activities, host: calling("Other") }, talks, NOW).host.what).toBe("talking to Other");
  });

  it("has an agent with a talk and no activity yet talking", () => {
    expect(withTalks({}, { guest: { with: "host", until: later(5000) } }, NOW).guest).toMatchObject({
      doing: "talking",
      what: "talking with host",
    });
  });
});

describe("who faces whom", () => {
  const talking = (agent: string, talk: AgentActivity["talk"]): AgentActivity => ({
    agent,
    doing: "talking",
    what: "talking",
    ...(talk ? { with: talk.with, talk } : {}),
  });

  it("turns two in the same place to each other, the one who spoke first walking over", () => {
    const activities = {
      host: talking("host", { with: "guest", started: true }),
      guest: talking("guest", { with: "host" }),
    };
    expect(talkingHere(activities, new Set(["host", "guest", "other"]))).toEqual(
      new Map([
        ["host", { partner: "guest", goes: true }],
        ["guest", { partner: "host", goes: false }],
      ]),
    );
  });

  it("leaves out a talk on the phone, and one with someone who isn't here", () => {
    const activities = {
      host: talking("host", { with: "guest", phone: true, started: true }),
      other: talking("other", { with: "away" }),
    };
    expect(talkingHere(activities, new Set(["host", "guest", "other"])).size).toBe(0);
  });

  it("brings an agent talking with you over to you, and never moves your own body", () => {
    const activities = { host: talking("host", { with: YOU }), [YOU]: talking(YOU, { with: "host", started: true }) };
    expect(talkingHere(activities, new Set([YOU, "host"]))).toEqual(new Map([["host", { partner: YOU, goes: true }]]));
  });

  it("walks only one of two whose messages crossed, both having spoken first", () => {
    const activities = {
      host: talking("host", { with: "guest", started: true }),
      guest: talking("guest", { with: "host", started: true }),
    };
    const kept = talkingHere(activities, new Set(["host", "guest"]));
    expect([kept.get("host")?.goes, kept.get("guest")?.goes]).toEqual([false, true]);
  });
});

describe("keeping company", () => {
  /** The one who spoke first, standing still across the room from the other, who stands still too. */
  const goer = {
    goes: true,
    apart: TALK_APART + 1.5,
    joining: false,
    walking: false,
    seated: false,
    partnerWalking: false,
    partnerCame: false,
    meeting: false,
  };

  it("walks over when they are too far apart to talk, and turns to the other once near enough", () => {
    expect(talkMove(goer)).toBe("join");
    expect(talkMove({ ...goer, apart: 1.2 })).toBe("face");
  });

  it("turns round at once on its way to its desk, rather than going there first", () => {
    expect(talkMove({ ...goer, walking: true })).toBe("join");
    // Even passing near: it stays to talk rather than walking on.
    expect(talkMove({ ...goer, walking: true, apart: 1.2 })).toBe("join");
  });

  it("gets up from its desk to go over, but talks from its seat when near enough", () => {
    expect(talkMove({ ...goer, seated: true })).toBe("join");
    expect(talkMove({ ...goer, seated: true, apart: 1.2 })).toBe("face");
  });

  it("waits while it walks over already, or while the other walks somewhere, and not for the other turning", () => {
    expect(talkMove({ ...goer, walking: true, joining: true })).toBe("wait");
    expect(talkMove({ ...goer, partnerWalking: true })).toBe("wait");
    // The other turning to it where it stands is not walking: it goes all the same.
    expect(talkMove({ ...goer, partnerWalking: false })).toBe("join");
  });

  it("keeps everyone in their seats at a meeting table", () => {
    expect(talkMove({ ...goer, meeting: true, seated: true })).toBe("face");
    expect(talkMove({ ...goer, meeting: true, walking: true })).toBe("wait");
  });

  it("has the other turn to the one who goes, and get up for one that came over, near enough", () => {
    const other = { ...goer, goes: false };
    expect(talkMove(other)).toBe("face");
    expect(talkMove({ ...other, walking: true })).toBe("wait");
    expect(talkMove({ ...other, seated: true, partnerCame: true, apart: 1 })).toBe("rise");
    expect(talkMove({ ...other, seated: true, partnerCame: true, apart: 1, meeting: true })).toBe("face");
    expect(talkMove({ ...other, seated: true, partnerCame: false, apart: 1 })).toBe("face");
  });
});

describe("the phone", () => {
  it("marks a line said down the phone, not one said in a room or to somebody else", () => {
    const talk = { with: "guest", phone: true };
    expect(byPhone({ to: ["guest"] }, talk)).toBe(true);
    expect(byPhone({}, talk)).toBe(true);
    expect(byPhone({ to: ["guest"], room: "local:trip" }, talk)).toBe(false);
    expect(byPhone({ to: ["other"] }, talk)).toBe(false);
    expect(byPhone({ to: ["guest"] }, { with: "guest" })).toBe(false);
    expect(byPhone({ to: ["guest"] }, undefined)).toBe(false);
  });

  it("hears the far side of a call out of the phone of whoever here is on it", () => {
    const activities: Record<string, AgentActivity> = {
      host: { agent: "host", doing: "talking", what: "", talk: { with: "guest", phone: true } },
      other: { agent: "other", doing: "talking", what: "", talk: { with: "guest" } },
    };
    const down = { to: ["host"] };
    expect(heardThrough("guest", down, activities, ["other", "host"])).toBe("host");
    // Face to face is no phone to hear it from, and nobody hears themselves down the line.
    expect(heardThrough("guest", down, activities, ["other"])).toBeUndefined();
    expect(heardThrough("host", { to: ["guest"] }, activities, ["host"])).toBeUndefined();
  });

  it("hears only what is said down the call: not what the far side says in a room, or to somebody else", () => {
    const activities: Record<string, AgentActivity> = {
      host: { agent: "host", doing: "talking", what: "", talk: { with: "guest", phone: true } },
    };
    expect(heardThrough("guest", { to: ["host"], room: "local:trip" }, activities, ["host"])).toBeUndefined();
    expect(heardThrough("guest", { room: "local:trip" }, activities, ["host"])).toBeUndefined();
    expect(heardThrough("guest", { to: ["editor"] }, activities, ["host"])).toBeUndefined();
    // Your own phone, the agent's answer to you.
    const yours: Record<string, AgentActivity> = {
      [YOU]: { agent: YOU, doing: "talking", what: "", talk: { with: "guest", phone: true } },
    };
    expect(heardThrough("guest", { to: [YOU] }, yours, [YOU])).toBe(YOU);
    expect(heardThrough("guest", { to: ["host"], room: "local:trip" }, yours, [YOU])).toBeUndefined();
  });
});
