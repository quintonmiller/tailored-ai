/**
 * Places: the room an agent's body lives in, and the `place` tool that
 * changes it. Placement works in words ("by the window", "on the desk"),
 * things never overlap or stand on a spot the avatar needs, what stands on a
 * thing moves with it, and the tool keeps the room in world state.
 */
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  anyAvatar,
  applyAction,
  homeId,
  PLACE_TYPE,
  PlaceTool,
  readCurrent,
  readHome,
  roomPlaceId,
  scene,
  WHEREABOUTS_TYPE,
  whereIs,
  whoIsIn,
  worldMap,
} from "../plugins/places.js";
import type { Shot } from "../plugins/places-camera.js";
import {
  defaultPlace,
  findPlacement,
  lobby,
  meetingRoom,
  type Place,
  type PlaceItem,
  parseColor,
  placeProblems,
  resize,
  spotOf,
  themeFor,
} from "../plugins/places-layout.js";
import "../state/builtin.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { ToolContext } from "../tools/interface.js";

const item = (place: Place, id: string) => place.props.find((p) => p.id === id) as PlaceItem;
const spot = (place: Place, id: string) => place.spots.find((s) => s.id === id);

/** Apply a tool call that must succeed, returning the room after it. */
function must(place: Place, args: Record<string, unknown>): Place {
  const out = applyAction(place, args);
  expect(out.ok, out.text).toBe(true);
  expect(out.place, out.text).toBeDefined();
  return out.place as Place;
}

describe("the default room", () => {
  it("is sound, and its spots are the ones the avatar has always used", () => {
    const place = defaultPlace();
    expect(placeProblems(place)).toEqual([]);
    expect(spot(place, "couch")).toMatchObject({
      at: [-0.85, -0.72],
      facing: 0,
      activity: "sit",
      seat: { at: [-0.85, -1.25], height: 0.47 },
    });
    expect(spot(place, "desk")).toMatchObject({ at: [1.35, -0.98], facing: 180, activity: "type" });
    expect(spot(place, "window")).toMatchObject({ at: [-1.55, -0.45], facing: -90, activity: "look" });
    expect(spot(place, "bookshelf")).toMatchObject({ at: [-1.4, 0.95], facing: -90, activity: "browse" });
    expect(spot(place, "middle")).toBeDefined();
    expect(place.start).toBe("middle");
  });
});

describe("adding things", () => {
  it("puts a seat by a window turned the way the window looks, with a spot to sit in that nothing covers", () => {
    const place = must(defaultPlace(), { action: "add", kind: "armchair", near: "the window", color: "sage" });
    const chair = place.props.at(-1) as PlaceItem;
    expect(chair).toMatchObject({ kind: "armchair", name: "the sage armchair", color: parseColor("sage") });
    // Into the room, as the window looks: not staring at the wall.
    expect(chair.facing).toBe(item(place, "window").facing);
    expect(spotOf(chair)).toBeDefined();
    expect(placeProblems(place)).toEqual([]);
  });

  it("turns a seat put near a TV or a fire to face it", () => {
    let place = must(defaultPlace(), { action: "remove", item: "desk" });
    place = must(place, { action: "add", kind: "tv", wall: "right" });
    place = must(place, { action: "add", kind: "armchair", near: "the TV", side: "front" });
    const tv = item(place, "tv");
    const chair = place.props.at(-1) as PlaceItem;
    const toTv = (Math.atan2(tv.at[0] - chair.at[0], tv.at[1] - chair.at[1]) * 180) / Math.PI;
    expect(Math.abs(((toTv - chair.facing + 540) % 360) - 180)).toBeLessThan(5);
  });

  it("puts small things on a surface, at its height, and they move with it", () => {
    let place = must(defaultPlace(), { action: "add", kind: "vase", on: "the desk" });
    const vase = place.props.at(-1) as PlaceItem;
    expect(vase).toMatchObject({ on: "desk", elevation: 0.76, spot: "desk" });
    place = must(place, { action: "move", item: "desk", wall: "right" });
    const desk = item(place, "desk");
    const moved = item(place, vase.id);
    const laptop = item(place, "laptop");
    // Both riders stay on the desk's top.
    for (const rider of [moved, laptop]) {
      expect(Math.hypot(rider.at[0] - desk.at[0], rider.at[1] - desk.at[1])).toBeLessThan(0.7);
      expect(rider.elevation).toBe(0.76);
    }
    // The desk's spot followed it.
    expect(spot(place, "desk")?.at).not.toEqual([1.35, -0.98]);
    expect(placeProblems(place)).toEqual([]);
  });

  it("finds a surface on its own for something that needs one", () => {
    const place = must(defaultPlace(), { action: "add", kind: "mug" });
    expect((place.props.at(-1) as PlaceItem).on).toBe("desk");
  });

  it("hangs things on the walls that exist, without covering what is there", () => {
    const refused = applyAction(defaultPlace(), { action: "add", kind: "picture", wall: "front" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/open/);
    const place = must(defaultPlace(), { action: "add", kind: "clock", wall: "back" });
    const clock = place.props.at(-1) as PlaceItem;
    expect(clock.at[1]).toBeCloseTo(-place.depth / 2 + 0.01);
    expect(clock.elevation).toBeGreaterThan(1.5);
  });

  it("won't let a tall bookcase hide the window", () => {
    // The left wall holds the window and a bookshelf already: take the shelf away first.
    const place = must(defaultPlace(), { action: "remove", item: "bookshelf" });
    const window = item(place, "window");
    expect(typeof findPlacement(defaultPlace(), { kind: "bookshelf" }, { wall: "left" })).toBe("string");
    const got = findPlacement(place, { kind: "bookshelf" }, { wall: "left", near: "the window" });
    expect(typeof got).not.toBe("string");
    if (typeof got === "string") return;
    // Along the left wall, but clear of the window's stretch of it.
    expect(Math.abs(got.at[1] - window.at[1])).toBeGreaterThan(0.6 + 0.45 - 0.01);
  });

  it("names things so they stay tell-apart-able", () => {
    let place = must(defaultPlace(), { action: "add", kind: "lamp", wall: "right" });
    expect((place.props.at(-1) as PlaceItem).name).toBe("the lamp");
    place = must(place, { action: "add", kind: "lamp", corner: "front left" });
    expect((place.props.at(-1) as PlaceItem).name).toBe("the lamp 2");
    place = must(place, { action: "add", kind: "block", size: "0.3 1.2 0.3", color: "#ff8800", name: "pillar" });
    expect(place.props.at(-1)).toMatchObject({ name: "the pillar", size: [0.3, 1.2, 0.3], color: "#ff8800" });
  });

  it("says why when there's no room, and stops instead of overlapping", () => {
    let place = defaultPlace();
    let refusals = 0;
    for (let i = 0; i < 25 && refusals === 0; i++) {
      const out = applyAction(place, { action: "add", kind: "armchair" });
      if (out.place) place = out.place;
      else refusals++;
    }
    expect(refusals).toBe(1);
    expect(placeProblems(place)).toEqual([]);
  });

  it("explains a bad colour or kind instead of guessing", () => {
    expect(applyAction(defaultPlace(), { action: "add", kind: "armchair", color: "blurple" }).text).toMatch(/colour/);
    expect(applyAction(defaultPlace(), { action: "add", kind: "spaceship" }).text).toMatch(/kind/);
  });
});

describe("changing and removing", () => {
  it("removes what stands on a thing with it, and a click that led to it leads nowhere", () => {
    const out = applyAction(defaultPlace(), { action: "remove", item: "the desk" });
    expect(out.text).toMatch(/the laptop/);
    const place = out.place as Place;
    expect(place.props.some((p) => p.id === "laptop")).toBe(false);
    expect(spot(place, "desk")).toBeUndefined();
    expect(item(place, "chair").spot).toBeUndefined();
  });

  it("recolours, renames and resizes, and a bigger thing has to fit again", () => {
    let place = must(defaultPlace(), { action: "change", item: "couch", color: "dark green", name: "the green sofa" });
    expect(item(place, "couch")).toMatchObject({ name: "the green sofa", color: parseColor("dark green") });
    expect(spot(place, "couch")?.place).toBe("the green sofa");
    place = must(place, { action: "change", item: "the green sofa", scale: 0.8 });
    expect(item(place, "couch").scale).toBe(0.8);
    expect(placeProblems(place)).toEqual([]);
    // Between the plant and the lamp there is no room for a sofa a fifth bigger.
    const bigger = applyAction(place, { action: "change", item: "the green sofa", scale: 1.2 });
    expect(bigger.ok).toBe(false);
    expect(bigger.text).toMatch(/doesn't fit/);
  });

  it("turns a thing where it stands", () => {
    const place = must(defaultPlace(), { action: "move", item: "lamp", facing: 45 });
    expect(item(place, "lamp")).toMatchObject({ at: [0.25, -1.5], facing: 45 });
    // A round pot takes no more room turned, so it stays put.
    expect(item(must(defaultPlace(), { action: "move", item: "plant", facing: 45 }), "plant")).toMatchObject({
      at: [-1.86, -1.5],
      facing: 45,
    });
    // A square desk turned so its corner would meet the wall shifts just enough to stay inside.
    const desk = item(must(defaultPlace(), { action: "move", item: "desk", facing: 30 }), "desk");
    expect(desk.facing).toBe(30);
    expect(Math.hypot(desk.at[0] - 1.35, desk.at[1] + 1.47)).toBeLessThan(0.5);
  });
});

describe("the room itself", () => {
  it("resizes with what is against a wall staying against it", () => {
    const place = resize(defaultPlace(), { width: 5, depth: 4 });
    expect(typeof place).not.toBe("string");
    if (typeof place === "string") return;
    expect(item(place, "window").at[0]).toBeCloseTo(-2.49);
    expect(item(place, "couch").at[1]).toBeCloseTo(-1.58);
    expect(placeProblems(place)).toEqual([]);
  });

  it("refuses a size that would push things out, saying which", () => {
    const out = applyAction(defaultPlace(), { action: "room", width: 2.5, depth: 2.5 });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/doesn't work/);
  });

  it("repaints walls and floor", () => {
    const place = must(defaultPlace(), { action: "room", walls: "pale blue", floor: "tile" });
    expect(place.walls).toBe(parseColor("pale blue"));
    expect(place.floor).toBe("tile");
  });
});

describe("the place tool", () => {
  const types = [{ name: PLACE_TYPE, scope: "agent" as const }];
  let db: Database.Database;
  let state: StateService;
  const bodies = new Set(["assistant"]);
  const context = (agentName?: string): ToolContext => ({ agentName }) as ToolContext;

  beforeEach(() => {
    db = new Database(":memory:");
    let clock = Date.parse("2026-10-18T09:00:00Z");
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db,
      now: () => new Date((clock += 1000)),
    });
  });

  const tool = () =>
    new PlaceTool(
      () => state,
      (agent) => bodies.has(agent ?? "default"),
    );

  it("keeps the agent's room in world state, in its own scope, and changes it", async () => {
    const t = tool();
    const look = await t.execute({ action: "look" }, context("assistant"));
    expect(look.success).toBe(true);
    expect(String(look.output)).toMatch(/Kinds you can add/);
    const record = await state.get(
      { actor: { kind: "user", name: "owner" } },
      { type: PLACE_TYPE, id: homeId("assistant") },
    );
    expect(record?.scope).toBe("agent:assistant");

    const added = await t.execute({ action: "add", kind: "beanbag", near: "the bookshelf" }, context("assistant"));
    expect(added.success, added.error).toBe(true);
    const after = await state.get(
      { actor: { kind: "user", name: "owner" } },
      { type: PLACE_TYPE, id: homeId("assistant") },
    );
    expect((after?.data as unknown as Place).props.some((p) => p.kind === "beanbag")).toBe(true);
    expect(after?.updatedBy).toEqual({ kind: "agent", name: "assistant" });
  });

  it("undoes the last change", async () => {
    const t = tool();
    await t.execute({ action: "add", kind: "rug" }, context("assistant"));
    const undone = await t.execute({ action: "undo" }, context("assistant"));
    expect(undone.success, undone.error).toBe(true);
    const { place } = await readHome(state, { actor: { kind: "user", name: "owner" } }, "assistant");
    expect(place.props.filter((p) => p.kind === "rug")).toHaveLength(1);
  });

  it("works from what is there now when someone changes the room between its read and its write", async () => {
    const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
    await readHome(state, owner, "assistant");
    // The person repaints the walls just after the tool has read the room.
    let raced = false;
    const racing = Object.create(state) as StateService;
    racing.get = async (caller, ref) => {
      const found = await state.get(caller, ref);
      if (!raced && found) {
        raced = true;
        await state.put(owner, { ...ref, data: { ...found.data, walls: "#112233" } }, found.version);
      }
      return found;
    };
    const t = new PlaceTool(
      () => racing,
      () => true,
    );
    const added = await t.execute({ action: "add", kind: "plant", corner: "front left" }, context("assistant"));
    expect(added.success, added.error).toBe(true);
    expect(raced).toBe(true);
    const { place: now } = await readHome(state, owner, "assistant");
    // Both changes stand: the repaint, and the plant.
    expect(now.walls).toBe("#112233");
    expect(now.props.filter((p) => p.kind === "plant")).toHaveLength(2);
  });

  it("tells an agent with no body there's no room to change", async () => {
    const out = await tool().execute({ action: "look" }, context("planner"));
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no body/);
  });
});

describe("photos", () => {
  const types = [{ name: PLACE_TYPE, scope: "agent" as const }];
  let state: StateService;
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
  });

  /** A media store that keeps what it is given, in memory. */
  function memoryStore() {
    const kept: { bytes: Buffer; mimeType?: string; sessionId?: string }[] = [];
    return {
      kept,
      put: async (bytes: Buffer, opts?: { mimeType?: string; sessionId?: string }) => {
        kept.push({ bytes, mimeType: opts?.mimeType, sessionId: opts?.sessionId });
        return { id: `img-${kept.length}`, mimeType: "image/png", bytes: bytes.length };
      },
    };
  }

  it("takes a selfie at a spot, striking a gesture, and hands it back as an image to send", async () => {
    const shots: Shot[] = [];
    const tool = new PlaceTool(
      () => state,
      () => true,
      async (shot) => {
        shots.push(shot);
        return Buffer.from("png bytes");
      },
    );
    const store = memoryStore();
    const out = await tool.execute({ action: "photo", view: "selfie", at: "the couch", gesture: "wave" }, {
      agentName: "assistant",
      sessionId: "s1",
      mediaStore: store,
    } as unknown as ToolContext);
    expect(out.success, out.error).toBe(true);
    expect(shots).toEqual([{ agent: "assistant", view: "selfie", spot: "couch", gesture: "wave" }]);
    expect(store.kept).toEqual([{ bytes: Buffer.from("png bytes"), mimeType: "image/png", sessionId: "s1" }]);
    const parts = (out.output as { parts: { type: string; text?: string; media?: { id: string } }[] }).parts;
    expect(parts[0].text).toMatch(/selfie, on the couch/);
    expect(parts[1]).toMatchObject({ type: "media", media: { id: "img-1" } });
  });

  it("says why when it can't: no such spot, no camera, or the camera failed", async () => {
    const ctx = { agentName: "assistant", mediaStore: memoryStore() } as unknown as ToolContext;
    const working = new PlaceTool(
      () => state,
      () => true,
      async () => Buffer.from("x"),
    );
    const nowhere = await working.execute({ action: "photo", at: "the attic" }, ctx);
    expect(nowhere.error).toMatch(/no spot called "the attic".*the couch/);
    const blind = new PlaceTool(
      () => state,
      () => true,
    );
    expect((await blind.execute({ action: "photo" }, ctx)).error).toMatch(/aren't available/);
    const broken = new PlaceTool(
      () => state,
      () => true,
      async () => {
        throw new Error("Photos need Playwright");
      },
    );
    expect((await broken.execute({ action: "photo" }, ctx)).error).toBe("Photos need Playwright");
  });
});

describe("shared places", () => {
  const types = [
    { name: PLACE_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const bodies = new Set(["host", "guest", "other"]);
  const hasBody = (agent: string | undefined) => bodies.has(agent ?? "default");
  let state: StateService;
  let tool: PlaceTool;
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    tool = new PlaceTool(() => state, hasBody);
  });

  it("makes a shared place, goes there, and changes it instead of home", async () => {
    const made = await tool.execute({ action: "new", name: "lounge" }, as("host"));
    expect(made.success, made.error).toBe(true);
    expect(await whereIs(state, owner, "host")).toBe("shared:lounge");
    const lounge = await state.get(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    expect(lounge).toMatchObject({ scope: "global", data: { name: "the lounge" } });
    const added = await tool.execute({ action: "add", kind: "beanbag", corner: "front left" }, as("host"));
    expect(added.success, added.error).toBe(true);
    const after = await state.get(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    expect((after?.data as unknown as Place).props.some((p) => p.kind === "beanbag")).toBe(true);
    const home = await readHome(state, owner, "host");
    expect(home.place.props.some((p) => p.kind === "beanbag")).toBe(false);
    expect(String((await tool.execute({ action: "look" }, as("host"))).output)).toMatch(/You are in the lounge/);
  });

  it("knows who else is there, and a home's owner is in it until they go out", async () => {
    await tool.execute({ action: "new", name: "the lounge" }, as("host"));
    const joined = await tool.execute({ action: "go", to: "lounge" }, as("guest"));
    expect(String(joined.output)).toMatch(/Also here: host/);
    expect(await whoIsIn(state, owner, "shared:lounge", hasBody)).toEqual(["guest", "host"]);
    expect(String((await tool.execute({ action: "look" }, as("host"))).output)).toMatch(/Also here: guest/);
    // "other" never left home; "host" did.
    expect(await whoIsIn(state, owner, homeId("other"), hasBody)).toEqual(["other"]);
    expect(await whoIsIn(state, owner, homeId("host"), hasBody)).toEqual([]);
    const listed = String((await tool.execute({ action: "places" }, as("other"))).output);
    expect(listed).toMatch(/the lounge: guest, host are there/);
  });

  it("goes home, and works on home again", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    expect((await tool.execute({ action: "go", to: "home" }, as("host"))).output).toBe("You're home.");
    expect(await state.get(owner, { type: WHEREABOUTS_TYPE, id: "host" })).toBeNull();
    expect((await readCurrent(state, owner, "host")).id).toBe(homeId("host"));
  });

  it("says why when it can't go somewhere or make a place twice", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    expect((await tool.execute({ action: "go", to: "the attic" }, as("guest"))).error).toMatch(
      /no shared place called "the attic". There is: the lounge/,
    );
    expect((await tool.execute({ action: "new", name: "Lounge" }, as("guest"))).error).toMatch(/already a place/);
  });

  it("sends an agent home when the place it was in is gone", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await state.delete(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    expect(await whereIs(state, owner, "host")).toBe(homeId("host"));
  });
});

describe("the map, and any place on it", () => {
  const types = [
    { name: PLACE_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const bodies = new Set(["host", "guest", "other"]);
  const hasBody = (agent: string | undefined) => bodies.has(agent ?? "default");
  const rooms = [{ ref: "local:trip", name: "trip", purpose: "Plan the trip", members: ["host", "guest", "nobody"] }];
  let state: StateService;
  let tool: PlaceTool;
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    tool = new PlaceTool(() => state, hasBody);
  });

  it("lists every home, every shared place and every room, with who is in each", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await tool.execute({ action: "go", to: "lounge" }, as("guest"));
    const map = await worldMap(state, owner, ["host", "guest", "other", "bodiless"], rooms, hasBody);
    expect(map.map((p) => [p.id, p.kind, p.agents])).toEqual([
      // Where everyone starts.
      ["lobby", "lobby", []],
      ["home:host", "home", []],
      ["home:guest", "home", []],
      ["home:other", "home", ["other"]],
      ["shared:lounge", "shared", ["guest", "host"]],
      // A room shows its members wherever their bodies are; one without a body isn't drawn.
      ["room:local:trip", "room", ["guest", "host"]],
    ]);
    expect(map.find((p) => p.kind === "room")).toMatchObject({ name: "trip", purpose: "Plan the trip" });
  });

  it("has a body at home when the place it went to is gone", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await state.delete(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    const map = await worldMap(state, owner, ["host"], [], hasBody);
    expect(map.filter((p) => p.kind !== "lobby")).toEqual([
      { id: "home:host", name: "host's room", kind: "home", owner: "host", agents: ["host"] },
    ]);
  });

  it("shows a room of conversation as a meeting room, a seat for each member with a body", async () => {
    const found = await scene(state, owner, roomPlaceId("local:trip"), rooms, hasBody);
    expect(found?.agents).toEqual(["guest", "host"]);
    expect(found?.place.name).toBe("trip");
    expect(found?.place.props.filter((p) => p.kind === "armchair")).toHaveLength(2);
    expect(placeProblems(found?.place as Place)).toEqual([]);
  });

  it("shows a home and a shared place as they are, with who is there", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    expect((await scene(state, owner, "shared:lounge", rooms, hasBody))?.agents).toEqual(["host"]);
    const home = await scene(state, owner, homeId("other"), rooms, hasBody);
    expect(home).toMatchObject({ id: "home:other", agents: ["other"], place: { name: "other's room" } });
  });

  it("shows the lobby: kiosks to make an agent, a task or a room, and a board of open tasks", async () => {
    const found = await scene(state, owner, "lobby", rooms, hasBody);
    expect(found?.agents).toEqual([]);
    const actions = found?.place.props.flatMap((p) => (p.action ? [[p.kind, p.label, p.action]] : []));
    expect(actions).toEqual([
      ["kiosk", "New agent", "new-agent"],
      ["kiosk", "New task", "new-task"],
      ["kiosk", "New room", "new-room"],
      ["board", "Open tasks", "tasks"],
    ]);
    expect(placeProblems(lobby())).toEqual([]);
  });

  it("dresses a room for its purpose, and gives every room a task board", async () => {
    expect(themeFor("vacation planning")?.id).toBe("beach");
    expect(themeFor("standup")).toBeUndefined();
    const beach = meetingRoom("summer", 4, "Plan the family vacation");
    expect(beach).toMatchObject({ walls: "#cfe8f0", floor: "tile", floorColor: "#e6d3a3" });
    expect(beach.props.map((p) => p.kind)).toEqual(expect.arrayContaining(["palm", "umbrella", "board"]));
    const tavern = meetingRoom("the-campaign", 5, "A D&D campaign");
    expect(tavern.props.filter((p) => p.kind === "candle").every((c) => c.on?.startsWith("table-"))).toBe(true);
    const plain = meetingRoom("standup", 3);
    expect(plain.props.some((p) => p.kind === "palm")).toBe(false);
    expect(plain.props.find((p) => p.kind === "board")).toMatchObject({ action: "tasks" });
    for (const theme of ["vacation", "dnd campaign", "podcast", "code review", "research", "standup"])
      for (const n of [2, 5, 9]) expect(placeProblems(meetingRoom(theme, n)), `${theme} ${n}`).toEqual([]);
    // A room of conversation is dressed by its purpose, not only its name.
    const weekend = [{ ref: "local:weekend", name: "weekend", purpose: "Plan the family vacation", members: ["host"] }];
    const found = await scene(state, owner, roomPlaceId("local:weekend"), weekend, hasBody);
    expect(found?.place.props.some((p) => p.kind === "palm")).toBe(true);
  });

  it("finds nothing for a place that isn't there", async () => {
    expect(await scene(state, owner, "shared:attic", rooms, hasBody)).toBeNull();
    expect(await scene(state, owner, "room:local:gone", rooms, hasBody)).toBeNull();
    expect(await scene(state, owner, homeId("bodiless"), rooms, hasBody)).toBeNull();
  });

  it("seats any number of members without anything overlapping, wider as it fills", () => {
    let last = 0;
    for (const n of [0, 1, 2, 3, 5, 8, 12, 16]) {
      const room = meetingRoom("standup", n);
      expect(placeProblems(room), `${n} seats`).toEqual([]);
      expect(room.props.filter((p) => p.kind === "armchair")).toHaveLength(Math.max(2, n));
      // Lit after dark.
      expect(room.props.filter((p) => p.kind === "lamp").length).toBeGreaterThan(0);
      expect(room.width).toBeGreaterThanOrEqual(last);
      last = room.width;
    }
  });
});

describe("whether there is anything to do", () => {
  it("only when some agent has a body", () => {
    expect(anyAvatar({ agents: {} } as never)).toBe(false);
    expect(anyAvatar({ live: { avatar: { model: "robot.vrm" } }, agents: {} } as never)).toBe(true);
    expect(anyAvatar({ agents: { guide: { avatar: { model: "guide.vrm" } } } } as never)).toBe(true);
    expect(anyAvatar({ live: { avatar: { model: "robot.vrm" } }, agents: { a: { avatar: false } } } as never)).toBe(
      true,
    );
  });
});
