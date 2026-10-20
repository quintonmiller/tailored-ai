import { describe, expect, it } from "vitest";
import {
  AWAY_AT,
  AWAY_MORE,
  anchorFor,
  EDGE,
  follow,
  GAP,
  JUMP_PX,
  layoutPanels,
  type PanelIn,
  PLAQUE,
  type Placed,
  plaqueSpot,
  SHEET_BELOW,
  talkAnchor,
  type Where,
  walkedAway,
} from "./anchors";
import type { Box } from "./overhead";
import type { Prop, RoomDoor } from "./scene";

/** The stage a panel is laid out on: 1200 by 700, its edges kept clear. */
const view: Box = { left: EDGE, right: 1200 - EDGE, top: EDGE, bottom: 700 - EDGE };

/** A body standing with the top of its head at `x`, `top`: 70 pixels across, 300 tall, its head the top 60. */
function body(x: number, top: number, tall = 300): NonNullable<PanelIn["target"]> {
  return {
    box: { left: x - 35, right: x + 35, top, bottom: top + tall },
    keep: { left: x - 25, right: x + 25, top: top - 6, bottom: top + tall * 0.2 },
  };
}

const card = (target: PanelIn["target"], more: Partial<PanelIn> = {}): PanelIn => ({
  id: "card",
  size: [340, 260],
  rank: 2,
  ...(target ? { target } : {}),
  ...more,
});

/** The box a placed panel `size` big covers. */
const boxOf = (p: Placed, [w, h]: [number, number]): Box => ({ left: p.x, top: p.y, right: p.x + w, bottom: p.y + h });
const meet = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const inside = (a: Box, b: Box) => a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom;

describe("where a panel goes beside what it is about", () => {
  it("goes beside it on the side with more of the stage to spare, its tail at the shoulder", () => {
    const who = body(300, 200);
    const at = layoutPanels([card(who)], view).get("card") as Placed;
    expect(at.side).toBe("right");
    expect(at.x).toBe(who.box.right + GAP);
    expect(meet(boxOf(at, [340, 260]), who.box)).toBe(false);
    // Its tail meets its edge where the head meets the shoulders.
    expect(at.y + at.tail).toBe(who.keep.bottom);
    expect(inside(boxOf(at, [340, 260]), view)).toBe(true);
  });

  it("keeps clear of a name over a body that is wider than the body", () => {
    const who = body(300, 200);
    const named = { ...who, keep: { ...who.keep, left: 220, right: 420, top: 150 } };
    const at = layoutPanels([card(named)], view).get("card") as Placed;
    expect(at.x).toBe(420 + GAP);
    expect(meet(boxOf(at, [340, 260]), named.keep)).toBe(false);
  });

  it("goes the other side when the stage runs out on this one", () => {
    const who = body(1000, 200);
    const at = layoutPanels([card(who)], view).get("card") as Placed;
    expect(at.side).toBe("left");
    expect(at.x + 340).toBe(who.box.left - GAP);
  });

  it("never covers a face, even when a body up close leaves nowhere that misses all of it", () => {
    // A close-up: the body fills the stage from side to side, its head to the right of its middle.
    const who = {
      box: { left: 100, right: 1100, top: 50, bottom: 690 },
      keep: { left: 700, right: 1000, top: 44, bottom: 330 },
    };
    const at = layoutPanels([card(who, { size: [420, 320] })], view).get("card") as Placed;
    expect(meet(boxOf(at, [420, 320]), who.keep)).toBe(false);
    expect(inside(boxOf(at, [420, 320]), view)).toBe(true);
    // Over its body, then, but on the side away from its face.
    expect(at.x + 420).toBeLessThanOrEqual(who.keep.left);
  });

  it("stays on the screen, its tail still pointing at what it is beside", () => {
    // A thing high on a wall, near the top: the card beside it comes down to the top of the stage, not off it.
    const board = { left: 200, right: 420, top: -40, bottom: 90 };
    const at = layoutPanels([card({ box: board, keep: board })], view).get("card") as Placed;
    expect(at.y).toBe(view.top);
    expect(at.tail).toBeGreaterThan(0);
  });

  it("keeps out from under the tools over the stage, as it would a face", () => {
    const who = body(300, 150);
    // A row of buttons over the stage, just where the card would go beside the body.
    const tools = { left: 330, right: 760, top: 100, bottom: 200 };
    const at = layoutPanels([card(who)], view, [], Number.POSITIVE_INFINITY, [tools]).get("card") as Placed;
    expect(meet(boxOf(at, [340, 260]), tools)).toBe(false);
    expect(meet(boxOf(at, [340, 260]), who.keep)).toBe(false);
    // Even where every place left is a poor one, a button stays clear: below, over another card's corner, instead.
    const board = { left: 130, right: 170, top: 300, bottom: 400 };
    const top = { left: 0, right: 1200, top: 0, bottom: 120 };
    const crowded = layoutPanels(
      [
        card({ box: board, keep: board }, { id: "board", prefer: "right" }),
        card(body(80, 300), { id: "talk", rank: 1 }),
      ],
      view,
      [],
      Number.POSITIVE_INFINITY,
      [top],
    );
    expect(meet(boxOf(crowded.get("talk") as Placed, [340, 260]), top)).toBe(false);
  });

  it("keeps panels out of each other's way, the higher ranked where it would be alone", () => {
    const a = card(body(500, 200), { id: "agent's card", rank: 2 });
    const b = card(body(560, 210), { id: "talk", rank: 1, size: [320, 300] });
    const laid = layoutPanels([b, a], view);
    const first = laid.get("agent's card") as Placed;
    expect(first).toEqual(layoutPanels([a], view).get("agent's card"));
    expect(meet(boxOf(first, a.size), boxOf(laid.get("talk") as Placed, b.size))).toBe(false);
  });

  it("holds a panel with nothing to be beside: in front of you, or docked in the corner, above anything there", () => {
    const front = layoutPanels([card(undefined, { held: "front", size: [600, 400] })], view).get("card") as Placed;
    expect(front.side).toBe("front");
    expect(front.x + 300).toBeCloseTo((view.left + view.right) / 2, 0);
    expect(front.y).toBeGreaterThan(view.top);
    const map = card(undefined, { id: "map", held: "front", size: [600, 640] });
    const docked = layoutPanels([card(undefined, { id: "dock", held: "dock", rank: 1 }), map], view);
    const d = docked.get("dock") as Placed;
    expect(d.side).toBe("dock");
    // Docked under the map, which fills the stage: only the corner below it is left, and that is under it too.
    expect(d.x + 340).toBe(view.right);
    const alone = layoutPanels([card(undefined, { held: "dock" })], view).get("card") as Placed;
    expect([alone.x + 340, alone.y + 260]).toEqual([view.right, view.bottom]);
    const low = { id: "low", size: [340, 200] as [number, number], rank: 2, held: "dock" as const };
    const stacked = layoutPanels([low, card(undefined, { id: "above", held: "dock", rank: 1 })], view);
    expect((stacked.get("above") as Placed).y + 260).toBe((stacked.get("low") as Placed).y - GAP);
  });

  it("holds a panel in front of you clear of someone's face where it can be", () => {
    const face = { left: 560, right: 640, top: 380, bottom: 470 };
    const at = layoutPanels([card(undefined, { held: "front", size: [380, 200] })], view, [face]).get("card") as Placed;
    expect(at.side).toBe("front");
    expect(meet(boxOf(at, [380, 200]), face)).toBe(false);
    // Still across the middle: higher up, rather than off to one side.
    expect(at.x + 190).toBeCloseTo((view.left + view.right) / 2, 0);
  });

  it("docks an optional panel at the side when every place beside its agent is taken", () => {
    // A list held in front of you, over the agent: your conversation has nowhere beside it but over the list.
    const list = card(undefined, { id: "list", rank: 2, held: "front", size: [500, 500] });
    const talk = card(body(600, 200), { id: "talk", rank: 1, optional: true, size: [320, 160] });
    const laid = layoutPanels([list, talk], view);
    const docked = laid.get("talk") as Placed;
    expect(docked.side).toBe("dock");
    expect([docked.x + 320, docked.y + 160]).toEqual([view.right, view.bottom]);
    expect(meet(boxOf(docked, [320, 160]), boxOf(laid.get("list") as Placed, [500, 500]))).toBe(false);
  });

  it("keeps a panel moved aside there until its place beside its agent is clear by a margin", () => {
    // A board whose card sits just past where your conversation would go beside its agent: clear, but only just.
    const board = { left: 640, right: 680, top: 100, bottom: 160 };
    const panels = (was?: Placed["side"]) => [
      card({ box: board, keep: board }, { id: "card", rank: 2, prefer: "right" }),
      card(body(300, 200), { id: "talk", rank: 1, optional: true, size: [320, 160], ...(was ? { was } : {}) }),
    ];
    expect(layoutPanels(panels(), view).get("talk")?.side).toBe("right");
    expect(layoutPanels(panels("dock"), view).get("talk")?.side).toBe("dock");
    expect(layoutPanels(panels("right"), view).get("talk")?.side).toBe("right");
  });

  it("puts an optional panel away rather than lay it over another", () => {
    const map = card(undefined, { id: "map", held: "front", size: [1100, 600], rank: 2 });
    const talk = card(body(500, 200), { id: "talk", rank: 1, optional: true });
    expect(layoutPanels([map, talk], view).get("talk")?.side).toBe("away");
    // With room for it, it goes beside its agent as usual.
    expect(layoutPanels([talk], view).get("talk")?.side).toBe("right");
  });

  it("on a narrow stage, shows the highest ranked as a sheet over the foot and puts the rest away", () => {
    const laid = layoutPanels(
      [card(body(100, 100), { id: "talk", rank: 1 }), card(undefined, { id: "card", rank: 2, held: "front" })],
      view,
      [],
      SHEET_BELOW - 1,
    );
    expect(laid.get("card")?.side).toBe("sheet");
    expect(laid.get("talk")?.side).toBe("away");
  });
});

describe("a panel following what it is beside", () => {
  const at = (x: number, y: number, side: Placed["side"] = "right"): Placed => ({ x, y, side, tail: 40 });

  it("is there at once the first time, on another side, or a long way off", () => {
    expect(follow(undefined, at(100, 100), 0.016)).toEqual(at(100, 100));
    expect(follow(at(100, 100), at(300, 100, "left"), 0.016)).toEqual(at(300, 100, "left"));
    expect(follow(at(100, 100), at(100 + JUMP_PX + 1, 100), 0.016)).toEqual(at(100 + JUMP_PX + 1, 100));
  });

  it("eases the rest of the way, so a breathing body doesn't shake it, and settles rather than creeping", () => {
    const next = follow(at(100, 100), at(140, 120), 0.016);
    expect(next.x).toBeGreaterThan(100);
    expect(next.x).toBeLessThan(140);
    expect(next.y).toBeGreaterThan(100);
    expect(next.y).toBeLessThan(120);
    expect(follow(at(100, 100), at(100.3, 99.8), 0.016)).toEqual(at(100.3, 99.8));
  });
});

describe("walking away from what a panel is about", () => {
  it("puts it away once you are further off than the room and further than you stood", () => {
    expect(walkedAway(1.5, AWAY_AT - 0.1, 3)).toBe(false);
    expect(walkedAway(1.5, AWAY_AT + 0.1, 3)).toBe(true);
    // Opened from across a big room: you can go a little further still.
    expect(walkedAway(4, 4 + AWAY_MORE - 0.1, 3)).toBe(false);
    expect(walkedAway(4, 4 + AWAY_MORE + 0.1, 3)).toBe(true);
  });

  it("leaves it open when the agent walks off and you stay: its card goes with it", () => {
    expect(walkedAway(1.5, 8, 0)).toBe(false);
  });
});

describe("what each panel is beside", () => {
  const where = (more: Partial<Where> = {}): Where => ({
    here: new Set(["planner"]),
    things: [
      { id: "kiosk-room", kind: "kiosk", action: "new-room" },
      { id: "board", kind: "board", action: "tasks" },
      { id: "kiosk-task", kind: "kiosk", action: "new-task" },
      { id: "board-2", kind: "board", action: "tasks" },
      { id: "screen", kind: "screen" },
      { id: "calendar", kind: "calendar" },
    ],
    plaque: true,
    ...more,
  });

  it("puts an agent's card, and what it waits on, by its body; in front of you when its body isn't here", () => {
    expect(anchorFor({ kind: "agent", agent: "planner" }, where())).toEqual({ agent: "planner" });
    expect(anchorFor({ kind: "need", agent: "planner" }, where())).toEqual({ agent: "planner" });
    expect(anchorFor({ kind: "need", agent: "writer" }, where())).toEqual({ held: "front" });
  });

  it("keeps a task beside the board it was opened from, or the first board here, or in front of you", () => {
    expect(anchorFor({ kind: "task", at: "board-2" }, where())).toEqual({ thing: "board-2" });
    expect(anchorFor({ kind: "tasks", at: "board-2" }, where())).toEqual({ thing: "board-2" });
    expect(anchorFor({ kind: "tasks" }, where())).toEqual({ thing: "board" });
    // Opened from a board in the place before: the board here instead.
    expect(anchorFor({ kind: "task", at: "gone" }, where())).toEqual({ thing: "board" });
    expect(anchorFor({ kind: "task" }, where({ things: [] }))).toEqual({ held: "front" });
  });

  it("makes a task by the kiosk that makes them, a room by its kiosk, and reads a screen or a calendar by it", () => {
    expect(anchorFor({ kind: "new-task" }, where())).toEqual({ thing: "kiosk-task" });
    expect(anchorFor({ kind: "new-task" }, where({ things: [{ id: "b", kind: "board" }] }))).toEqual({ thing: "b" });
    expect(anchorFor({ kind: "new-room" }, where())).toEqual({ thing: "kiosk-room" });
    expect(anchorFor({ kind: "dashboard" }, where())).toEqual({ thing: "screen" });
    expect(anchorFor({ kind: "calendar" }, where())).toEqual({ thing: "calendar" });
  });

  it("puts the room's card on its plaque, the map and the list of what waits on you in front of you, the catalogue at the side", () => {
    expect(anchorFor({ kind: "place" }, where())).toEqual({ plaque: true });
    expect(anchorFor({ kind: "place" }, where({ plaque: false }))).toEqual({ held: "front" });
    expect(anchorFor({ kind: "map" }, where())).toEqual({ held: "front" });
    expect(anchorFor({ kind: "needs" }, where())).toEqual({ held: "front" });
    expect(anchorFor({ kind: "catalogue" }, where())).toEqual({ held: "dock" });
  });

  it("keeps your conversation beside the agent when it is here, in your hand as a phone when you visit somewhere it isn't", () => {
    expect(talkAnchor("planner", where(), true)).toEqual({ agent: "planner" });
    expect(talkAnchor("writer", where(), true)).toEqual({ you: true });
    expect(talkAnchor("writer", where(), false)).toEqual({ held: "dock" });
  });
});

describe("where the room's plaque hangs", () => {
  const door = (wall: RoomDoor["wall"], along: number): RoomDoor => ({
    wall,
    along,
    to: "town",
    label: "Out to the town",
    kind: "town",
  });
  const room = (doors: RoomDoor[], props: Prop[] = []) => ({ width: 6, depth: 5, props, doors });
  const thing = (id: string, at: [number, number], kind: Prop["kind"] = "bookshelf"): Prop => ({
    id,
    name: id,
    kind,
    at,
    facing: 0,
  });

  it("hangs on the wall beside a door in a wall, facing into the room", () => {
    const at = plaqueSpot(room([door("back", 0)]));
    expect(at).toEqual({ door: door("back", 0), at: [PLAQUE.beside, -2.5], facing: 0 });
    const left = plaqueSpot(room([door("left", 0.5)]));
    expect(left?.at).toEqual([-3, 0.5 + PLAQUE.beside]);
    expect(left?.facing).toBe(90);
  });

  it("goes on the door's other side when something stands against the wall on this one, or the corner is too near", () => {
    expect(plaqueSpot(room([door("back", 0)], [thing("shelf", [1, -2.3])]))?.at).toEqual([-PLAQUE.beside, -2.5]);
    expect(plaqueSpot(room([door("back", 2.2)]))?.at).toEqual([2.2 - PLAQUE.beside, -2.5]);
    // A rug on the floor there is no matter.
    expect(plaqueSpot(room([door("back", 0)], [thing("rug", [1, -2.3], "rug")]))?.at).toEqual([PLAQUE.beside, -2.5]);
  });

  it("keeps clear of another door, and hangs nowhere when every door is at an open side or has no room beside it", () => {
    expect(plaqueSpot(room([door("back", 0), door("back", 1.4)]))?.at).toEqual([-PLAQUE.beside, -2.5]);
    expect(plaqueSpot(room([door("front", 0), door("right", 1)]))).toBeUndefined();
    expect(plaqueSpot(room([door("back", 0)], [thing("a", [1, -2.3]), thing("b", [-1, -2.3])]))).toBeUndefined();
    expect(plaqueSpot(room([]))).toBeUndefined();
  });
});
