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

  /** Still walking or turning. */
  get busy(): boolean {
    return this.legs.length > 0 || this.finalFacing !== undefined;
  }

  /** Advance `dt` seconds. Returns how far it walked, which drives the stride. */
  step(dt: number): number {
    const p = this.place;
    const turn = (to: number) => {
      const d = turnBetween(p.facing, to);
      p.facing += Math.max(-TURN_SPEED * dt, Math.min(TURN_SPEED * dt, d));
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

/** Seconds it stays at a spot before wandering on: [shortest, longest]. Longer once it has sat down. */
const STAY: Record<"stand" | "sit", [number, number]> = { stand: [18, 40], sit: [40, 80] };

/**
 * When to go somewhere, and where. While nobody is talking to it, the avatar
 * wanders: it stays a while at a spot, then picks another. When a session
 * starts, it comes back to the middle to face you, and stays there until the
 * session ends.
 */
export class Director {
  private leaveAt: number | undefined;
  private wasEngaged = false;

  constructor(
    private readonly room: Room,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Called every frame. `here` is the spot it is standing at (undefined while
   * walking), `engaged` whether someone is talking to it. Returns a spot to
   * walk to now, if any.
   */
  decide(t: number, here: string | undefined, engaged: boolean): string | undefined {
    const startedTalking = engaged && !this.wasEngaged;
    this.wasEngaged = engaged;
    if (engaged) {
      this.leaveAt = undefined;
      return startedTalking && here !== this.room.start ? this.room.start : undefined;
    }
    if (here === undefined) return undefined;
    if (this.leaveAt === undefined) {
      const [lo, hi] = STAY[spotById(this.room, here)?.activity === "sit" ? "sit" : "stand"];
      this.leaveAt = t + lo + this.random() * (hi - lo);
      return undefined;
    }
    if (t < this.leaveAt) return undefined;
    this.leaveAt = undefined;
    const elsewhere = this.room.spots.filter((s) => s.id !== here);
    return elsewhere[Math.floor(this.random() * elsewhere.length)]?.id;
  }

  /** Someone sent it somewhere: the stay starts over once it gets there. */
  sent() {
    this.leaveAt = undefined;
  }
}
