/**
 * Turning a floor's room graph into something that can be drawn as a floor.
 *
 * The old map took the `x`/`y` the generator had stamped on each room and drew
 * a straight line between every pair of connected centres. Both halves of that
 * are wrong, and the result was the single least legible thing on the page.
 *
 * **The coordinates are not a layout.** Generation grows the tree with
 * `x: parent.x + rng.int(-1, 1)`, `y: parent.y + 1`, so two children of the
 * entrance can be handed the same cell and land exactly on top of each other. A
 * seven-room floor could show as five.
 *
 * **Straight lines between centres are not corridors.** Loops and one-way drops
 * connect rooms that are nowhere near each other, so their lines cut diagonally
 * across the drawing, cross each other at arbitrary angles, and pass straight
 * through unrelated rooms — which reads as a corridor that goes through a wall
 * into a room it does not connect to. On a 2D plan that is not a stylisation, it
 * is a lie about the floor.
 *
 * So the layout is computed here from the graph itself and the generator's
 * coordinates are ignored entirely. Rooms go in rows by their distance from the
 * entrance, get ordered inside a row to pull connected rooms near each other,
 * and every corridor is routed orthogonally through the gutters *between* rows
 * — never across a cell that holds a room.
 *
 * Pure, no DOM, deterministic. That is what lets a Node test assert the two
 * properties that actually matter — no two rooms in one cell, no corridor
 * through a room — over hundreds of generated floors, which is not something
 * anybody can check by looking at a picture.
 */

/** The half of a room the plan needs. Structurally compatible with the scene's. */
export interface PlanInputRoom {
  id: string;
  links: string[];
  /** Used to anchor the layout at the entrance. Optional so a test can omit it. */
  kind?: string;
}

/** The half of a route the plan needs. */
export interface PlanInputRoute {
  id: string;
  from: string;
  to: string;
  kind: string;
  bidirectional: boolean;
}

export interface PlanInput {
  currentRoom: string;
  rooms: readonly PlanInputRoom[];
  routes: readonly PlanInputRoute[];
}

/** Where a room sits: an integer cell, and the centre in plan units. */
export interface PlannedRoom {
  id: string;
  row: number;
  col: number;
  x: number;
  y: number;
}

/** A corridor, as the orthogonal polyline that draws it. */
export interface PlannedRoute {
  id: string;
  from: string;
  to: string;
  kind: string;
  /** True when the route only goes `from` → `to`. Drawn with a head. */
  oneWay: boolean;
  points: Array<{ x: number; y: number }>;
}

export interface FloorPlan {
  rooms: PlannedRoom[];
  routes: PlannedRoute[];
  /** Extent in plan units, so a renderer can scale without measuring. */
  width: number;
  height: number;
  /**
   * One cell, in plan units.
   *
   * Exported so a renderer can size a room's *label* to the column it sits in
   * rather than to a guessed pixel width. A label wider than its column
   * overlaps its neighbour, and the overlap gets worse as the floor gets wider
   * — which is exactly when a viewer most needs to read the names.
   */
  cell: { w: number; h: number };
  /**
   * The narrowest horizontal gap between two room centres, in plan units.
   *
   * This is what a room's *label* has to fit inside, and it is not `cell.w`:
   * rows of different widths are centred against each other, so two rooms on
   * neighbouring rows routinely sit half a cell apart. Sizing labels to `cell.w`
   * made them four times wider than the space available and every name on a
   * four-room floor overlapped its neighbour.
   *
   * `Infinity` when there is only one column, where a label may take the lot.
   */
  minGapX: number;
}

/**
 * Which rooms are still shut, and by what.
 *
 * "Secret" and "locked" are properties of a *door*, not of a room — the
 * simulation has no secret room kind — but "can we get in there yet" is a
 * question about the room, and that is where a viewer looks for the answer. A
 * room counts as gated only when *every* known way in is still shut: one open
 * corridor and the room is simply reachable, whatever else also touches it.
 */
export function roomGates(
  plan: FloorPlan,
  opened: ReadonlySet<string>,
): Map<string, "locked" | "toll" | "secret"> {
  const doors = new Map<string, string[]>();
  for (const corridor of plan.routes) {
    const state = opened.has(corridor.id) ? "open" : corridor.kind;
    for (const end of [corridor.from, corridor.to]) {
      const list = doors.get(end) ?? [];
      list.push(state);
      doors.set(end, list);
    }
  }
  const out = new Map<string, "locked" | "toll" | "secret">();
  for (const [id, kinds] of doors) {
    if (kinds.length === 0 || kinds.some((k) => k === "open" || k === "passage" || k === "one-way")) continue;
    if (kinds.includes("locked")) out.set(id, "locked");
    else if (kinds.includes("toll")) out.set(id, "toll");
    else if (kinds.every((k) => k === "secret")) out.set(id, "secret");
  }
  return out;
}

/**
 * Plan units. A cell is 10 wide and 10 tall with a 6-unit gutter under each row,
 * which is where corridors run. Arbitrary but fixed, so a renderer scales by one
 * number and the tests can talk about distances.
 */
const CELL_W = 10;
const CELL_H = 10;
const GUTTER = 8;
const ROW_PITCH = CELL_H + GUTTER;
/** How close a corridor may pass to a room's centre before it counts as through it. */
export const ROOM_RADIUS = 3.2;

/**
 * Where the drawing is anchored, and why it is not the party.
 *
 * The layout used to root its breadth-first pass at `currentRoom`, so the depth
 * of every room — and therefore the row it sat on, and therefore the whole
 * picture — was measured from wherever the party happened to be standing. Walk
 * one room and the map rearranged itself. Combined with a room set that grew as
 * things were discovered, the result was a map that *transformed* rather than
 * filled in, and a viewer could not learn where anything was because it did not
 * stay there.
 *
 * The entrance is fixed for the life of a floor, so anchoring there makes the
 * layout a pure function of the floor. The same floor draws the same way on
 * round one and round forty; discovery changes what is *shaded*, never where
 * anything is.
 */
function anchorOf(rooms: readonly PlanInputRoom[], currentRoom: string): string | undefined {
  return rooms.find((room) => room.kind === "entrance")?.id ?? (rooms.some((r) => r.id === currentRoom) ? currentRoom : rooms[0]?.id);
}

/** Breadth-first depth from the anchor, over every corridor the floor has. */
function depths(rooms: readonly PlanInputRoom[], edges: readonly PlanInputRoute[], start: string): Map<string, number> {
  const near = new Map<string, string[]>();
  for (const room of rooms) near.set(room.id, []);
  for (const edge of edges) {
    near.get(edge.from)?.push(edge.to);
    // Followed both ways even for a one-way drop. This is a *drawing*, and a
    // room you can only fall into is still on the floor and still belongs at
    // the depth it is reached from — the arrowhead is what says you cannot
    // walk back up it.
    near.get(edge.to)?.push(edge.from);
  }
  const depth = new Map<string, number>();
  const first = rooms.some((room) => room.id === start) ? start : rooms[0]?.id;
  if (first === undefined) return depth;
  depth.set(first, 0);
  const queue = [first];
  while (queue.length > 0) {
    const here = queue.shift() as string;
    for (const next of near.get(here) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, (depth.get(here) ?? 0) + 1);
      queue.push(next);
    }
  }
  // A room no corridor reaches at all still has to be drawn, and goes on the
  // deepest row rather than nowhere.
  const deepest = Math.max(0, ...depth.values());
  for (const room of rooms) if (!depth.has(room.id)) depth.set(room.id, deepest + 1);
  return depth;
}

/**
 * Order the rooms inside each row so connected rooms sit near each other.
 *
 * Two barycentre sweeps — down, then up — which is the cheap half of the
 * standard layered-drawing method. On five to nine rooms it removes almost
 * every avoidable crossing, and unlike a full crossing-minimisation pass it
 * cannot take a visible amount of time on a poll.
 *
 * Ties break on room id so the same floor always draws the same way. A layout
 * that shuffled between polls would be unreadable however few lines crossed.
 */
function order(rows: string[][], edges: readonly PlanInputRoute[]): void {
  const near = new Map<string, string[]>();
  for (const row of rows) for (const id of row) near.set(id, []);
  for (const edge of edges) {
    near.get(edge.from)?.push(edge.to);
    near.get(edge.to)?.push(edge.from);
  }
  const columnOf = new Map<string, number>();
  const reindex = () => {
    for (const row of rows) row.forEach((id, index) => columnOf.set(id, index));
  };
  reindex();

  const sweep = (indices: number[], against: (rowIndex: number) => number) => {
    for (const rowIndex of indices) {
      const other = against(rowIndex);
      if (other < 0 || other >= rows.length) continue;
      const anchor = new Set(rows[other]);
      const weight = new Map<string, number>();
      for (const id of rows[rowIndex]) {
        const seen = (near.get(id) ?? []).filter((n) => anchor.has(n)).map((n) => columnOf.get(n) ?? 0);
        // No neighbour on the row being sorted against: keep the place it has,
        // rather than collapsing every such room onto column zero.
        weight.set(id, seen.length ? seen.reduce((a, b) => a + b, 0) / seen.length : (columnOf.get(id) ?? 0));
      }
      rows[rowIndex].sort((a, b) => (weight.get(a) ?? 0) - (weight.get(b) ?? 0) || a.localeCompare(b));
      reindex();
    }
  };

  const down = rows.map((_, i) => i).slice(1);
  const up = [...down].reverse().map((i) => i - 1).filter((i) => i >= 0);
  sweep(down, (i) => i - 1);
  sweep(up, (i) => i + 1);
  sweep(down, (i) => i - 1);
}

/** The y of a corridor lane in the gutter under `row`. */
function gutterY(row: number, lane: number, lanes: number): number {
  return row * ROW_PITCH + CELL_H + (GUTTER * (lane + 1)) / (lanes + 1);
}

/**
 * A corridor from one room to another, as an orthogonal polyline.
 *
 * The one rule the whole router is built on: **a corridor is only ever
 * horizontal inside a gutter.** A horizontal run at room level passes through
 * every room between its endpoints, which is precisely the defect this file
 * exists to remove — and it is the mistake the first draft of this function
 * made, caught by `corridorsThroughRooms` over six hundred generated floors
 * rather than by looking at a picture.
 *
 * So every corridor leaves its rooms vertically, travels in gutters, and comes
 * back down vertically. Two shapes come out of that:
 *
 * - **A hop** — same row, or one row apart. Down into the shared gutter, along
 *   it, back out. Each hop gets its own lane in that gutter, deepest for the
 *   longest, so hops nest rather than overlap.
 * - **A bracket** — two or more rows apart, which is a loop or a long one-way
 *   drop. Out past the widest row into a side channel, down it, and back in
 *   through the gutter above the far room. It visibly goes *around*, which is
 *   the honest drawing of a corridor that does not pass through the floors
 *   between.
 */
function route(
  from: PlannedRoom,
  to: PlannedRoom,
  lane: number,
  lanes: number,
  span: { left: number; right: number },
): Array<{ x: number; y: number }> {
  const rowGap = Math.abs(from.row - to.row);
  if (rowGap === 1 && from.col === to.col) return [{ x: from.x, y: from.y }, { x: to.x, y: to.y }];

  if (rowGap <= 1) {
    const shared = Math.min(from.row, to.row);
    const mid = gutterY(shared, lane, lanes);
    return [
      { x: from.x, y: from.y },
      { x: from.x, y: mid },
      { x: to.x, y: mid },
      { x: to.x, y: to.y },
    ];
  }

  const upper = from.row < to.row ? from : to;
  const lower = from.row < to.row ? to : from;
  // Whichever side the pair already sits nearer, so a loop on the left of the
  // drawing does not travel across it to reach a right-hand channel.
  const left = (from.x + to.x) / 2 <= (span.left + span.right) / 2;
  const outer = left ? span.left - GUTTER * (lane + 1) : span.right + GUTTER * (lane + 1);
  const out = gutterY(upper.row, lane, lanes);
  const back = gutterY(lower.row - 1, lane, lanes);
  const path = [
    { x: upper.x, y: upper.y },
    { x: upper.x, y: out },
    { x: outer, y: out },
    { x: outer, y: back },
    { x: lower.x, y: back },
    { x: lower.x, y: lower.y },
  ];
  // Drawn from `from` to `to`, so a one-way arrowhead points the way the party
  // can actually travel.
  return from === upper ? path : path.reverse();
}

/** Lay out one floor. Deterministic: same input, same plan. */
export function planFloor(input: PlanInput): FloorPlan {
  /*
   * Every route, not the discovered ones.
   *
   * The map draws the whole floor — the scene sends it, and the page is a pure
   * reader that never reaches an agent — so the graph the layout is computed
   * from is fixed for the floor. Laying out over the *discovered* subgraph was
   * the other half of the transforming map: finding a corridor changed the
   * graph, which changed the rows, which moved rooms that nobody had touched.
   * What is undiscovered is drawn faint by the renderer, not omitted here.
   */
  const all = input.routes;
  const depth = depths(input.rooms, all, anchorOf(input.rooms, input.currentRoom) ?? input.currentRoom);

  const rows: string[][] = [];
  for (const room of input.rooms) {
    const at = depth.get(room.id) ?? 0;
    (rows[at] ??= []).push(room.id);
  }
  for (let i = 0; i < rows.length; i++) rows[i] ??= [];
  order(rows, all);

  const widest = Math.max(1, ...rows.map((row) => row.length));
  const width = widest * CELL_W;
  const placed = new Map<string, PlannedRoom>();
  rows.forEach((row, rowIndex) => {
    /*
     * Each row is centred, so a floor that branches once and then narrows reads
     * as a shape rather than as a left-aligned list — but centred *to a whole
     * column*, which is load-bearing rather than tidy.
     *
     * A fractional indent puts rows of different parity on interleaved grids: a
     * row of two against a row of three sits half a cell across, and rooms on
     * neighbouring rows end up a quarter of a cell apart. Every room then has
     * about a quarter of a cell of horizontal space to print its name in —
     * measured at 9% of the map's width, or 28 pixels — which is why the first
     * version of the labels had to be truncated into uselessness. Rounding
     * moves a row by half a cell and gives every name a full one.
     */
    const indent = Math.round((widest - row.length) / 2);
    row.forEach((id, colIndex) => {
      const col = indent + colIndex;
      placed.set(id, {
        id,
        row: rowIndex,
        col,
        x: col * CELL_W + CELL_W / 2,
        y: rowIndex * ROW_PITCH + CELL_H / 2,
      });
    });
  });

  // Lanes are assigned per gutter, longest span first, so the corridor that
  // travels furthest sits deepest and the short ones nest above it.
  const byGutter = new Map<number, PlanInputRoute[]>();
  const brackets: PlanInputRoute[] = [];
  for (const edge of all) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) continue;
    if (Math.abs(a.row - b.row) === 1) {
      const gutter = Math.min(a.row, b.row);
      const list = byGutter.get(gutter) ?? [];
      list.push(edge);
      byGutter.set(gutter, list);
    } else {
      brackets.push(edge);
    }
  }
  const span = (edge: PlanInputRoute) => {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    return a && b ? Math.abs(a.x - b.x) : 0;
  };
  for (const list of byGutter.values()) list.sort((p, q) => span(q) - span(p) || p.id.localeCompare(q.id));
  brackets.sort((p, q) => span(q) - span(p) || p.id.localeCompare(q.id));

  const lane = new Map<string, { lane: number; lanes: number }>();
  for (const list of byGutter.values()) {
    list.forEach((edge, index) => lane.set(edge.id, { lane: index, lanes: list.length }));
  }
  brackets.forEach((edge, index) => lane.set(edge.id, { lane: index, lanes: brackets.length }));

  const routes: PlannedRoute[] = [];
  for (const edge of all) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (!a || !b) continue;
    const seat = lane.get(edge.id) ?? { lane: 0, lanes: 1 };
    routes.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      oneWay: !edge.bidirectional,
      points: route(a, b, seat.lane, seat.lanes, { left: 0, right: width }),
    });
  }

  // A side channel runs outside the rooms, so the drawing is wider than the
  // widest row. Shifted rather than clipped: a renderer that scaled to the room
  // extent alone would cut every bracket off at the edge of the box.
  const xs = [...placed.values()].map((room) => room.x).concat(routes.flatMap((r) => r.points.map((p) => p.x)));
  const left = Math.min(...xs, 0);
  const right = Math.max(...xs, width);
  if (left !== 0) {
    for (const room of placed.values()) room.x -= left;
    for (const corridor of routes) for (const point of corridor.points) point.x -= left;
  }

  return {
    rooms: [...placed.values()],
    routes,
    width: right - left,
    height: Math.max(1, rows.length) * ROW_PITCH,
    cell: { w: CELL_W, h: CELL_H },
    minGapX: narrowestGap([...placed.values()].map((room) => room.x)),
  };
}

/**
 * Does any corridor pass through a room it does not end at?
 *
 * Exported because it is the assertion, not a helper: the whole point of the
 * rewrite is that this returns empty, and a layout change that quietly stops
 * being true would otherwise only be visible to somebody looking at a
 * screenshot of the right seed.
 */
export function corridorsThroughRooms(plan: FloorPlan): string[] {
  const bad: string[] = [];
  for (const corridor of plan.routes) {
    for (const room of plan.rooms) {
      if (room.id === corridor.from || room.id === corridor.to) continue;
      for (let i = 0; i + 1 < corridor.points.length; i++) {
        if (nearSegment(room, corridor.points[i], corridor.points[i + 1]) < ROOM_RADIUS) {
          bad.push(`${corridor.id} passes through ${room.id}`);
          i = corridor.points.length;
          break;
        }
      }
    }
  }
  return bad;
}

/** Distance from a room's centre to a corridor segment. */
function nearSegment(room: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((room.x - a.x) * dx + (room.y - a.y) * dy) / len));
  return Math.hypot(room.x - (a.x + t * dx), room.y - (a.y + t * dy));
}

/** The smallest distance between two distinct values. `Infinity` for fewer than two. */
function narrowestGap(values: readonly number[]): number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, sorted[i] - sorted[i - 1]);
  return gap;
}

/**
 * Where a plan coordinate lands on the canvas, as a percentage.
 *
 * The map draws in two coordinate systems at once — HTML room nodes positioned
 * by percentage, and an SVG of corridors with a viewBox — and they have to
 * agree exactly or every corridor misses the room it connects to. They
 * disagreed once already, in a way no test could see because each system had
 * its own copy of the arithmetic. There is one copy now, and
 * {@link insetViewBox} is derived from it rather than written beside it.
 */
export function insetPercent(value: number, extent: number, pad: number, padEnd = pad): number {
  return pad + (value / Math.max(1, extent)) * (100 - pad - padEnd);
}

/**
 * The same inset, expressed as a viewBox for a full-bleed SVG.
 *
 * Padding the coordinate system rather than the element, because an `<svg>`
 * with `width: auto` and four insets does not size to its insets the way a div
 * does — it keeps 100% of its container *and* moves, which sent the corridors a
 * quarter of the way down the page.
 */
export function insetViewBox(
  plan: Pick<FloorPlan, "width" | "height">,
  padX: number,
  padTop: number,
  padBottom: number,
): { x: number; y: number; w: number; h: number } {
  const w = (plan.width * 100) / (100 - 2 * padX);
  const h = (plan.height * 100) / (100 - padTop - padBottom);
  return { x: -(padX / 100) * w, y: -(padTop / 100) * h, w, h };
}
