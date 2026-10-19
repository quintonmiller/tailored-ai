/**
 * Places: the room an agent's body lives in, and the `place` tool that
 * changes it. Placement works in words ("by the window", "on the desk"),
 * things never overlap or stand on a spot the avatar needs, what stands on a
 * thing moves with it, and the tool keeps the room in world state.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  anyAvatar,
  applyAction,
  bodyAt,
  buildWorld,
  homeId,
  mayChange,
  onlyMembers,
  PLACE_TYPE,
  PlaceTool,
  Presence,
  readCurrent,
  readHome,
  roomPlaceId,
  scene,
  TRANSCRIPT_LINES,
  transcript,
  VISIT_SCHEMA,
  VISIT_TYPE,
  visitOf,
  WHEREABOUTS_TYPE,
  whereIs,
  whoIsIn,
  withChange,
  worldMap,
} from "../plugins/places.js";
import type { Shot } from "../plugins/places-camera.js";
import {
  CHANGES_KEPT,
  describe as describeRoom,
  doorOf,
  doorProblems,
  findPlacement,
  firstHome,
  type Place,
  type PlaceItem,
  parseColor,
  placeProblems,
  resize,
  spotOf,
} from "../plugins/places-layout.js";
import {
  homePlace,
  LOBBY,
  lobby,
  meetingRoom,
  NO_THEME,
  retheme,
  sharedPlace,
  THEMES,
  themeFor,
  themeNamed,
} from "../plugins/places-rooms.js";
import { IdentityResolver } from "../rooms/identities.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { RoomStore } from "../rooms/store.js";
import type { Room as TalkRoom } from "../rooms/types.js";
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

describe("the first room", () => {
  it("is sound, and its spots are the ones the avatar has always used", () => {
    const place = firstHome();
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
    const place = must(firstHome(), { action: "add", kind: "armchair", near: "the window", color: "sage" });
    const chair = place.props.at(-1) as PlaceItem;
    expect(chair).toMatchObject({ kind: "armchair", name: "the sage armchair", color: parseColor("sage") });
    // Into the room, as the window looks: not staring at the wall.
    expect(chair.facing).toBe(item(place, "window").facing);
    expect(spotOf(chair)).toBeDefined();
    expect(placeProblems(place)).toEqual([]);
  });

  it("turns a seat put near a TV or a fire to face it", () => {
    // The small first room's door is a gate at the front right, its approach held: the desk chair makes room for the TV.
    let place = must(firstHome(), { action: "remove", item: "desk" });
    place = must(place, { action: "remove", item: "desk chair" });
    place = must(place, { action: "add", kind: "tv", wall: "right" });
    place = must(place, { action: "add", kind: "armchair", near: "the TV", side: "front" });
    const tv = item(place, "tv");
    const chair = place.props.at(-1) as PlaceItem;
    const toTv = (Math.atan2(tv.at[0] - chair.at[0], tv.at[1] - chair.at[1]) * 180) / Math.PI;
    expect(Math.abs(((toTv - chair.facing + 540) % 360) - 180)).toBeLessThan(5);
  });

  it("puts small things on a surface, at its height, and they move with it", () => {
    let place = must(firstHome(), { action: "add", kind: "vase", on: "the desk" });
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
    const place = must(firstHome(), { action: "add", kind: "mug" });
    expect((place.props.at(-1) as PlaceItem).on).toBe("desk");
  });

  it("hangs things on the walls that exist, without covering what is there", () => {
    const refused = applyAction(firstHome(), { action: "add", kind: "picture", wall: "front" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/open/);
    const place = must(firstHome(), { action: "add", kind: "clock", wall: "back" });
    const clock = place.props.at(-1) as PlaceItem;
    expect(clock.at[1]).toBeCloseTo(-place.depth / 2 + 0.01);
    expect(clock.elevation).toBeGreaterThan(1.5);
  });

  it("won't let a tall bookcase hide the window", () => {
    // The left wall holds the window and a bookshelf already: take the shelf away first.
    const place = must(firstHome(), { action: "remove", item: "bookshelf" });
    const window = item(place, "window");
    expect(typeof findPlacement(firstHome(), { kind: "bookshelf" }, { wall: "left" })).toBe("string");
    const got = findPlacement(place, { kind: "bookshelf" }, { wall: "left", near: "the window" });
    expect(typeof got).not.toBe("string");
    if (typeof got === "string") return;
    // Along the left wall, but clear of the window's stretch of it.
    expect(Math.abs(got.at[1] - window.at[1])).toBeGreaterThan(0.6 + 0.45 - 0.01);
  });

  it("names things so they stay tell-apart-able", () => {
    let place = must(firstHome(), { action: "add", kind: "lamp", wall: "right" });
    expect((place.props.at(-1) as PlaceItem).name).toBe("the lamp");
    place = must(place, { action: "add", kind: "lamp", corner: "front left" });
    expect((place.props.at(-1) as PlaceItem).name).toBe("the lamp 2");
    place = must(place, { action: "add", kind: "block", size: "0.3 1.2 0.3", color: "#ff8800", name: "pillar" });
    expect(place.props.at(-1)).toMatchObject({ name: "the pillar", size: [0.3, 1.2, 0.3], color: "#ff8800" });
  });

  it("says why when there's no room, and stops instead of overlapping", () => {
    let place = firstHome();
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
    expect(applyAction(firstHome(), { action: "add", kind: "armchair", color: "blurple" }).text).toMatch(/colour/);
    expect(applyAction(firstHome(), { action: "add", kind: "spaceship" }).text).toMatch(/kind/);
  });
});

describe("changing and removing", () => {
  it("removes what stands on a thing with it, and a click that led to it leads nowhere", () => {
    const out = applyAction(firstHome(), { action: "remove", item: "the desk" });
    expect(out.text).toMatch(/the laptop/);
    const place = out.place as Place;
    expect(place.props.some((p) => p.id === "laptop")).toBe(false);
    expect(spot(place, "desk")).toBeUndefined();
    expect(item(place, "chair").spot).toBeUndefined();
  });

  it("recolours, renames and resizes, and a bigger thing has to fit again", () => {
    let place = must(firstHome(), { action: "change", item: "couch", color: "dark green", name: "the green sofa" });
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
    const place = must(firstHome(), { action: "move", item: "lamp", facing: 45 });
    expect(item(place, "lamp")).toMatchObject({ at: [0.25, -1.5], facing: 45 });
    // A round pot takes no more room turned, so it stays put.
    expect(item(must(firstHome(), { action: "move", item: "plant", facing: 45 }), "plant")).toMatchObject({
      at: [-1.86, -1.5],
      facing: 45,
    });
    // A square desk turned so its corner would meet the wall shifts just enough to stay inside.
    const desk = item(must(firstHome(), { action: "move", item: "desk", facing: 30 }), "desk");
    expect(desk.facing).toBe(30);
    expect(Math.hypot(desk.at[0] - 1.35, desk.at[1] + 1.47)).toBeLessThan(0.5);
  });
});

describe("the room itself", () => {
  it("resizes with what is against a wall staying against it", () => {
    const place = resize(firstHome(), { width: 5, depth: 4 });
    expect(typeof place).not.toBe("string");
    if (typeof place === "string") return;
    expect(item(place, "window").at[0]).toBeCloseTo(-2.49);
    expect(item(place, "couch").at[1]).toBeCloseTo(-1.58);
    expect(placeProblems(place)).toEqual([]);
  });

  it("refuses a size that would push things out, saying which", () => {
    const out = applyAction(firstHome(), { action: "room", width: 2.5, depth: 2.5 });
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/doesn't work/);
  });

  it("repaints walls and floor", () => {
    const place = must(firstHome(), { action: "room", walls: "pale blue", floor: "tile" });
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
    const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
    const before = (await readHome(state, owner, "assistant")).place;
    await t.execute({ action: "add", kind: "plant", corner: "front right" }, context("assistant"));
    const undone = await t.execute({ action: "undo" }, context("assistant"));
    expect(undone.success, undone.error).toBe(true);
    const { place } = await readHome(state, owner, "assistant");
    expect(place.props.map((p) => p.id)).toEqual(before.props.map((p) => p.id));
  });

  it("works from what is there now when someone changes the room between its read and its write", async () => {
    const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
    const plants = (await readHome(state, owner, "assistant")).place.props.filter((p) => p.kind === "plant").length;
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
    expect(now.props.filter((p) => p.kind === "plant")).toHaveLength(plants + 1);
  });

  it("says which area the room is in and where its door is, and keeps the doorway clear of what is added", async () => {
    const t = tool();
    const look = await t.execute({ action: "look" }, context("assistant"));
    expect(String(look.output)).toMatch(/It is in the main building\. Its door is on the (back|left) wall, toward the/);
    const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
    const before = (await readHome(state, owner, "assistant")).place;
    const door = doorOf(before);
    for (const kind of ["plant", "armchair", "lamp", "plant", "window"])
      await t.execute({ action: "add", kind, near: "the door" }, context("assistant"));
    const after = (await readHome(state, owner, "assistant")).place;
    expect(after.props.length).toBeGreaterThan(before.props.length);
    expect(doorOf(after)).toEqual(door);
    expect(doorProblems(after, [door as never])).toEqual([]);
  });

  it("mentions a door only when the building gives the room one: alone in an area of its own, it has none", async () => {
    const t = tool();
    await t.execute({ action: "room", area: "the attic" }, context("assistant"));
    const alone = String((await t.execute({ action: "look" }, context("assistant"))).output);
    expect(alone).toMatch(/It is in the attic, the only place there, so it has no door yet: the map is the way in\./);
    expect(alone).not.toMatch(/Its door is/);
    // A shared place in the same area, however it is written: now there is a door between them.
    const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
    const loft = { ...sharedPlace("shared:loft", "the loft"), area: "The Attic" };
    await state.put(owner, { type: PLACE_TYPE, id: "shared:loft", scope: "global", data: loft as never });
    const joined = String((await t.execute({ action: "look" }, context("assistant"))).output);
    expect(joined).toMatch(/You are at home\..* It is in the attic\. Its door is /);
  });

  it("moves the room to an area and back, and signs say what they're called", () => {
    const room = firstHome();
    const away = must(room, { action: "room", area: "the summer house" });
    expect(away.area).toBe("the summer house");
    expect(must(away, { action: "room", area: "the main building" }).area).toBeUndefined();
    const signed = must(room, { action: "add", kind: "sign", name: "the Reading Room", wall: "back" });
    expect(signed.props.find((p) => p.kind === "sign")).toMatchObject({
      label: "Reading Room",
      name: "the Reading Room",
    });
    const renamed = must(signed, { action: "change", item: "the Reading Room", name: "Quiet please" });
    expect(renamed.props.find((p) => p.kind === "sign")?.label).toBe("Quiet please");
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
  beforeEach(async () => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    // A room someone has made their own (the first room, with its couch): it stays exactly as it is.
    await state.put(
      { actor: { kind: "user", name: "owner" } },
      {
        type: PLACE_TYPE,
        id: homeId("assistant"),
        scope: "agent:assistant",
        data: firstHome("assistant's room") as never,
      },
    );
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

  it("hangs each photo in the room it was taken in, newest first, keeping the last six", async () => {
    const tool = new PlaceTool(
      () => state,
      () => true,
      async () => Buffer.from("png"),
    );
    const store = memoryStore();
    const ctx = { agentName: "assistant", sessionId: "s1", mediaStore: store } as unknown as ToolContext;
    await tool.execute({ action: "photo", view: "selfie" }, ctx);
    await tool.execute({ action: "photo" }, ctx);
    const home = await readHome(state, { actor: { kind: "user", name: "owner" } }, "assistant");
    expect(home.place.photos?.map((p) => [p.media, p.what])).toEqual([
      ["img-2", "assistant's room"],
      ["img-1", "a selfie"],
    ]);
    for (let i = 0; i < 6; i++) await tool.execute({ action: "photo" }, ctx);
    const after = await readHome(state, { actor: { kind: "user", name: "owner" } }, "assistant");
    expect(after.place.photos?.map((p) => p.media)).toEqual(["img-8", "img-7", "img-6", "img-5", "img-4", "img-3"]);
    // The room is still what it was.
    expect(after.place.props).toEqual(home.place.props);
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
    const homeBefore = (await readHome(state, owner, "host")).place;
    const before = (lounge?.data as unknown as Place).props.length;
    const added = await tool.execute({ action: "add", kind: "beanbag", corner: "front left" }, as("host"));
    expect(added.success, added.error).toBe(true);
    const after = await state.get(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    expect((after?.data as unknown as Place).props).toHaveLength(before + 1);
    // Home is untouched by it.
    expect((await readHome(state, owner, "host")).place).toEqual(homeBefore);
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
      /no place called "the attic". There is: the lounge/,
    );
    expect((await tool.execute({ action: "new", name: "Lounge" }, as("guest"))).error).toMatch(/already a place/);
  });

  it("sends an agent home when the place it was in is gone", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await state.delete(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    expect(await whereIs(state, owner, "host")).toBe(homeId("host"));
  });
});

describe("bodies going where the talk is", () => {
  const types = [
    { name: PLACE_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
    { name: VISIT_TYPE, scope: "global" as const, provider: "memory", schema: VISIT_SCHEMA as never },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const bodies = new Set(["host", "guest", "other"]);
  const hasBody = (agent: string | undefined) => bodies.has(agent ?? "default");
  const rooms = [{ ref: "local:trip", name: "trip", members: ["host", "guest"] }];
  const trip = roomPlaceId("local:trip");
  const QUIET = 10 * 60_000;
  let state: StateService;
  let tool: PlaceTool;
  let presence: Presence;
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  const visit = async (agent: string) => state.get(owner, { type: VISIT_TYPE, id: agent });
  const lives = async (agent: string) => state.get(owner, { type: WHEREABOUTS_TYPE, id: agent });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T02:00:00Z"));
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    tool = new PlaceTool(() => state, hasBody);
    presence = new Presence({ state: () => state, hasBody, quietMs: QUIET });
  });
  afterEach(() => vi.useRealTimers());

  it("puts a body in the meeting room of a room it talks in, out of its home, still living there", async () => {
    await presence.visit("host", "local:trip");
    expect(await bodyAt(state, owner, "host")).toBe(trip);
    // The place tool still works on its home, and where it lives is never written for a visit.
    expect(await whereIs(state, owner, "host")).toBe(homeId("host"));
    expect(await lives("host")).toBeNull();
    expect(await whoIsIn(state, owner, trip, hasBody)).toEqual(["host"]);
    expect(await whoIsIn(state, owner, homeId("host"), hasBody)).toEqual([]);
    expect((await scene(state, owner, trip, rooms, hasBody))?.agents).toEqual(["host"]);
    const map = await worldMap(state, owner, ["host", "guest"], rooms, hasBody);
    expect(map.find((p) => p.id === trip)?.agents).toEqual(["host"]);
    expect(map.find((p) => p.id === homeId("host"))?.agents).toEqual([]);
    expect(map.find((p) => p.id === homeId("guest"))?.agents).toEqual(["guest"]);
  });

  it("goes home after a quiet spell, and the sweep clears the visit away", async () => {
    await presence.visit("host", "local:trip");
    vi.setSystemTime(Date.now() + QUIET - 1000);
    expect(await bodyAt(state, owner, "host")).toBe(trip);
    vi.setSystemTime(Date.now() + 2000);
    expect(await bodyAt(state, owner, "host")).toBe(homeId("host"));
    expect(await whoIsIn(state, owner, homeId("host"), hasBody)).toEqual(["host"]);
    expect(await visit("host")).not.toBeNull();
    await presence.sweep();
    expect(await visit("host")).toBeNull();
  });

  it("stays while the talk goes on, without writing every message", async () => {
    await presence.visit("host", "local:trip");
    const first = await visit("host");
    vi.setSystemTime(Date.now() + 20_000);
    await presence.visit("host", "local:trip");
    expect((await visit("host"))?.version).toBe(first?.version);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await presence.visit("host", "local:trip");
    const later = await visit("host");
    expect(Date.parse(String(later?.data.until))).toBe(Date.now() + QUIET);
    // Long after the first message, but not long after the last: still there.
    vi.setSystemTime(Date.now() + QUIET - 1000);
    expect(await bodyAt(state, owner, "host")).toBe(trip);
  });

  it("moves nobody for being woken, but keeps a body that is there a while longer", async () => {
    // Woken and quiet: it stays where it was.
    await presence.stay("host", "local:trip");
    expect(await visit("host")).toBeNull();
    expect(await bodyAt(state, owner, "host")).toBe(homeId("host"));
    // Talking in one room, woken by another: it stays at the table it is at.
    await presence.visit("host", "local:trip");
    await presence.stay("host", "local:other");
    expect(await bodyAt(state, owner, "host")).toBe(trip);
    // Woken again where it is talking, after a while: it stays longer.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    await presence.stay("host", "local:trip");
    expect(Date.parse(String((await visit("host"))?.data.until))).toBe(Date.now() + QUIET);
  });

  it("never ends a visit that went on while the sweep was looking", async () => {
    await presence.visit("host", "local:trip");
    vi.setSystemTime(Date.now() + QUIET + 1000);
    // The sweep finds the visit over; the host speaks again before the sweep gets to it.
    const swept = presence.sweep();
    const spoke = presence.visit("host", "local:trip");
    await Promise.all([swept, spoke]);
    expect(await bodyAt(state, owner, "host")).toBe(trip);
    expect(Date.parse(String((await visit("host"))?.data.until))).toBe(Date.now() + QUIET);
  });

  it("goes back to the shared place it lives in, not home", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await presence.visit("host", "local:trip");
    // Even by way of another room.
    await presence.visit("host", "local:other");
    expect(await bodyAt(state, owner, "host")).toBe(roomPlaceId("local:other"));
    expect(await whereIs(state, owner, "host")).toBe("shared:lounge");
    expect((await tool.execute({ action: "look" }, as("host"))).output).toMatch(/You are in the lounge/);
    vi.setSystemTime(Date.now() + QUIET + 1000);
    expect(await bodyAt(state, owner, "host")).toBe("shared:lounge");
    await presence.sweep();
    expect(await visit("host")).toBeNull();
    expect(await lives("host")).toMatchObject({ data: { place: "shared:lounge" } });
  });

  it("leaves a body that has none, and ends a visit when the place tool moves the body", async () => {
    await presence.visit("bodiless", "local:trip");
    expect(await visit("bodiless")).toBeNull();
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await presence.visit("host", "local:trip");
    await tool.execute({ action: "go", to: "home" }, as("host"));
    expect(await bodyAt(state, owner, "host")).toBe(homeId("host"));
    await presence.visit("host", "local:trip");
    await tool.execute({ action: "go", to: "lounge" }, as("host"));
    expect(await bodyAt(state, owner, "host")).toBe("shared:lounge");
  });

  it("never keeps a body in a meeting room on whereabouts alone", async () => {
    await state.put(owner, { type: WHEREABOUTS_TYPE, id: "host", scope: "global", data: { place: trip } });
    expect(await bodyAt(state, owner, "host")).toBe(homeId("host"));
    expect(await whoIsIn(state, owner, trip, hasBody)).toEqual([]);
    const map = await worldMap(state, owner, ["host", "guest"], rooms, hasBody);
    expect(map.find((p) => p.id === trip)?.agents).toEqual([]);
    expect(map.find((p) => p.id === homeId("host"))?.agents).toEqual(["host"]);
  });

  it("reads a visit's end from its record alone", () => {
    const now = Date.parse("2026-10-19T02:00:00Z");
    const record = { place: trip, until: "2026-10-19T02:10:00Z" };
    expect(visitOf(record, now)).toBe(trip);
    expect(visitOf(record, now + QUIET)).toBeUndefined();
    expect(visitOf({ place: trip }, now)).toBeUndefined();
    expect(visitOf(undefined, now)).toBeUndefined();
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
      // Where everyone starts, and the hall off it with a door to each home.
      ["lobby", "lobby", []],
      ["hall:main:homes-1", "hall", []],
      ["home:host", "home", []],
      ["home:guest", "home", []],
      ["home:other", "home", ["other"]],
      ["shared:lounge", "shared", ["guest", "host"]],
      // Nobody is talking in the room, so nobody is in its meeting room.
      ["room:local:trip", "room", []],
    ]);
    // A room lists its members wherever their bodies are; one without a body isn't drawn.
    expect(map.find((p) => p.kind === "room")).toMatchObject({
      name: "trip",
      purpose: "Plan the trip",
      members: ["guest", "host"],
    });
    expect(new Set(map.map((p) => p.area))).toEqual(new Set(["main"]));
  });

  it("has a body at home when the place it went to is gone", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    await state.delete(owner, { type: PLACE_TYPE, id: "shared:lounge" });
    const map = await worldMap(state, owner, ["host"], [], hasBody);
    expect(map.filter((p) => p.kind !== "lobby")).toEqual([
      { id: "home:host", name: "host's room", kind: "home", owner: "host", agents: ["host"], area: "main" },
    ]);
  });

  it("puts a place in an area of its own, joined to the others there by doors and to the main building by the map", async () => {
    await tool.execute({ action: "new", name: "porch", area: "the summer house" }, as("host"));
    const moved = await tool.execute({ action: "room", area: "the summer house" }, as("guest"));
    expect(moved.success, moved.error).toBe(true);
    expect(moved.output).toMatch(/the summer house/);
    const map = await worldMap(state, owner, ["host", "guest", "other"], rooms, hasBody);
    expect(map.filter((p) => p.area === "summer-house").map((p) => p.id)).toEqual(["home:guest", "shared:porch"]);
    const world = await buildWorld(state, owner, ["host", "guest", "other"], rooms, hasBody);
    expect(world.areas.map((a) => a.name)).toEqual(["the main building", "the summer house"]);
    // Door to door: the porch and the guest's home.
    const porch = await scene(state, owner, "shared:porch", rooms, hasBody, world);
    expect(porch?.doors.map((d) => [d.to, d.label])).toEqual([["home:guest", "guest"]]);
    const guest = await scene(state, owner, homeId("guest"), rooms, hasBody, world);
    expect(guest?.doors.map((d) => d.to)).toEqual(["shared:porch"]);
    // Back in the main building, the guest's home is off the residences again.
    await tool.execute({ action: "room", area: "main" }, as("guest"));
    const again = await buildWorld(state, owner, ["host", "guest", "other"], rooms, hasBody);
    expect(again.doors.get(homeId("guest"))?.to).toBe("hall:main:homes-1");
    expect(again.doors.has("shared:porch")).toBe(false);
  });

  it("gives every place doors that match the doors on the other side, wherever they are in the room", async () => {
    await tool.execute({ action: "new", name: "lounge" }, as("host"));
    const agents = ["host", "guest", "other"];
    const world = await buildWorld(state, owner, agents, rooms, hasBody);
    const ids = [
      LOBBY,
      ...world.halls.map((h) => h.id),
      ...agents.map(homeId),
      "shared:lounge",
      roomPlaceId("local:trip"),
    ];
    const seen = new Map<string, { to: string }[]>();
    for (const id of ids) {
      const found = await scene(state, owner, id, rooms, hasBody, world);
      expect(found, id).not.toBeNull();
      expect(doorProblems(found?.place as Place, found?.doors ?? []), id).toEqual([]);
      seen.set(id, found?.doors ?? []);
    }
    for (const [id, doors] of seen) {
      expect(doors.length, id).toBeGreaterThan(0);
      for (const d of doors)
        expect(
          seen.get(d.to)?.some((back) => back.to === id),
          `${id} -> ${d.to}`,
        ).toBe(true);
    }
    // A home's door is where its room keeps its doorway, and its plate names the hall.
    const home = await scene(state, owner, homeId("other"), rooms, hasBody, world);
    expect(home?.doors[0]).toMatchObject({
      ...doorOf(home?.place as Place),
      to: "hall:main:homes-1",
      label: "Residences",
    });
    const hall = await scene(state, owner, "hall:main:homes-1", rooms, hasBody, world);
    expect(hall?.doors.find((d) => d.to === homeId("other"))).toMatchObject({ label: "other", occupant: "other" });
    // A hall is only there while the building has it.
    expect(await scene(state, owner, "hall:main:homes-9", rooms, hasBody, world)).toBeNull();
  });

  it("shows a room of conversation as a meeting room, a seat for each member with a body", async () => {
    const found = await scene(state, owner, roomPlaceId("local:trip"), rooms, hasBody);
    // Only the members talking there now are in it.
    expect(found?.agents).toEqual([]);
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
    const { walls, floor, floorColor } = beach;
    expect(THEMES.find((t) => t.id === "beach")?.palettes).toContainEqual({
      walls,
      floor,
      ...(floorColor ? { floorColor } : {}),
    });
    expect(beach.props.map((p) => p.kind)).toEqual(expect.arrayContaining(["palm", "umbrella", "board"]));
    for (const n of [5, 9]) {
      const tavern = meetingRoom("the-campaign", n, "A D&D campaign");
      const tables = tavern.props.filter((p) => /^table-\d+$/.test(p.id));
      // A candle on every table.
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) expect(tavern.props.some((p) => p.kind === "candle" && p.on === t.id)).toBe(true);
    }
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

  it("hands each caller its own copy of a room drawn once", async () => {
    const first = await scene(state, owner, LOBBY, rooms, hasBody);
    first?.place.props.splice(0);
    const again = await scene(state, owner, LOBBY, rooms, hasBody);
    expect(again?.place).toEqual(lobby());
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
      expect(room.props.filter((p) => p.id.startsWith("seat-"))).toHaveLength(Math.max(2, n));
      // Lit after dark.
      expect(room.props.filter((p) => p.kind === "lamp").length).toBeGreaterThan(0);
      expect(room.width).toBeGreaterThanOrEqual(last);
      last = room.width;
    }
  });
});

describe("a room's conversation, for a visitor to read", () => {
  let db: Database.Database;
  let store: RoomStore;
  let backend: LocalRoomBackend;
  const ids = new IdentityResolver({ agentNames: ["planner", "writer"], ownerLabel: "alex" });
  const trip = () => store.getRoomByRef("local:trip") as TalkRoom;
  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    backend = new LocalRoomBackend(db, store);
    store.upsertRoom({ ref: { backend: "local", id: "trip" }, name: "trip", purpose: "Plan the trip" });
  });
  afterEach(() => db.close());

  it("reads the latest lines oldest first, each speaker named, with the agent behind the name", async () => {
    await backend.post("trip", { body: "Flights are booked.", speaker: "planner" });
    await backend.post("trip", { body: "Lovely, thanks.", speaker: "writer", to: ["planner"] });
    // A person typing in the room's own app: no envelope, just their account.
    db.prepare("INSERT INTO room_messages (room_ref, author_id, author_label, content) VALUES (?, ?, ?, ?)").run(
      "local:trip",
      "u-1",
      "Sam",
      "Make it a window seat.",
    );
    const said = await transcript(trip(), backend, ids, ["planner", "writer"]);
    expect(said).toMatchObject({ name: "trip", purpose: "Plan the trip", members: ["planner", "writer"] });
    if ("error" in said) throw new Error(said.error);
    expect(said.lines.map((l) => [l.who, l.agent, l.to, l.text])).toEqual([
      ["planner", "planner", [], "Flights are booked."],
      ["writer", "writer", ["planner"], "Lovely, thanks."],
      // A person is named, with no agent behind them.
      ["Sam", undefined, [], "Make it a window seat."],
    ]);
    // The room's own announcements are named once, not twice.
    await backend.post("trip", { body: "**writer** joined this room.", speaker: "room" });
    const again = await transcript(trip(), backend, ids, []);
    if ("error" in again) throw new Error(again.error);
    expect(again.lines.at(-1)).toMatchObject({ who: "room", text: "**writer** joined this room." });
    // Times are ISO, so a browser reads them as the UTC they are.
    expect(said.lines[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("shows only the latest lines, and moves nobody's read cursor", async () => {
    store.subscribe({ agent: "planner", roomRef: "local:trip", initialCursor: null });
    for (let i = 0; i < TRANSCRIPT_LINES + 5; i++) await backend.post("trip", { body: `line ${i}`, speaker: "writer" });
    const said = await transcript(trip(), backend, ids, ["planner"]);
    if ("error" in said) throw new Error(said.error);
    expect(said.lines).toHaveLength(TRANSCRIPT_LINES);
    expect(said.lines.at(-1)?.text).toBe(`line ${TRANSCRIPT_LINES + 4}`);
    expect(store.getSubscription("planner", "local:trip")?.cursor ?? null).toBeNull();
  });

  it("says why when the room's transport isn't there to read", async () => {
    expect(await transcript(trip(), undefined, ids, [])).toEqual({
      error: "The local rooms aren't connected right now.",
    });
    const broken = { ...backend, fetchSince: async () => Promise.reject(new Error("gateway down")) } as never;
    expect(await transcript(trip(), broken, ids, [])).toEqual({ error: "Couldn't read #trip: gateway down" });
  });
});

describe("homes made before rooms were drawn from a seed", () => {
  const types = [{ name: PLACE_TYPE, scope: "agent" as const }];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const system: StateCaller = { actor: { kind: "plugin", name: "places" } };
  const agent: StateCaller = { actor: { kind: "agent", name: "assistant" }, source: { tool: "place" } };
  const ref = { type: PLACE_TYPE, id: homeId("assistant") };
  const drawn = () => homePlace(homeId("assistant"), "assistant's room");
  let state: StateService;
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
  });
  const store = (caller: StateCaller, data: Place, version?: number) =>
    state.put(caller, { ...ref, scope: "agent:assistant", data: data as never }, version);

  it("draws a new home from its id, made by the system", async () => {
    expect((await readHome(state, agent, "assistant")).place).toEqual(drawn());
    expect((await state.get(owner, ref))?.updatedBy).toEqual(system.actor);
  });

  it("gives a home the system made as the first room a room of its own", async () => {
    await store(system, firstHome("assistant's room"));
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
    const changes = await state.history(owner, ref);
    expect(changes.map((c) => c.actor.kind)).toEqual(["plugin", "plugin"]);
  });

  it("does the same for a first room the agent's first look made, and nobody changed", async () => {
    await store(agent, firstHome("assistant's room"));
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
  });

  it("brings a home only the system has written up to the room its id draws now", async () => {
    await store(system, firstHome("assistant's room"));
    await readHome(state, owner, "assistant");
    // A room an older way of drawing gave it.
    const older = homePlace("some other seed", "assistant's room");
    const now = await state.get(owner, ref);
    await store(system, older, now?.version);
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
    // And leaves it be once it is that room.
    const version = (await state.get(owner, ref))?.version;
    await readHome(state, owner, "assistant");
    expect((await state.get(owner, ref))?.version).toBe(version);
  });

  it("never replaces a home anyone else has changed", async () => {
    // The agent added a plant to the first room.
    await store(system, firstHome("assistant's room"));
    const v1 = await state.get(owner, ref);
    const planted = applyAction(firstHome("assistant's room"), { action: "add", kind: "plant", corner: "front left" });
    await store(agent, planted.place as Place, v1?.version);
    expect((await readHome(state, owner, "assistant")).place).toEqual(planted.place);
    // A person repainted it.
    const repainted = { ...(planted.place as Place), walls: "#112233" };
    await store(owner, repainted, (await state.get(owner, ref))?.version);
    expect((await readHome(state, owner, "assistant")).place).toEqual(repainted);
    // Whatever is written to it later, by anyone, it stays theirs.
    await store(system, firstHome("assistant's room"), (await state.get(owner, ref))?.version);
    expect((await readHome(state, owner, "assistant")).place).toEqual(firstHome("assistant's room"));
  });

  it("counts only what was written since the room was last made: a home someone cleared is the system's again", async () => {
    await store(system, firstHome("assistant's room"));
    const planted = applyAction(firstHome("assistant's room"), { action: "add", kind: "plant", corner: "front left" });
    await store(agent, planted.place as Place, (await state.get(owner, ref))?.version);
    await state.delete(owner, ref);
    // Made again, the old way, after the person cleared it.
    await store(system, firstHome("assistant's room"));
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
  });

  it("keeps a first room the agent's first look made up to date, as long as nobody changes it", async () => {
    await store(agent, firstHome("assistant's room"));
    await readHome(state, owner, "assistant");
    // The way rooms are drawn changes again.
    await store(system, homePlace("some other seed", "assistant's room"), (await state.get(owner, ref))?.version);
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
  });

  it("won't let an undo take back the system's redraw", async () => {
    await store(system, firstHome("assistant's room"));
    const tool = new PlaceTool(
      () => state,
      () => true,
    );
    const undone = await tool.execute({ action: "undo" }, { agentName: "assistant" } as ToolContext);
    expect(undone.success).toBe(false);
    expect(undone.error).toMatch(/nothing to undo/);
    expect((await state.get(owner, ref))?.updatedBy).toEqual(system.actor);
    expect((await readHome(state, owner, "assistant")).place).toEqual(drawn());
  });

  it("never writes a new home over one someone made a moment ago", async () => {
    const own = { ...firstHome("assistant's room"), walls: "#334455" };
    await store(agent, own);
    // A reader that looked just before the agent's room was made, and found none.
    let missed = false;
    const racing = new Proxy(state, {
      get(target, key) {
        if (key === "get" && !missed) {
          missed = true;
          return async () => null;
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect((await readHome(racing, owner, "assistant")).place).toEqual(own);
    expect((await state.get(owner, ref))?.data).toEqual(own);
  });

  it("reads one change of a home an agent has changed, not its whole history", async () => {
    await store(system, firstHome("assistant's room"));
    let place = (await readHome(state, owner, "assistant")).place;
    for (const corner of ["front right", "front left", "back left"]) {
      place = applyAction(place, { action: "add", kind: "plant", corner }).place as Place;
      await store(agent, place, (await state.get(owner, ref))?.version);
    }
    const history = vi.spyOn(state, "history");
    expect((await readHome(state, owner, "assistant")).place).toEqual(place);
    expect(history.mock.calls.map((c) => c[2]?.limit)).toEqual([1]);
  });

  it("never replaces a room an agent wrote that isn't the first room, or one a person made", async () => {
    const own = { ...firstHome("assistant's room"), walls: "#334455" };
    await store(agent, own);
    expect((await readHome(state, owner, "assistant")).place).toEqual(own);
    const other = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    await other.put(owner, { ...ref, scope: "agent:assistant", data: firstHome("assistant's room") as never });
    expect((await readHome(other, owner, "assistant")).place).toEqual(firstHome("assistant's room"));
  });
});

describe("meeting rooms its members can change", () => {
  const types = [
    { name: PLACE_TYPE, scope: "agent" as const },
    { name: WHEREABOUTS_TYPE, scope: "global" as const },
  ];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const bodies = new Set(["host", "guest", "other"]);
  const hasBody = (agent: string | undefined) => bodies.has(agent ?? "default");
  const id = roomPlaceId("local:trip");
  let rooms: { ref: string; name: string; purpose?: string; members: string[] }[];
  let state: StateService;
  let tool: PlaceTool;
  const as = (agentName: string) => ({ agentName }) as ToolContext;
  const kept = async () => (await state.get(owner, { type: PLACE_TYPE, id }))?.data as unknown as Place | undefined;
  beforeEach(() => {
    rooms = [{ ref: "local:trip", name: "trip", purpose: "Plan the trip", members: ["host", "guest", "nobody"] }];
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    tool = new PlaceTool(
      () => state,
      hasBody,
      undefined,
      () => rooms,
    );
  });

  it("lets only a home's owner, a room's members, and anyone in a shared place change them", () => {
    expect(mayChange(homeId("host"), "host", rooms)).toBe(true);
    expect(mayChange(homeId("host"), "guest", rooms)).toBe(false);
    expect(mayChange(id, "guest", rooms)).toBe(true);
    expect(mayChange(id, "other", rooms)).toBe(false);
    expect(mayChange(roomPlaceId("local:gone"), "host", rooms)).toBe(false);
    expect(mayChange("shared:lounge", "other", rooms)).toBe(true);
    expect(mayChange(LOBBY, "host", rooms)).toBe(false);
    expect(mayChange("hall:main:homes-1", "host", rooms)).toBe(false);
  });

  it("turns a non-member away, saying who can go in", async () => {
    const refused = await tool.execute({ action: "go", to: "#trip" }, as("other"));
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/guest and host can go in and change it/);
    expect(onlyMembers(rooms[0], hasBody)).not.toMatch(/nobody/);
    expect(await whereIs(state, owner, "other", rooms)).toBe(homeId("other"));
  });

  it("is drawn from its room until a member changes it, and kept as they left it from then on", async () => {
    const drawn = (await scene(state, owner, id, rooms, hasBody))?.place as Place;
    expect(await kept()).toBeUndefined();
    const went = await tool.execute({ action: "go", to: "trip" }, as("host"));
    expect(went.success, went.error).toBe(true);
    expect(String(went.output)).toMatch(/meeting room of #trip/);
    expect(await whereIs(state, owner, "host", rooms)).toBe(id);
    // Out of its home while it is there, on the map and in the home itself.
    expect((await scene(state, owner, homeId("host"), rooms, hasBody))?.agents).toEqual([]);
    const map = await worldMap(state, owner, ["host", "guest"], rooms, hasBody);
    expect(map.find((p) => p.id === homeId("host"))?.agents).toEqual([]);
    expect(String((await tool.execute({ action: "look" }, as("host"))).output)).toMatch(
      /meeting room of #trip.*Also here: guest/,
    );
    // Going there changes nothing: the room is still the one drawn for it.
    expect(await kept()).toBeUndefined();

    const added = await tool.execute({ action: "add", kind: "aquarium", name: "the fish tank" }, as("host"));
    expect(added.success, added.error).toBe(true);
    const record = await state.get(owner, { type: PLACE_TYPE, id });
    expect(record?.scope).toBe("global");
    expect(record?.updatedBy).toEqual({ kind: "agent", name: "host" });
    const place = record?.data as unknown as Place;
    expect(place.props.length).toBe(drawn.props.length + 1);
    // Its home is untouched.
    expect((await readHome(state, owner, "host")).place.props.some((p) => p.id === place.props.at(-1)?.id)).toBe(false);

    // Drawn from the record now, members and doors as before, even when the room gains a member.
    rooms[0].members.push("other");
    const world = await buildWorld(state, owner, ["host", "guest", "other"], rooms, hasBody);
    const now = await scene(state, owner, id, rooms, hasBody, world);
    expect(now?.place).toEqual(place);
    expect(now?.agents).toEqual(["guest", "host", "other"]);
    expect(now?.doors.length).toBeGreaterThan(0);
    expect(doorProblems(now?.place as Place, now?.doors ?? [])).toEqual([]);

    // Another member works from what the first left.
    await tool.execute({ action: "go", to: "trip" }, as("guest"));
    const more = await tool.execute({ action: "add", kind: "cactus" }, as("guest"));
    expect(more.success, more.error).toBe(true);
    const both = (await kept()) as Place;
    expect(both.props.length).toBe(drawn.props.length + 2);
    expect(both.changes?.map((c) => c.who)).toEqual(["guest", "host"]);
  });

  it("takes back the first change by going back to the room as drawn", async () => {
    await tool.execute({ action: "go", to: "trip" }, as("host"));
    await tool.execute({ action: "add", kind: "aquarium", name: "the fish tank" }, as("host"));
    expect(await kept()).toBeDefined();
    const undone = await tool.execute({ action: "undo" }, as("host"));
    expect(undone.success, undone.error).toBe(true);
    expect(await kept()).toBeUndefined();
    expect((await scene(state, owner, id, rooms, hasBody))?.place.props.some((p) => p.name === "the fish tank")).toBe(
      false,
    );
  });

  it("sends a member who has left the room home, and keeps the meeting room in its wing", async () => {
    await tool.execute({ action: "go", to: "trip" }, as("guest"));
    const moved = await tool.execute({ action: "room", area: "the summer house" }, as("guest"));
    expect(moved.success).toBe(false);
    expect(moved.error).toMatch(/meeting rooms' wing/);
    rooms[0].members = ["host"];
    expect(await whereIs(state, owner, "guest", rooms)).toBe(homeId("guest"));
    expect((await readCurrent(state, owner, "guest", { rooms, hasBody })).id).toBe(homeId("guest"));
  });

  it("lists the meeting rooms an agent can go to with the places it knows", async () => {
    const listed = String((await tool.execute({ action: "places" }, as("host"))).output);
    expect(listed).toMatch(/#trip, the meeting room of a room you talk in: guest is there/);
    expect(String((await tool.execute({ action: "places" }, as("other"))).output)).not.toMatch(/#trip/);
  });
});

describe("a theme and a purpose, by choice", () => {
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  const palettes = (id: string) => THEMES.find((t) => t.id === id)?.palettes ?? [];
  const paint = (p: Place) => ({
    walls: p.walls,
    floor: p.floor,
    ...(p.floorColor ? { floorColor: p.floorColor } : {}),
  });

  it("reads a theme from its id, its words, or none", () => {
    expect(themeNamed("Beach")).toMatchObject({ id: "beach" });
    expect(themeNamed("the seaside")).toMatchObject({ id: "beach" });
    expect(themeNamed("library")).toMatchObject({ id: "library" });
    expect(themeNamed("none")).toBe(NO_THEME);
    expect(themeNamed("plain")).toBe(NO_THEME);
    expect(themeNamed("disco")).toBeUndefined();
  });

  it("dresses a meeting room in the theme chosen for it, whatever its name says", () => {
    const guessed = meetingRoom("summer", 4, "Plan the family vacation");
    expect(guessed.theme).toBe("beach");
    const chosen = meetingRoom("summer", 4, "Plan the family vacation", "tavern");
    expect(chosen.theme).toBe("tavern");
    expect(palettes("tavern")).toContainEqual(paint(chosen));
    expect(chosen.props.some((p) => p.kind === "palm" || p.kind === "umbrella")).toBe(false);
    expect(chosen.props.some((p) => p.kind === "candle")).toBe(true);
    const plain = meetingRoom("summer", 4, "Plan the family vacation", NO_THEME);
    expect(plain.theme).toBe(NO_THEME);
    expect(plain.props.some((p) => p.kind === "palm" || p.kind === "umbrella")).toBe(false);
    for (const room of [chosen, plain]) expect(placeProblems(room)).toEqual([]);
    // A room nobody chose for, that its words don't dress, says nothing about a theme.
    expect(meetingRoom("standup", 3).theme).toBeUndefined();
  });

  it("repaints a room someone furnished in the theme, adds the one thing that says it, and moves nothing", () => {
    const home = homePlace("home:host", "host's room", "study");
    const { place, added } = retheme(home, themeNamed("beach") as (typeof THEMES)[number]);
    expect(place.theme).toBe("beach");
    expect(palettes("beach")).toContainEqual(paint(place));
    expect(added?.kind).toBe("palm");
    expect(placeProblems(place)).toEqual([]);
    for (const before of home.props) expect(place.props.find((p) => p.id === before.id)?.at).toEqual(before.at);
    const plain = retheme(place, NO_THEME);
    expect(plain.place.theme).toBe(NO_THEME);
    expect(plain.added).toBeUndefined();
  });

  it("sets a theme, a purpose and a name with the room action, and refuses a theme there isn't", () => {
    const home = homePlace("home:host", "host's room");
    const themed = applyAction(home, {
      action: "room",
      theme: "library",
      purpose: "reading up on Lisbon",
      name: "the den",
    });
    expect(themed.ok, themed.text).toBe(true);
    expect(themed.place).toMatchObject({ theme: "library", purpose: "reading up on Lisbon", name: "the den" });
    expect(themed.did).toBe("gave it the library theme, named it the den, made it a place for reading up on Lisbon");
    expect(describeRoom(themed.place as Place)).toMatch(/It is for: reading up on Lisbon\nIts theme: library\./);
    const cleared = applyAction(themed.place as Place, { action: "room", purpose: "none" });
    expect(cleared.place?.purpose).toBeUndefined();
    const refused = applyAction(home, { action: "room", theme: "disco" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/isn't a theme. The themes are beach, tavern, studio, workshop, library, or none/);
  });

  it("draws an untouched meeting room again in a chosen theme, and keeps it so: the guess never comes back", async () => {
    const types = [
      { name: PLACE_TYPE, scope: "agent" as const },
      { name: WHEREABOUTS_TYPE, scope: "global" as const },
    ];
    const state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    const rooms = [
      { ref: "local:summer", name: "summer", purpose: "Plan the family vacation", members: ["host", "guest"] },
    ];
    const hasBody = (a: string | undefined) => a === "host" || a === "guest";
    const tool = new PlaceTool(
      () => state,
      hasBody,
      undefined,
      () => rooms,
    );
    const id = roomPlaceId("local:summer");
    expect((await scene(state, owner, id, rooms, hasBody))?.place.theme).toBe("beach");
    await tool.execute({ action: "go", to: "summer" }, { agentName: "host" } as ToolContext);
    const done = await tool.execute({ action: "room", theme: "studio", purpose: "recording the trip podcast" }, {
      agentName: "host",
    } as ToolContext);
    expect(done.success, done.error).toBe(true);
    const shown = (await scene(state, owner, id, rooms, hasBody))?.place as Place;
    expect(shown).toMatchObject({ theme: "studio", purpose: "recording the trip podcast", name: "summer" });
    expect(palettes("studio")).toContainEqual(paint(shown));
    expect(shown.props.some((p) => p.kind === "palm" || p.kind === "umbrella")).toBe(false);
    expect(shown.props.some((p) => p.kind === "easel")).toBe(true);
    // The map says what its members say it is for.
    const map = await worldMap(state, owner, ["host", "guest"], rooms, hasBody);
    expect(map.find((p) => p.id === id)?.purpose).toBe("recording the trip podcast");
  });
});

describe("what was done to a room lately", () => {
  const types = [{ name: PLACE_TYPE, scope: "agent" as const }];
  const owner: StateCaller = { actor: { kind: "user", name: "owner" } };
  let state: StateService;
  let clock: number;
  let tool: PlaceTool;
  const as = { agentName: "assistant" } as ToolContext;
  beforeEach(() => {
    state = new StateService({
      getConfig: () => ({ state: { backend: "sqlite", types } }),
      db: new Database(":memory:"),
    });
    clock = Date.parse("2026-10-19T09:00:00Z");
    tool = new PlaceTool(
      () => state,
      (a) => a === "assistant",
      undefined,
      () => [],
      () => new Date((clock += 60_000)),
    );
  });
  const changes = async () => (await readHome(state, owner, "assistant")).place.changes ?? [];

  it("keeps who did what and when, newest first, in a few words", async () => {
    await tool.execute({ action: "add", kind: "beanbag", name: "the reading beanbag", near: "the bookshelf" }, as);
    await tool.execute({ action: "room", walls: "sage" }, as);
    await tool.execute({ action: "change", item: "the reading beanbag", color: "teal" }, as);
    await tool.execute({ action: "remove", item: "the reading beanbag" }, as);
    await tool.execute({ action: "look" }, as);
    expect((await changes()).map((c) => `${c.who} ${c.what}`)).toEqual([
      "assistant removed the reading beanbag",
      "assistant made the reading beanbag teal",
      "assistant painted the walls sage",
      "assistant added the reading beanbag by the bookshelf",
    ]);
    expect((await changes()).map((c) => c.at)).toEqual([
      "2026-10-19T09:04:00.000Z",
      "2026-10-19T09:03:00.000Z",
      "2026-10-19T09:02:00.000Z",
      "2026-10-19T09:01:00.000Z",
    ]);
    expect(String((await tool.execute({ action: "look" }, as)).output)).toMatch(
      /Lately: assistant removed the reading beanbag; assistant made the reading beanbag teal; assistant painted the walls sage\./,
    );
  });

  it("keeps only the last few, and an undo says what it took back", async () => {
    for (let i = 0; i < CHANGES_KEPT + 2; i++)
      await tool.execute({ action: "room", walls: i % 2 ? "sage" : "navy" }, as);
    expect(await changes()).toHaveLength(CHANGES_KEPT);
    await tool.execute({ action: "add", kind: "plant", name: "the fern", corner: "front right" }, as);
    await tool.execute({ action: "undo" }, as);
    const [last, before] = await changes();
    expect(last.what).toBe('took back "added the fern in the front right corner"');
    expect(before.what).toBe("painted the walls sage");
    const place = (await readHome(state, owner, "assistant")).place;
    expect(withChange(place, { who: "planner", what: "added a lamp", at: "x" }).changes?.[0].who).toBe("planner");
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
