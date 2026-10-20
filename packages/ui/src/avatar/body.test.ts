/**
 * A body as it chose to look and carry itself: its colour turned from the
 * model's own, where it stays and what comes first, a gesture made once, and
 * when it has to be made again.
 */
import { describe, expect, it } from "vitest";
import {
  type BodyLooks,
  bodyWith,
  builtKey,
  carriageKey,
  carriageOf,
  chosenNow,
  chosenSpotIn,
  dotColor,
  emoteNow,
  hexToHsl,
  idleStyle,
  planFor,
  STALE_EMOTE_MS,
  tintOf,
  walkStyle,
} from "./body";
import { hueFor } from "./doing";
import { LIKED, likesOf } from "./idle";
import type { Room } from "./scene";

const room: Room = {
  width: 5,
  depth: 4,
  height: 2.6,
  start: "middle",
  props: [
    { id: "couch", name: "the couch", kind: "couch", at: [-1.5, 0], facing: 90, spot: "couch" },
    { id: "window", name: "the window", kind: "window", at: [0, -2], facing: 0, spot: "window", elevation: 0.9 },
    { id: "plant", name: "the plant", kind: "plant", at: [2, -1.6], facing: 0 },
    { id: "lamp", name: "the floor lamp", kind: "lamp", at: [-2.2, -1.6], facing: 0 },
    { id: "clock", name: "the clock", kind: "clock", at: [2.4, 1.9], facing: 0, elevation: 2 },
  ],
  spots: [
    { id: "middle", name: "the middle of the room", place: "the middle of the room", at: [0, 0.5], facing: 0 },
    {
      id: "couch",
      name: "on the couch",
      place: "the couch",
      at: [-1.3, 0],
      facing: 90,
      activity: "sit",
      item: "couch",
    },
    {
      id: "window",
      name: "at the window",
      place: "the window",
      at: [0, -1.4],
      facing: 180,
      activity: "look",
      item: "window",
    },
    { id: "idle:plant", name: "by the plant", place: "the plant", at: [1.6, -1.1], facing: 140, for: "plant" },
    // Nearer the plant than the spot in front of it, but not the one for it.
    { id: "corner", name: "in the corner", place: "the corner", at: [2.2, -1.2], facing: 0 },
  ],
};

describe("a body's colour", () => {
  it("reads hex colours as hue, saturation and lightness", () => {
    expect(hexToHsl("#ff0000")).toEqual([0, 1, 0.5]);
    const [h, s, l] = hexToHsl("#2a8a8a") as [number, number, number];
    expect(Math.round(h)).toBe(180);
    expect(s).toBeGreaterThan(0.5);
    expect(l).toBeCloseTo(0.35, 2);
    expect(hexToHsl("teal")).toBeUndefined();
  });

  it("turns toward the colour it chose, paler, darker or greyer as that is", () => {
    const teal = tintOf("#2a8a8a", "planner");
    expect(Math.round(teal?.hue ?? 0)).toBe(35);
    expect(teal?.lightness).toBeLessThan(1);
    // A grey is all but colourless; white is pale and black dark, within what still looks like the model.
    expect(tintOf("#8a8f96", "planner")?.saturation).toBeLessThan(0.15);
    expect(tintOf("#f5f3ef", "planner")?.lightness).toBe(1.6);
    expect(tintOf("#2a2a2e", "planner")?.lightness).toBe(0.4);
  });

  it("is the colour its name gives it until it chooses, and the default agent's own", () => {
    expect(tintOf(undefined, "planner")).toEqual({ hue: hueFor("planner"), saturation: 1, lightness: 1 });
    expect(tintOf(undefined, "default")).toBeUndefined();
    expect(tintOf("not a colour", "default")).toBeUndefined();
  });

  it("shows on its dots as the colour it chose, or the one its name gives it", () => {
    expect(dotColor("planner", "#2a8a8a")).toBe("#2a8a8a");
    expect(dotColor("planner")).toBe(`hsl(${(145 + (hueFor("planner") ?? 0)) % 360} 52% 52%)`);
  });
});

describe("how it carries itself", () => {
  it("has nothing to change for a body that chose nothing", () => {
    expect(carriageOf(undefined)).toEqual({});
    expect(carriageOf({ color: "#2a8a8a" })).toEqual({});
    expect(idleStyle(undefined)).toEqual({ drift: 1, stay: 1, pace: 1, likes: {} });
    expect(walkStyle(undefined).speed).toBe(1);
  });

  it("hands the figure its idle style, posture and walk", () => {
    expect(carriageOf({ idle: "sleepy", posture: "slouched", walk: "stroll" })).toEqual({
      idle: "sleepy",
      drift: idleStyle("sleepy").drift,
      pace: idleStyle("sleepy").pace,
      posture: "slouched",
      walk: walkStyle("stroll"),
    });
    expect(walkStyle("brisk").speed).toBeGreaterThan(1.2);
    expect(walkStyle("sneak").clip).toBe("sneak");
  });

  it("draws an idle body to what its style and its likes say, several times over for what it likes", () => {
    expect(idleStyle("sleepy").likes.nap).toBeGreaterThan(3);
    expect(idleStyle("lively").stay).toBeLessThan(1);
    const likes = likesOf(idleStyle("focused").likes, ["coffee", "board"]);
    expect(likes.coffee).toBe(LIKED);
    expect(likes.board).toBe((idleStyle("focused").likes.board ?? 1) * LIKED);
  });

  it("knows when only how it carries itself changed", () => {
    expect(carriageKey({ idle: "calm", errands: ["read"] })).not.toBe(carriageKey({ idle: "calm" }));
    expect(carriageKey({ idle: "calm", color: "#ffffff" })).toBe(carriageKey({ idle: "calm" }));
  });
});

describe("where it stays", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");

  it("holds a spot only in its own place, until its time runs out", () => {
    const spot = { place: "home:planner", spot: "window", name: "at the window" };
    expect(chosenNow(spot, "home:planner", now)).toBe(spot);
    expect(chosenNow(spot, "shared:lounge", now)).toBeUndefined();
    expect(chosenNow({ ...spot, until: "2026-10-19T12:10:00Z" }, "home:planner", now)).toBeDefined();
    expect(chosenNow({ ...spot, until: "2026-10-19T11:59:00Z" }, "home:planner", now)).toBeUndefined();
    expect(chosenNow(undefined, "home:planner", now)).toBeUndefined();
  });

  it("finds the spot it chose, the one in front of a thing, or the nearest to one with none", () => {
    expect(chosenSpotIn(room, { place: "x", spot: "couch", name: "on the couch" })).toBe("couch");
    expect(chosenSpotIn(room, { place: "x", item: "plant", name: "by the plant" })).toBe("idle:plant");
    expect(chosenSpotIn(room, { place: "x", item: "lamp", name: "by the floor lamp" })).toBe("couch");
    // Too far from anywhere to stand: nowhere, rather than across the room.
    expect(chosenSpotIn(room, { place: "x", item: "clock", name: "by the clock" })).toBeUndefined();
    // Taken away since: nothing.
    expect(chosenSpotIn(room, { place: "x", item: "aquarium", name: "by the aquarium" })).toBeUndefined();
    // A spot gone from the room, found again by what it is called.
    expect(chosenSpotIn(room, { place: "x", spot: "window-2", name: "at the window" })).toBe("window");
  });

  it("puts a conversation first, then work, then a person talking to it, then the spot it chose, then its routine", () => {
    const all = { talking: true, working: true, engaged: true, spot: true };
    expect(planFor(all)).toBe("talk");
    expect(planFor({ ...all, talking: false })).toBe("work");
    expect(planFor({ ...all, talking: false, working: false })).toBe("you");
    expect(planFor({ talking: false, working: false, engaged: false, spot: true })).toBe("spot");
    expect(planFor({ talking: false, working: false, engaged: false, spot: false })).toBe("routine");
  });
});

describe("a gesture", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const at = (ms: number) => new Date(now + ms).toISOString();

  it("is made once, while it is fresh", () => {
    expect(emoteNow({ name: "wave", at: at(-2000) }, undefined, now)).toEqual({ name: "wave" });
    expect(emoteNow({ name: "wave", at: at(-2000) }, at(-2000), now)).toBeUndefined();
    expect(emoteNow({ name: "wave", at: at(-STALE_EMOTE_MS - 1) }, undefined, now)).toBeUndefined();
    expect(emoteNow({ name: "juggle", at: at(0) }, undefined, now)).toBeUndefined();
  });

  it("kept going is joined however late, for the time it has left, at whom it was aimed", () => {
    expect(emoteNow({ name: "dance", at: at(-60_000), until: at(30_000) }, undefined, now)).toEqual({
      name: "dance",
      seconds: 30,
    });
    expect(emoteNow({ name: "point", at: at(0), target: "the window" }, undefined, now)).toEqual({
      name: "point",
      target: "the window",
    });
  });
});

describe("changing a body", () => {
  it("is built again only for a new model, colour or size", () => {
    const looks: BodyLooks = { color: "#2a8a8a", idle: "calm", wear: ["cap"] };
    const key = builtKey("/api/live/avatar", looks, "planner");
    expect(builtKey("/api/live/avatar", { ...looks, idle: "lively", wear: [] }, "planner")).toBe(key);
    expect(builtKey("/api/live/avatar", { ...looks, color: "#ee7f6d" }, "planner")).not.toBe(key);
    expect(builtKey("/api/live/avatar", { ...looks, size: 1.2 }, "planner")).not.toBe(key);
    expect(builtKey("/api/live/avatar", { ...looks, avatar: "/api/live/avatar?model=fox.vrm" }, "planner")).not.toBe(
      key,
    );
  });

  it("makes a record from a change on the card: set, taken back, and nothing the record doesn't keep", () => {
    expect(
      bodyWith({ color: "#2a8a8a", colorName: "teal", idle: "calm" }, { color: null, colorName: null, walk: "brisk" }),
    ).toEqual({ idle: "calm", walk: "brisk" });
    expect(bodyWith({ idle: "calm", role: "coder", avatar: "/x" }, {})).toEqual({ idle: "calm" });
  });
});
