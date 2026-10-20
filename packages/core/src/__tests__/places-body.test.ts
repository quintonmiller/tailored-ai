/**
 * Bodies: an agent choosing how its body looks and carries itself, making a
 * gesture, and going to a spot to stay there. Words are read the way a model
 * writes them ("sit on the couch", "waving", "half an hour"), every part of a
 * change is checked before anything is written, and a stay ends when its time
 * runs out.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { endStays, homeId, WHEREABOUTS_TYPE } from "../plugins/places.js";
import {
  BODY_TYPE,
  type BodyData,
  BodyTool,
  type BodyWorld,
  bodyWith,
  changeBody,
  changeFrom,
  chosenNow,
  durationFrom,
  EMOTE_MOST_MS,
  EMOTE_TYPE,
  EMOTES,
  emoteFrom,
  errandsFrom,
  looksOf,
  spotIn,
  spotsToGo,
  spotWords,
  stayWords,
  WEAR_TYPE,
} from "../plugins/places-body.js";
import { firstHome, type Place } from "../plugins/places-layout.js";
import { readRole } from "../plugins/places-roles.js";
import "../state/builtin.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";

const home = (): Place => firstHome("planner's room");
/** A home with a bookcase its agent made with the `build` tool put in it, and a clock it made on the desk. */
const madeHome = (): Place => {
  const place = home();
  return {
    ...place,
    props: [
      ...place.props,
      {
        id: "model",
        name: "the bookcase",
        kind: "model",
        at: [-1.2, -1],
        facing: 0,
        model: "planner:bookcase",
        size: [0.9, 1.6, 0.35],
      },
      { id: "small_model", name: "the clock", kind: "small_model", at: [0, 0], facing: 0, on: "desk" },
    ],
  };
};

describe("reading a change to a body", () => {
  const models = ["robot.vrm", "fox.vrm"];

  it("takes a colour by name or hex, and back to its own with default", () => {
    expect(changeFrom({ color: "teal" }, models)).toEqual({
      change: { color: "#2a8a8a", colorName: "teal" },
      said: ["you're teal"],
    });
    expect(changeFrom({ color: "#FF8800" }, models)).toMatchObject({ change: { color: "#ff8800", colorName: null } });
    expect(changeFrom({ color: "dark red" }, models)).toMatchObject({ change: { colorName: "dark red" } });
    expect(changeFrom({ color: "default" }, models)).toMatchObject({ change: { color: null, colorName: null } });
    expect(changeFrom({ color: "sparkly" }, models)).toEqual({
      problem: expect.stringMatching(/"sparkly" isn't a colour I know/),
    });
  });

  it("takes a model the deployment has, with or without its extension, and says which there are", () => {
    expect(changeFrom({ model: "fox" }, models)).toMatchObject({ change: { model: "fox.vrm" } });
    expect(changeFrom({ model: "FOX.vrm" }, models)).toMatchObject({ change: { model: "fox.vrm" } });
    expect(changeFrom({ model: "default" }, models)).toMatchObject({ change: { model: null } });
    expect(changeFrom({ model: "dragon" }, models)).toEqual({
      problem: 'There\'s no model called "dragon". You can be drawn in: robot.vrm, fox.vrm.',
    });
  });

  it("keeps a size within limits, and normal size is no choice at all", () => {
    expect(changeFrom({ size: 1.234 }, models)).toMatchObject({ change: { size: 1.23 } });
    expect(changeFrom({ size: 1 }, models)).toMatchObject({ change: { size: null } });
    expect(changeFrom({ size: 2 }, models)).toEqual({ problem: "`size` is 0.6 to 1.4, where 1 is normal." });
    expect(changeFrom({ size: 0.5 }, models)).toHaveProperty("problem");
  });

  it("reads idle style, posture and walk by their words, and default takes each back", () => {
    expect(changeFrom({ idle: "sleepy", posture: "Arms Folded", walk: "brisk" }, models)).toEqual({
      change: { idle: "sleepy", posture: "arms folded", walk: "brisk" },
      said: ["you're sleepy when idle", "you stand with your arms folded", "you walk with a brisk step"],
    });
    expect(changeFrom({ posture: "relaxed", walk: "default" }, models)).toMatchObject({
      change: { posture: null, walk: null },
    });
    expect(changeFrom({ walk: "moonwalk" }, models)).toEqual({
      problem: expect.stringMatching(/"moonwalk" isn't a way to walk\. It is one of: brisk, stroll/),
    });
  });

  it("reads what it likes doing when idle in plain words", () => {
    expect(errandsFrom("coffee, reading and the plants")).toEqual(["coffee", "read", "water"]);
    expect(errandsFrom(["naps", "TV"])).toEqual(["nap", "tv"]);
    expect(errandsFrom("none")).toEqual([]);
    expect(errandsFrom("juggling")).toEqual({ problem: expect.stringMatching(/"juggling" isn't something to do/) });
    expect(changeFrom({ errands: "anything" }, models)).toMatchObject({ change: { errands: null } });
  });

  it("changes nothing when any part of it is wrong, and says what was wrong", () => {
    expect(changeFrom({ color: "teal", size: 9, wear: "cap" }, models)).toEqual({
      problem: "`size` is 0.6 to 1.4, where 1 is normal.",
    });
    expect(changeFrom({ wear: "cap, beret" }, models)).toEqual({
      problem: expect.stringMatching(/a cap and a beret both go on the head/),
    });
  });

  it("makes a record from a change: fields set, and taken back when null", () => {
    const was: BodyData = { color: "#2a8a8a", colorName: "teal", size: 1.2 };
    expect(bodyWith(was, { color: null, colorName: null, walk: "bouncy" })).toEqual({ size: 1.2, walk: "bouncy" });
  });
});

describe("gestures and lengths of time, in a model's words", () => {
  it("knows a gesture by its name, the way it is written in a sentence, or another word for it", () => {
    expect(emoteFrom("wave")).toBe("wave");
    expect(emoteFrom("Waving")).toBe("wave");
    expect(emoteFrom("waves")).toBe("wave");
    expect(emoteFrom("danced")).toBe("dance");
    // A consonant doubled before the ending.
    expect(emoteFrom("clapping")).toBe("clap");
    expect(emoteFrom("clapped")).toBe("clap");
    expect(emoteFrom("nodding")).toBe("nod");
    expect(emoteFrom("nodded")).toBe("nod");
    expect(emoteFrom("shrugging")).toBe("shrug");
    expect(emoteFrom("hopping")).toBe("jump");
    expect(emoteFrom("hooray")).toBe("cheer");
    expect(emoteFrom("yes")).toBe("nod");
    expect(emoteFrom("juggle")).toBeUndefined();
    // Every gesture is its own name.
    for (const e of EMOTES) expect(emoteFrom(e)).toBe(e);
  });

  it("reads a length of time, a bare number in the unit given", () => {
    expect(durationFrom("30s", "minutes")).toBe(30_000);
    expect(durationFrom("20 seconds", "minutes")).toBe(20_000);
    expect(durationFrom("2 min", "seconds")).toBe(120_000);
    expect(durationFrom("half an hour", "seconds")).toBe(1_800_000);
    // An article before the unit is part of the phrase, with or without "for".
    expect(durationFrom("an hour", "seconds")).toBe(3_600_000);
    expect(durationFrom("for an hour", "seconds")).toBe(3_600_000);
    expect(durationFrom("a minute", "seconds")).toBe(60_000);
    expect(durationFrom("A moment", "seconds")).toBe(60_000);
    expect(durationFrom("1.5 hours", "seconds")).toBe(5_400_000);
    expect(durationFrom("for 10 minutes", "seconds")).toBe(600_000);
    expect(durationFrom(15, "seconds")).toBe(15_000);
    expect(durationFrom("15", "minutes")).toBe(900_000);
    expect(durationFrom("a while", "minutes")).toEqual({ problem: expect.stringMatching(/isn't a length of time/) });
    expect(durationFrom(-3, "minutes")).toHaveProperty("problem");
  });
});

describe("where in a place words mean", () => {
  it("leaves only the thing named in how a model says where to go", () => {
    expect(spotWords("sit on the couch")).toBe("couch");
    expect(spotWords("go and stand by the window.")).toBe("window");
    expect(spotWords("over by the big window")).toBe("big window");
    expect(spotWords("in front of the bookshelf")).toBe("bookshelf");
    expect(spotWords("the desk")).toBe("desk");
  });

  it("finds a spot by its place, its name, or a thing that has one", () => {
    const place = home();
    expect(spotIn(place, "the couch")).toEqual({ spot: "couch", name: "on the couch" });
    expect(spotIn(place, "sit on the couch")).toEqual({ spot: "couch", name: "on the couch" });
    expect(spotIn(place, "by the window")).toEqual({ spot: "window", name: "at the window" });
    expect(spotIn(place, "at the desk")).toEqual({ spot: "desk", name: "at the desk" });
    // The chair is at the desk: its spot is the desk's.
    expect(spotIn(place, "the desk chair")).toEqual({ spot: "desk", name: "at the desk" });
  });

  it("stands by a thing that has no spot of its own, and finds nothing for what isn't there", () => {
    const place = home();
    expect(spotIn(place, "by the plant")).toEqual({ item: "plant", name: "by the plant" });
    expect(spotIn(place, "by the floor lamp")).toEqual({ item: "lamp", name: "by the floor lamp" });
    expect(spotIn(place, "the hot tub")).toBeUndefined();
    expect(spotIn(place, "")).toBeUndefined();
  });

  it("stands by a thing an agent made and put there, which brings no spot of its own", () => {
    const place = madeHome();
    expect(spotIn(place, "by the bookcase")).toEqual({ item: "model", name: "by the bookcase" });
    expect(spotIn(place, "go and stand next to the bookcase")).toEqual({ item: "model", name: "by the bookcase" });
    expect(spotIn(place, "the clock")).toEqual({ item: "small_model", name: "by the clock" });
    // Listed with the spots, each once, after them.
    expect(spotsToGo(place)).toEqual([...spotsToGo(home()), "the bookcase", "the clock"]);
    expect(spotsToGo(home())).not.toContain("the bookcase");
  });

  it("says where it stays the way a sentence needs it", () => {
    expect(stayWords("on the couch")).toBe("on the couch");
    expect(stayWords("the middle of the room")).toBe("in the middle of the room");
    expect(stayWords("the bookshelf")).toBe("at the bookshelf");
  });

  it("holds a chosen spot only in its own place, until its time runs out", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    const body: BodyData = { spot: { place: homeId("planner"), spot: "window", name: "at the window" } };
    expect(chosenNow(body, homeId("planner"), now)).toEqual(body.spot);
    expect(chosenNow(body, "shared:lounge", now)).toBeUndefined();
    const timed = (until: string): BodyData => ({ spot: { ...(body.spot as NonNullable<BodyData["spot"]>), until } });
    expect(chosenNow(timed("2026-10-19T12:30:00Z"), homeId("planner"), now)).toBeDefined();
    expect(chosenNow(timed("2026-10-19T11:59:00Z"), homeId("planner"), now)).toBeUndefined();
    expect(chosenNow(timed("whenever"), homeId("planner"), now)).toBeUndefined();
    expect(chosenNow(undefined, homeId("planner"), now)).toBeUndefined();
  });
});

describe("what the page draws a body with", () => {
  it("is everything chosen, with what it wears worked out, and only what suits its role when nothing was", () => {
    const coder = readRole({ name: "coder" });
    const chosen = {
      bodies: new Map<string, BodyData>([["coder", { color: "#2a8a8a", idle: "lively", size: 1.2 }]]),
      wear: new Map<string, unknown>([["coder", ["cap"]]]),
    };
    expect(looksOf("coder", coder, chosen)).toEqual({
      role: "coder",
      wear: ["cap"],
      wearChosen: true,
      color: "#2a8a8a",
      idle: "lively",
      size: 1.2,
    });
    expect(looksOf("planner", undefined, chosen)).toEqual({ wear: [] });
  });
});

describe("the body tool", () => {
  const types = [
    { name: BODY_TYPE, scope: "agent" as const },
    { name: EMOTE_TYPE, scope: "global" as const, provider: "memory" },
    { name: WEAR_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
    { name: "visit", scope: "global" as const, provider: "memory" },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  let state: StateService;
  let clock: number;
  let went: string[];
  let tool: BodyTool;
  const world = (over: Partial<BodyWorld> = {}): BodyWorld => ({
    hasBody: (a) => a !== "ghost",
    here: async (_s, _c, agent) => ({ id: homeId(agent), place: home(), words: "You are at home." }),
    go: async (_s, _c, _agent, to) => {
      if (to !== "the lounge") return undefined;
      went.push(to);
      return { ok: true, text: "You're in the lounge now.", id: "shared:lounge" };
    },
    models: () => ({ names: ["robot.vrm", "fox.vrm"], own: "robot.vrm" }),
    role: (agent) => readRole({ name: agent }),
    now: () => clock,
    ...over,
  });
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    clock = Date.parse("2026-10-19T12:00:00Z");
    went = [];
    tool = new BodyTool(() => state, world());
  });
  const body = async (agent: string) => (await state.get(owner, { type: BODY_TYPE, id: agent }))?.data as BodyData;

  it("shows the agent itself, where it is, and what it can choose", async () => {
    const look = await tool.execute({ action: "look" }, as("coder"));
    expect(look.success, look.error).toBe(true);
    const text = String(look.output);
    expect(text).toMatch(/^You are at home\./);
    expect(text).toMatch(
      /You are drawn in robot\.vrm, in your own colour\. You wear a headset and glasses, as suits a coder\./,
    );
    expect(text).toMatch(/model \(robot\.vrm, fox\.vrm\)/);
    expect(text).toMatch(/Emotes: wave, nod/);
    expect(text).toMatch(
      /Spots here to go to: the middle of the room, the couch, the desk, the window, the bookshelf\./,
    );
  });

  it("keeps what it chooses on its own body record, all of it or none of it", async () => {
    const done = await tool.execute(
      { action: "change", color: "coral", size: 1.2, wear: "beret, scarf", idle: "lively", walk: "bouncy" },
      as("planner"),
    );
    expect(done.success, done.error).toBe(true);
    expect(done.output).toBe(
      "Done: you're coral, you're 1.2 times your normal size, you wear a beret and a scarf, you're lively when idle and you walk with a bouncy step.",
    );
    expect(await body("planner")).toEqual({
      color: "#ee7f6d",
      colorName: "coral",
      size: 1.2,
      wear: ["beret", "scarf"],
      idle: "lively",
      walk: "bouncy",
    });
    expect((await state.get(owner, { type: BODY_TYPE, id: "planner" }))?.scope).toBe("agent:planner");
    const bad = await tool.execute({ action: "change", color: "navy", model: "dragon" }, as("planner"));
    expect(bad.success).toBe(false);
    expect((await body("planner")).color).toBe("#ee7f6d");
    const look = String((await tool.execute({ action: "look" }, as("planner"))).output);
    expect(look).toMatch(/in coral, 1\.2 times your normal size\. You wear a beret and a scarf\./);
    expect(look).toMatch(/You're lively when idle, you stand relaxed and you walk with a bouncy step\./);
  });

  it("goes back to how it always was, and keeps no record once nothing is chosen", async () => {
    await tool.execute({ action: "change", color: "teal", wear: "cap" }, as("coder"));
    const back = await tool.execute({ action: "change", color: "default", wear: "default" }, as("coder"));
    expect(back.output).toBe(
      "Done: you're in your own colour again and you wear a headset and glasses, what suits you.",
    );
    expect(await state.get(owner, { type: BODY_TYPE, id: "coder" })).toBeNull();
  });

  it("makes a gesture now, kept going for as long as it says, but never too long", async () => {
    const wave = await tool.execute({ action: "emote", emote: "wave" }, as("planner"));
    expect(wave.output).toBe("You wave.");
    expect((await state.get(owner, { type: EMOTE_TYPE, id: "planner" }))?.data).toEqual({
      name: "wave",
      at: "2026-10-19T12:00:00.000Z",
    });
    const dance = await tool.execute({ action: "emote", emote: "dancing", for: "30s" }, as("planner"));
    expect(dance.output).toBe("You dance for 30 seconds.");
    expect((await state.get(owner, { type: EMOTE_TYPE, id: "planner" }))?.data.until).toBe("2026-10-19T12:00:30.000Z");
    await tool.execute({ action: "emote", emote: "clap", for: "3 hours" }, as("planner"));
    const until = String((await state.get(owner, { type: EMOTE_TYPE, id: "planner" }))?.data.until);
    expect(Date.parse(until) - clock).toBe(EMOTE_MOST_MS);
    const point = await tool.execute({ action: "emote", emote: "point", at: "the window" }, as("planner"));
    expect(point.output).toBe("You point at the window.");
    const none = await tool.execute({ action: "emote", emote: "juggle" }, as("planner"));
    expect(none.error).toMatch(/"juggle" isn't a gesture you can make\. You can: wave, nod/);
  });

  it("goes to a spot in the place it is in and stays, for a while or until it says otherwise", async () => {
    const sit = await tool.execute({ action: "go", to: "sit on the couch" }, as("planner"));
    expect(sit.output).toBe(
      "You go and stay on the couch until you choose otherwise. Work and conversations still come first; you come back after.",
    );
    expect((await body("planner")).spot).toEqual({ place: homeId("planner"), spot: "couch", name: "on the couch" });
    await tool.execute({ action: "go", to: "by the window", for: "20 min" }, as("planner"));
    expect((await body("planner")).spot).toEqual({
      place: homeId("planner"),
      spot: "window",
      name: "at the window",
      until: "2026-10-19T12:20:00.000Z",
    });
    expect(String((await tool.execute({ action: "look" }, as("planner"))).output)).toMatch(
      /You're staying at the window for another 20 minutes; work and conversations come first\./,
    );
    const free = await tool.execute({ action: "go", to: "anywhere" }, as("planner"));
    expect(free.output).toBe("You're free to go where you like again.");
    expect(await state.get(owner, { type: BODY_TYPE, id: "planner" })).toBeNull();
  });

  it("goes to another place by name, home in a while when it says, and says where it can go when nowhere fits", async () => {
    await tool.execute({ action: "go", to: "the couch" }, as("planner"));
    const lounge = await tool.execute({ action: "go", to: "the lounge", for: "1 hour" }, as("planner"));
    expect(lounge.output).toBe("You're in the lounge now. You go home in 60 minutes.");
    expect(went).toEqual(["the lounge"]);
    // How to get there is left off a place's name, as it is off a spot's.
    const headed = await tool.execute({ action: "go", to: "go to the lounge" }, as("writer"));
    expect(headed.output).toBe("You're in the lounge now.");
    expect(went).toEqual(["the lounge", "the lounge"]);
    // A spot belongs to the place it is in: gone somewhere else, it is let go.
    expect(await body("planner")).toEqual({ away: { place: "shared:lounge", until: "2026-10-19T13:00:00.000Z" } });
    const nowhere = await tool.execute({ action: "go", to: "the moon" }, as("planner"));
    expect(nowhere.success).toBe(false);
    expect(nowhere.error).toMatch(
      /There's no spot or place called "the moon"\. Spots here: the middle of the room, the couch/,
    );
  });

  it("lists what agents made among the spots, and goes to stand by one", async () => {
    tool = new BodyTool(
      () => state,
      world({ here: async (_s, _c, agent) => ({ id: homeId(agent), place: madeHome(), words: "You are at home." }) }),
    );
    const look = String((await tool.execute({ action: "look" }, as("planner"))).output);
    expect(look).toMatch(/Spots here to go to: the middle of the room, .*the bookshelf, the bookcase, the clock\./);
    const went = await tool.execute({ action: "go", to: "by the bookcase" }, as("planner"));
    expect(went.output).toBe(
      "You go and stay by the bookcase until you choose otherwise. Work and conversations still come first; you come back after.",
    );
    expect((await body("planner")).spot).toEqual({ place: homeId("planner"), item: "model", name: "by the bookcase" });
  });

  it("is for agents with a body", async () => {
    const out = await tool.execute({ action: "look" }, as("ghost"));
    expect(out).toEqual({ success: false, output: "", error: "You have no body to see or change." });
  });

  it("ends a stay whose time has run out: the spot let go, and home from a place it went to for a while", async () => {
    const until = "2026-10-19T12:10:00.000Z";
    await changeBody(state, owner, "planner", {
      color: "#2a8a8a",
      spot: { place: homeId("planner"), spot: "window", name: "at the window", until },
    });
    await changeBody(state, owner, "writer", { away: { place: "shared:lounge", until } });
    await state.put(owner, { type: WHEREABOUTS_TYPE, id: "writer", scope: "global", data: { place: "shared:lounge" } });
    await changeBody(state, owner, "coder", { spot: { place: homeId("coder"), spot: "desk", name: "at the desk" } });
    await endStays(state, Date.parse("2026-10-19T12:05:00Z"));
    expect((await body("planner")).spot?.until).toBe(until);
    await endStays(state, Date.parse("2026-10-19T12:11:00Z"));
    expect(await body("planner")).toEqual({ color: "#2a8a8a" });
    expect(await state.get(owner, { type: BODY_TYPE, id: "writer" })).toBeNull();
    expect(await state.get(owner, { type: WHEREABOUTS_TYPE, id: "writer" })).toBeNull();
    // A stay with no end lasts.
    expect((await body("coder")).spot?.spot).toBe("desk");
  });

  it("says when a stay can't be ended, and goes on to the others, never failing the sweep", async () => {
    const until = "2026-10-19T12:10:00.000Z";
    await changeBody(state, owner, "planner", { spot: { place: homeId("planner"), spot: "window", name: "w", until } });
    await changeBody(state, owner, "writer", { spot: { place: homeId("writer"), spot: "couch", name: "c", until } });
    // The store fails to write the first body it is asked to: the second is still let go.
    let failed = 0;
    const broken = Object.create(state) as StateService;
    broken.put = (...args: Parameters<StateService["put"]>) => {
      if (!failed++) return Promise.reject(new Error("disk full"));
      return state.put(...args);
    };
    broken.delete = (...args: Parameters<StateService["delete"]>) => {
      if (!failed++) return Promise.reject(new Error("disk full"));
      return state.delete(...args);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(endStays(broken, Date.parse("2026-10-19T12:11:00Z"))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not end \w+'s stay: disk full/));
    } finally {
      warn.mockRestore();
    }
    const left = [
      await state.get(owner, { type: BODY_TYPE, id: "planner" }),
      await state.get(owner, { type: BODY_TYPE, id: "writer" }),
    ];
    expect(left.filter(Boolean)).toHaveLength(1);
  });

  it("leaves a body where it went since, when its time away runs out", async () => {
    const until = "2026-10-19T12:10:00.000Z";
    await changeBody(state, owner, "writer", { away: { place: "shared:lounge", until } });
    await state.put(owner, { type: WHEREABOUTS_TYPE, id: "writer", scope: "global", data: { place: "shared:den" } });
    await endStays(state, Date.parse("2026-10-19T12:11:00Z"));
    expect((await state.get(owner, { type: WHEREABOUTS_TYPE, id: "writer" }))?.data.place).toBe("shared:den");
  });
});
