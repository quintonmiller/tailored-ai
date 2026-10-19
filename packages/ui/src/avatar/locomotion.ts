/**
 * Getting the avatar around the room: the way from one spot to another,
 * walking it, and deciding when to go anywhere at all. Pure (time in,
 * position out) so it is tested without a GPU; the stage only moves the
 * model to where this says.
 */
import { type Room, spotById } from "./scene";

/** Where the avatar is on the floor and which way it faces (radians, 0 toward the viewer). */
export interface Place {
  x: number;
  z: number;
  facing: number;
}

/**
 * The way from one spot to another, as floor points. The starting spot is
 * also the hub: every spot has a clear straight line to it, so a walk is at
 * most two legs and never cuts through the furniture.
 */
export function route(room: Room, from: string | undefined, to: string): [number, number][] {
  const target = spotById(room, to);
  if (!target || from === to) return [];
  const hub = spotById(room, room.start);
  if (!hub || from === hub.id || to === hub.id) return [target.at];
  return [hub.at, target.at];
}

/** Somewhere the avatar can't walk: a piece of furniture's outline on the floor, as a box. */
export interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Room left round someone standing when others walk past them, in metres: about a step, so nobody brushes them. */
export const PASSING_ROOM = 0.25;

/** Someone standing at `at`, with a body `radius` across, as something to walk round with room to pass. */
export function standingIn([x, z]: readonly [number, number], radius: number): Obstacle {
  const r = radius + PASSING_ROOM;
  return { minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
}

/** The floor grid the way is searched on, in metres. */
const CELL = 0.1;

/**
 * The way from where it stands to a point, around the furniture, for a room
 * the agent furnished itself, where the middle is no longer a hub with a
 * clear line to every spot. The floor is searched as a grid, each obstacle
 * grown by the body's radius, and the way found is pulled straight wherever
 * it is clear, so the avatar walks a few legs rather than a staircase.
 * Straight there when nothing is in the way, or when there is no way round.
 */
export function findPath(
  room: Room,
  from: [number, number],
  to: [number, number],
  obstacles: Obstacle[],
  radius = 0.2,
): [number, number][] {
  const inside = (p: [number, number], o: Obstacle) => p[0] > o.minX && p[0] < o.maxX && p[1] > o.minZ && p[1] < o.maxZ;
  // Each obstacle grown by the body's radius, except one it starts or ends inside: a spot can be
  // close to its furniture, so that one keeps its true size and only its body is off limits.
  const boxes = obstacles.map((o) => {
    const g = { minX: o.minX - radius, maxX: o.maxX + radius, minZ: o.minZ - radius, maxZ: o.maxZ + radius };
    return inside(from, g) || inside(to, g) ? o : g;
  });
  const free = (p: [number, number]) =>
    Math.abs(p[0]) <= room.width / 2 - radius / 2 &&
    Math.abs(p[1]) <= room.depth / 2 - radius / 2 &&
    !boxes.some((o) => inside(p, o));
  /** Whether a straight leg misses every box: exact, so it never clips a corner between samples. */
  const clear = (a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    return !boxes.some((o) => {
      let t0 = 0;
      let t1 = 1;
      for (const [p, q] of [
        [-dx, a[0] - o.minX],
        [dx, o.maxX - a[0]],
        [-dz, a[1] - o.minZ],
        [dz, o.maxZ - a[1]],
      ]) {
        if (p === 0) {
          if (q <= 0) return false;
          continue;
        }
        const r = q / p;
        if (p < 0) {
          if (r > t1) return false;
          t0 = Math.max(t0, r);
        } else {
          if (r < t0) return false;
          t1 = Math.min(t1, r);
        }
      }
      return t1 - t0 > 1e-9;
    });
  };
  if (clear(from, to)) return [to];

  const cols = Math.max(1, Math.ceil(room.width / CELL));
  const rows = Math.max(1, Math.ceil(room.depth / CELL));
  const centre = (i: number, j: number): [number, number] => [
    -room.width / 2 + (i + 0.5) * CELL,
    -room.depth / 2 + (j + 0.5) * CELL,
  ];
  const cellOf = ([x, z]: [number, number]): [number, number] => [
    Math.min(cols - 1, Math.max(0, Math.floor((x + room.width / 2) / CELL))),
    Math.min(rows - 1, Math.max(0, Math.floor((z + room.depth / 2) / CELL))),
  ];
  const open = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) open[j * cols + i] = free(centre(i, j)) ? 1 : 0;
  const [si, sj] = cellOf(from);
  const [gi, gj] = cellOf(to);
  open[sj * cols + si] = 1;
  open[gj * cols + gi] = 1;

  // A* with the octile distance; diagonals never cut a blocked corner.
  const cost = new Float64Array(cols * rows).fill(Number.POSITIVE_INFINITY);
  const came = new Int32Array(cols * rows).fill(-1);
  const h = (i: number, j: number) => {
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const heap: [number, number][] = [];
  const push = (f: number, n: number) => {
    heap.push([f, n]);
    for (let c = heap.length - 1; c > 0; ) {
      const parent = (c - 1) >> 1;
      if (heap[parent][0] <= heap[c][0]) break;
      [heap[parent], heap[c]] = [heap[c], heap[parent]];
      c = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop() as [number, number];
    if (heap.length) {
      heap[0] = last;
      for (let c = 0; ; ) {
        const l = 2 * c + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  const start = sj * cols + si;
  const goal = gj * cols + gi;
  cost[start] = 0;
  push(h(si, sj), start);
  while (heap.length) {
    const [, n] = pop();
    if (n === goal) break;
    const i = n % cols;
    const j = (n - i) / cols;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= cols || nj >= rows || !open[nj * cols + ni]) continue;
        if (di && dj && (!open[j * cols + ni] || !open[nj * cols + i])) continue;
        const next = nj * cols + ni;
        const c = cost[n] + (di && dj ? Math.SQRT2 : 1);
        if (c < cost[next]) {
          cost[next] = c;
          came[next] = n;
          push(c + h(ni, nj), next);
        }
      }
    }
  }
  if (came[goal] === -1) return [to];

  const cells: [number, number][] = [];
  for (let n = goal; n !== -1 && n !== start; n = came[n]) cells.push(centre(n % cols, Math.floor(n / cols)));
  cells.reverse();
  cells[cells.length - 1] = to;
  // Pull it straight: from each point, on to the farthest one in plain sight.
  const way: [number, number][] = [];
  let here = from;
  for (let k = 0; k < cells.length; ) {
    let far = k;
    for (let m = cells.length - 1; m > k; m--) {
      if (clear(here, cells[m])) {
        far = m;
        break;
      }
    }
    way.push(cells[far]);
    here = cells[far];
    k = far + 1;
  }
  return way;
}

/** Radians per second it turns. */
const TURN_SPEED = 4;
/** It turns toward where it is going before it starts walking, within this much. */
const FACE_FIRST = 0.6;

/** The shortest signed turn from `from` to `to`, in [-π, π]. */
export function turnBetween(from: number, to: number): number {
  const d = (to - from) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d;
}

export class Walker {
  readonly place: Place;
  /** Radians a second it turns: a visitor's body turns quicker, to keep up with a brisker walk. */
  turnSpeed = TURN_SPEED;
  private legs: [number, number][] = [];
  private finalFacing: number | undefined;

  /**
   * `speed` in metres per second: a small figure walks slower than a tall
   * one. Changed once a walk clip loads, to the pace it was made for.
   */
  constructor(
    start: Place,
    public speed: number,
  ) {
    this.place = { ...start };
  }

  /** Walk through `points`, then turn to `facing`. Replaces any walk under way. */
  go(points: [number, number][], facing: number) {
    this.legs = points.map((p) => [...p] as [number, number]);
    this.finalFacing = facing;
  }

  /** Be somewhere at once, facing this way, with nothing left to walk: coming in through a door. */
  jump(at: [number, number], facing: number) {
    this.legs = [];
    this.finalFacing = undefined;
    [this.place.x, this.place.z] = at;
    this.place.facing = facing;
  }

  /** The points it has still to walk through, the last where it is going. */
  get way(): readonly (readonly [number, number])[] {
    return this.legs;
  }

  /** Walk on through `points` instead of the rest of the way it had, still turning as it meant to at the end. */
  reroute(points: [number, number][]) {
    this.legs = points.map((p) => [...p] as [number, number]);
  }

  /** Still walking or turning. */
  get busy(): boolean {
    return this.legs.length > 0 || this.finalFacing !== undefined;
  }

  /** Advance `dt` seconds. Returns how far it walked, which drives the stride. */
  step(dt: number): number {
    const p = this.place;
    const turn = (to: number) => {
      const d = turnBetween(p.facing, to);
      p.facing += Math.max(-this.turnSpeed * dt, Math.min(this.turnSpeed * dt, d));
      return d;
    };
    const next = this.legs[0];
    if (next) {
      const dx = next[0] - p.x;
      const dz = next[1] - p.z;
      const distance = Math.hypot(dx, dz);
      if (distance < 1e-3) {
        [p.x, p.z] = next;
        this.legs.shift();
        return 0;
      }
      if (Math.abs(turn(Math.atan2(dx, dz))) > FACE_FIRST) return 0;
      const d = Math.min(distance, this.speed * dt);
      if (d >= distance) {
        // Land exactly on the point, so walks don't drift over a long session.
        [p.x, p.z] = next;
        this.legs.shift();
      } else {
        p.x += (dx / distance) * d;
        p.z += (dz / distance) * d;
      }
      return d;
    }
    if (this.finalFacing !== undefined && Math.abs(turn(this.finalFacing)) < 0.01) {
      p.facing = this.finalFacing;
      this.finalFacing = undefined;
    }
    return 0;
  }
}

/**
 * Whether the rest of a walk, from `from` through `way`, passes within
 * `clearance` of `at`: someone standing in the way. Not when the walk ends
 * that near them, since no way round gets it there.
 */
export function inTheWay(
  from: readonly [number, number],
  way: readonly (readonly [number, number])[],
  at: readonly [number, number],
  clearance: number,
): boolean {
  const end = way.at(-1);
  if (!end || Math.hypot(end[0] - at[0], end[1] - at[1]) < clearance) return false;
  let a = from;
  for (const b of way) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const long = dx * dx + dz * dz;
    // The nearest point of this leg to them.
    const k = long ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / long)) : 0;
    if (Math.hypot(a[0] + k * dx - at[0], a[1] + k * dz - at[1]) < clearance) return true;
    a = b;
  }
  return false;
}

/** Seconds it stays at a spot before wandering on: [shortest, longest]. Longer once it has sat down. */
const STAY: Record<"stand" | "sit", [number, number]> = { stand: [18, 40], sit: [40, 80] };
/** When the agent chooses for itself: seconds between asks. Each ask is a model call. */
const BETWEEN_ASKS: [number, number] = [120, 240];

/** Time to ask the agent what it does next, instead of picking at random. */
export const ASK = { ask: true } as const;

/** Where to go next, picked by the stage, and how long to stay once there: [shortest, longest] seconds. */
export interface Pick {
  spot: string;
  stay?: [number, number];
}

/**
 * When to go somewhere, and where. While nobody is talking to it, the avatar
 * wanders: it stays a while at a spot, then moves on, to whatever `pick`
 * chooses (something to do, in `idle.ts`) or a spot at random without one.
 * With `agentChooses`, it asks the agent instead, less often, and the agent's
 * cues say where it goes, or that it stays. When a conversation starts, it
 * comes back to the middle to face you, and stays there until the
 * conversation ends.
 */
export class Director {
  private leaveAt: number | undefined;
  private wasEngaged = false;
  /** The last pick, so its stay is kept once it gets there. */
  private planned: Pick | undefined;

  constructor(
    private room: Room,
    private readonly random: () => number = Math.random,
    private readonly agentChooses = false,
    private readonly pick?: (here: string, taken?: ReadonlySet<string>) => Pick | undefined,
  ) {}

  /** The room changed: its spots are what it picks from now. */
  setRoom(room: Room) {
    this.room = room;
    this.leaveAt = undefined;
  }

  /**
   * Called every frame. `here` is the spot it is standing at (undefined while
   * walking), `engaged` whether someone is talking to it, `taken` the spots
   * others in the room are at, which it won't wander to. Returns a spot to
   * walk to now, if any.
   */
  decide(
    t: number,
    here: string | undefined,
    engaged: boolean,
    taken?: ReadonlySet<string>,
  ): string | typeof ASK | undefined {
    const startedTalking = engaged && !this.wasEngaged;
    this.wasEngaged = engaged;
    if (engaged) {
      this.leaveAt = undefined;
      return startedTalking && here !== this.room.start ? this.room.start : undefined;
    }
    if (here === undefined) return undefined;
    if (this.leaveAt === undefined) {
      const planned = this.planned?.spot === here ? this.planned.stay : undefined;
      const [lo, hi] = this.agentChooses
        ? BETWEEN_ASKS
        : (planned ?? STAY[spotById(this.room, here)?.activity === "sit" ? "sit" : "stand"]);
      this.leaveAt = t + lo + this.random() * (hi - lo);
      return undefined;
    }
    if (t < this.leaveAt) return undefined;
    this.leaveAt = undefined;
    if (this.agentChooses) return ASK;
    const picked = this.pick?.(here, taken);
    this.planned = picked;
    if (picked) return picked.spot;
    const elsewhere = this.room.spots.filter((s) => s.id !== here && !taken?.has(s.id));
    return elsewhere[Math.floor(this.random() * elsewhere.length)]?.id;
  }

  /** Someone sent it somewhere: the stay starts over once it gets there. */
  sent() {
    this.leaveAt = undefined;
  }
}

/**
 * One step of walking under your own control: as far as `delta` goes without
 * leaving the floor or walking into furniture, sliding along whatever is in
 * the way rather than stopping dead. A body already inside something (sat
 * down in a seat, say) may walk out of it.
 */
export function slide(
  room: { width: number; depth: number },
  from: [number, number],
  delta: [number, number],
  obstacles: Obstacle[],
  radius: number,
): [number, number] {
  const hx = room.width / 2 - radius;
  const hz = room.depth / 2 - radius;
  const clamp = ([x, z]: [number, number]): [number, number] => [
    Math.max(-hx, Math.min(hx, x)),
    Math.max(-hz, Math.min(hz, z)),
  ];
  const inside = ([x, z]: [number, number]) =>
    obstacles.some((o) => x > o.minX - radius && x < o.maxX + radius && z > o.minZ - radius && z < o.maxZ + radius);
  const stuck = inside(from);
  const tries: [number, number][] = [
    [from[0] + delta[0], from[1] + delta[1]],
    [from[0] + delta[0], from[1]],
    [from[0], from[1] + delta[1]],
  ];
  for (const t of tries) {
    const to = clamp(t);
    if (stuck || !inside(to)) return to;
  }
  return from;
}
