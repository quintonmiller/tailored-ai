/**
 * What a body does about what its agent is doing: the server's activity
 * record turned into a thing to hold, a sign, a place to be and a line to show.
 */
import { describe, expect, it } from "vitest";
import { type AgentActivity, behaviorFor, heldFor, hueFor, sameBehavior, stationSpot } from "./doing";

const act = (over: Partial<AgentActivity>): AgentActivity => ({
  agent: "planner",
  doing: "idle",
  what: "idle",
  ...over,
});

describe("behaviorFor", () => {
  it("does nothing special while idle, and wanders", () => {
    expect(behaviorFor(act({}))).toEqual({ stays: false });
    expect(behaviorFor(undefined)).toEqual({ stays: false });
  });

  it("thinks with a cloud over its head, where it is", () => {
    expect(behaviorFor(act({ doing: "thinking", what: "thinking" }))).toMatchObject({
      sign: "think",
      thinking: true,
      stays: true,
      label: "thinking",
    });
  });

  it("holds what the tool looks like, the way that thing is held", () => {
    expect(behaviorFor(act({ doing: "working", what: "taking a photo", look: "camera" }))).toMatchObject({
      prop: "camera",
      hold: "up",
      stays: true,
    });
    expect(
      behaviorFor(act({ doing: "working", what: "searching", look: "magnifier", detail: "hotels" })),
    ).toMatchObject({ prop: "magnifier", hold: "out", label: "searching", detail: "hotels" });
  });

  it("reads sitting down and codes at a desk, when it can", () => {
    expect(behaviorFor(act({ doing: "working", what: "reading", look: "book" })).station).toBe("seat");
    expect(behaviorFor(act({ doing: "working", what: "coding", look: "laptop" })).station).toBe("desk");
  });

  it("goes where the work is: the desk to think and to work, the task board for tasks", () => {
    expect(behaviorFor(act({ doing: "thinking", what: "thinking" })).station).toBe("desk");
    expect(behaviorFor(act({ doing: "working", what: "using flights" })).station).toBe("desk");
    expect(behaviorFor(act({ doing: "working", what: "updating tasks", look: "clipboard" })).station).toBe("board");
    // A photo or a recording is made where it stands.
    expect(behaviorFor(act({ doing: "working", what: "taking a photo", look: "camera" })).station).toBeUndefined();
    expect(behaviorFor(act({ doing: "idle", what: "idle" })).station).toBeUndefined();
  });

  it("holds nothing for a look it can't draw, but still says what it is doing", () => {
    const b = behaviorFor(act({ doing: "working", what: "using flights", look: "airplane" }));
    expect(b.prop).toBeUndefined();
    expect(b.label).toBe("using flights");
  });

  it("talks to whoever it is talking to, on the phone if they are not there", () => {
    expect(behaviorFor(act({ doing: "talking", what: "talking to writer", with: "writer" }))).toMatchObject({
      sign: "talk",
      face: "writer",
      prop: "phone",
      hold: "ear",
    });
  });

  it("waves for you when it is waiting, and shrugs when it is stuck", () => {
    expect(behaviorFor(act({ doing: "waiting", what: "has a question for you" }))).toMatchObject({
      sign: "wait",
      gesture: "wave",
    });
    expect(behaviorFor(act({ doing: "stuck", what: "stuck" }))).toMatchObject({ sign: "stuck", gesture: "shrug" });
  });

  it("sleeps in a seat if there is one, eyes shut", () => {
    expect(behaviorFor(act({ doing: "asleep", what: "asleep" }))).toMatchObject({
      sign: "sleep",
      asleep: true,
      station: "seat",
    });
  });
});

describe("heldFor", () => {
  const coding = behaviorFor(act({ doing: "working", what: "coding", look: "laptop" }));
  const calling = behaviorFor(act({ doing: "talking", what: "talking to writer", with: "writer" }));

  it("puts the laptop down at a desk, where it types instead", () => {
    expect(heldFor(coding, { partnerHere: false })).toEqual({ prop: "laptop", hold: "chest" });
    expect(heldFor(coding, { spotActivity: "type", partnerHere: false })).toEqual({});
  });

  it("phones only someone who isn't in the room", () => {
    expect(heldFor(calling, { partnerHere: false })).toEqual({ prop: "phone", hold: "ear" });
    expect(heldFor(calling, { partnerHere: true })).toEqual({});
  });

  it("holds nothing when there is nothing to hold", () => {
    expect(heldFor(behaviorFor(act({ doing: "thinking", what: "thinking" })), { partnerHere: false })).toEqual({});
    expect(heldFor(undefined, { partnerHere: false })).toEqual({});
  });
});

describe("stationSpot", () => {
  const spots = [
    { id: "couch", at: [-1, -1] as [number, number], activity: "sit" },
    { id: "armchair", at: [1.5, 1] as [number, number], activity: "sit" },
    { id: "desk", at: [1.4, -1] as [number, number], activity: "type" },
    { id: "window", at: [-1.5, 0] as [number, number], activity: "look" },
  ];

  it("picks the nearest free seat, or desk", () => {
    expect(stationSpot("seat", spots, { x: 1, z: 1 }, new Set())?.id).toBe("armchair");
    expect(stationSpot("seat", spots, { x: 1, z: 1 }, new Set(["armchair"]))?.id).toBe("couch");
    expect(stationSpot("desk", spots, { x: 0, z: 0 }, new Set())?.id).toBe("desk");
  });

  it("stays put when it is already at one, and when every one is taken", () => {
    expect(stationSpot("seat", spots, { x: 0, z: 0, spotActivity: "sit" }, new Set())).toBeUndefined();
    expect(stationSpot("seat", spots, { x: 0, z: 0 }, new Set(["couch", "armchair"]))).toBeUndefined();
  });

  it("finds the task board by the spot in front of it, and stays there once it is", () => {
    const withBoard = [
      ...spots,
      { id: "idle:board", at: [0, -1.8] as [number, number], activity: "look", for: "board" },
    ];
    expect(stationSpot("board", withBoard, { x: 1, z: 1 }, new Set())?.id).toBe("idle:board");
    expect(stationSpot("board", withBoard, { x: 0, z: -1.8, spot: "idle:board" }, new Set())).toBeUndefined();
    // A window is somewhere to look too, but not the board.
    expect(stationSpot("board", spots, { x: 0, z: 0 }, new Set())).toBeUndefined();
  });
});

describe("sameBehavior", () => {
  it("tells a new status from the same one written again", () => {
    const a = behaviorFor(act({ doing: "working", what: "reading", look: "book" }));
    expect(sameBehavior(a, behaviorFor(act({ doing: "working", what: "reading", look: "book", since: "later" })))).toBe(
      true,
    );
    expect(sameBehavior(a, behaviorFor(act({ doing: "working", what: "writing", look: "book" })))).toBe(false);
  });
});

describe("hueFor", () => {
  it("gives each agent its own colour, the same every time, and the default agent none", () => {
    expect(hueFor("planner")).toBe(hueFor("planner"));
    expect(hueFor("planner")).not.toBe(hueFor("writer"));
    expect(hueFor("default")).toBeUndefined();
    for (const name of ["a", "planner", "trip-planner", "x".repeat(40)]) {
      const h = hueFor(name) as number;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
});
