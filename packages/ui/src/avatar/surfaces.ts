/**
 * Surfaces: real HTML laid on a plane in the room, a wall screen, a task
 * board, a calendar, a kiosk's face, later any object's face. The stage keeps
 * each one where its plane is (`surface-layer.ts`), and the page draws into
 * it with React. What can be worked out without a page is here, so it is
 * tested: how big a surface's HTML is, how tall it shows on the stage, which
 * surfaces are live, how much detail each shows, where the camera goes to
 * read one, which one you are facing, and where on one a pointer is.
 */

/** A point or a direction in the room. */
export type Vec3 = [number, number, number];

/**
 * CSS pixels a metre of a surface is laid out at. Its HTML is designed at
 * this size and scaled into the room, so a surface made bigger (a prop's
 * `scale`) shows the same page larger, not more of it.
 */
export const SURFACE_PX = 640;

/** A surface's HTML size in CSS pixels, for its size in metres. */
export function surfacePixels(size: [number, number], px = SURFACE_PX): [number, number] {
  return [Math.round(size[0] * px), Math.round(size[1] * px)];
}

/**
 * How tall something `height` metres tall shows on a stage `stageH` pixels
 * tall, `depth` metres in front of a camera with a vertical field of view of
 * `fov` degrees. Nothing at or behind the camera shows.
 */
export function onScreenPx(height: number, depth: number, fov: number, stageH: number): number {
  if (depth <= 1e-3) return 0;
  return (height / (2 * depth * Math.tan((fov * Math.PI) / 360))) * stageH;
}

/**
 * How tall on the stage a surface has to be to go live: below this, its
 * words are too small to read, and the picture of it drawn into the room
 * stands in. Once live, it stays live until it is smaller than the second,
 * so walking to and fro at the edge doesn't swap it back and forth.
 */
export const LIVE_PX = 44;
export const DEAD_PX = 30;
/** Surfaces live at once, at most: the biggest on the stage. */
export const MAX_LIVE = 8;
/**
 * How tall a live surface has to be to show everything on it, rather than
 * only what reads from across a room (`detailFor`), and how much smaller it
 * gets before it goes back.
 */
export const NEAR_PX = 230;
export const FAR_PX = 180;

/** How a surface is to be kept live: while it is near enough to read, or always. */
export type Liveness = "near" | "always";

/** A surface as this frame sees it, for deciding which are live. */
export interface Seen {
  id: string;
  /** How tall it shows on the stage, in CSS pixels; 0 behind the camera. */
  px: number;
  /** Its face is turned toward the camera. */
  facing: boolean;
  /** Some of it is in the picture. */
  inView: boolean;
  /** It, or the wall it hangs on, is faded so a body can be seen past it. */
  faded?: boolean;
  live?: Liveness;
  /** It is being read close up: live whatever else is true. */
  focused?: boolean;
}

/**
 * Which surfaces are live: the one being read, those kept live always, and
 * the biggest of the rest that face the camera, are in the picture, aren't
 * faded and show tall enough to read, up to `max` in all. `was` is the set
 * last time, for the margin a live one keeps.
 */
export function liveSurfaces(seen: Seen[], was: ReadonlySet<string>, max = MAX_LIVE): Set<string> {
  const out = new Set<string>();
  for (const s of seen) if (s.focused || s.live === "always") out.add(s.id);
  const near = seen
    .filter((s) => !out.has(s.id) && s.facing && s.inView && !s.faded && s.px >= (was.has(s.id) ? DEAD_PX : LIVE_PX))
    .sort((a, b) => b.px - a.px);
  for (const s of near) {
    if (out.size >= max) break;
    out.add(s.id);
  }
  return out;
}

/** How much a live surface shows: everything, or only what reads from across a room. */
export type Detail = "near" | "far";

/** The detail a surface `px` tall on the stage shows, given what it showed (`was`). */
export function detailFor(px: number, was: Detail | undefined): Detail {
  return px >= NEAR_PX || (was === "near" && px >= FAR_PX) ? "near" : "far";
}

/** Share of the part of the stage that can be seen left round a surface being read, on each side. */
export const FOCUS_MARGIN = 0.06;
/** The nearest the camera comes to a surface to read it, in metres: any nearer and it would be inside the wall. */
export const FOCUS_NEAREST = 0.35;

/**
 * How far in front of a surface `size` metres across the camera stands to
 * read it head-on: as near as lets all of it fit in the part of the stage
 * that can be seen (`aspect` wide for each unit tall, `tall` of the stage's
 * height), with a margin round it.
 */
export function focusDistance(
  size: [number, number],
  view: { fov: number; aspect: number; tall?: number; margin?: number },
): number {
  const margin = view.margin ?? FOCUS_MARGIN;
  const tan = Math.tan((view.fov * Math.PI) / 360) * Math.min(1, Math.max(0.2, view.tall ?? 1));
  const need = Math.max(size[1], size[0] / Math.max(0.1, view.aspect)) * (1 + 2 * margin);
  return Math.max(FOCUS_NEAREST, need / (2 * tan));
}

/** Where the camera stands and looks to read a surface: straight out from its middle, along the way it faces. */
export function focusFraming(center: Vec3, normal: Vec3, distance: number): { position: Vec3; target: Vec3 } {
  const len = Math.hypot(...normal) || 1;
  return {
    target: [...center],
    position: [
      center[0] + (normal[0] / len) * distance,
      center[1] + (normal[1] / len) * distance,
      center[2] + (normal[2] / len) * distance,
    ],
  };
}

/**
 * How far past the top of the walls (`ceiling`, metres up) the stage sees
 * while a surface is read: on a wall `distance` straight out from the
 * camera, which looks level at `level` metres up, through a stage `stageH`
 * pixels tall with a vertical field of view of `fov` degrees, whose top is
 * `above` pixels over where the camera looks (the middle of the box it reads
 * in). 0 when the wall reaches the top of the stage.
 */
export function overWalls(
  level: number,
  distance: number,
  view: { fov: number; stageH: number; above: number },
  ceiling: number,
): number {
  const perPx = (2 * distance * Math.tan((view.fov * Math.PI) / 360)) / Math.max(1, view.stageH);
  return Math.max(0, level + view.above * perPx - ceiling);
}

/**
 * Whether a body standing at `at` is in the way of reading a surface from
 * `distance` in front of it: between the camera and the surface, and no
 * further to one side of the line between them than the surface's half
 * width (`half`) and the body's own girth. Only the floor plan counts: a
 * body is as tall as anything on a wall.
 */
export function blocksView(
  at: Vec3,
  center: Vec3,
  normal: Vec3,
  half: number,
  distance: number,
  girth = 0.35,
): boolean {
  const len = Math.hypot(normal[0], normal[2]) || 1;
  const n = [normal[0] / len, normal[2] / len];
  const d = [at[0] - center[0], at[2] - center[2]];
  const ahead = d[0] * n[0] + d[1] * n[1];
  if (ahead <= 0.05 || ahead >= distance - 0.1) return false;
  const aside = Math.abs(d[0] * -n[1] + d[1] * n[0]);
  return aside <= half + girth;
}

/**
 * Whether something solid (its box, from `min` to `max`) stands in the way of
 * reading a surface from `distance` in front of it, as a body would
 * (`blocksView`), by its middle and half its width. Never the thing the
 * surface is on: a box holding the surface's middle is its own.
 */
export function solidInWay(
  solid: { min: Vec3; max: Vec3 },
  center: Vec3,
  normal: Vec3,
  half: number,
  distance: number,
): boolean {
  const { min, max } = solid;
  const holds = [0, 1, 2].every(
    (i) => (center[i] ?? 0) >= (min[i] ?? 0) - 0.05 && (center[i] ?? 0) <= (max[i] ?? 0) + 0.05,
  );
  if (holds) return false;
  const mid: Vec3 = [(min[0] + max[0]) / 2, 0, (min[2] + max[2]) / 2];
  return blocksView(mid, center, normal, half, distance, Math.max(max[0] - min[0], max[2] - min[2]) / 2);
}

/** How far behind a surface being read a body's name and words would still show over it, in metres. */
export const BEHIND_REACH = 4;

/**
 * Whether a body standing at `at` is just behind a surface being read, no
 * further to one side than its half width (`half`) and the body's girth:
 * the signs over a head (its name, what it says) are drawn over everything,
 * so they would show through the surface while it is read.
 */
export function behindView(
  at: Vec3,
  center: Vec3,
  normal: Vec3,
  half: number,
  reach = BEHIND_REACH,
  girth = 0.35,
): boolean {
  const len = Math.hypot(normal[0], normal[2]) || 1;
  const n = [normal[0] / len, normal[2] / len];
  const d = [at[0] - center[0], at[2] - center[2]];
  const ahead = d[0] * n[0] + d[1] * n[1];
  if (ahead > 0.05 || ahead < -reach) return false;
  const aside = Math.abs(d[0] * -n[1] + d[1] * n[0]);
  return aside <= half + girth;
}

/** How far you can be from a surface and still bring it up with a key, in metres. */
export const FACE_REACH = 3.2;
/** How far off where you face a surface can be, sideways, and still be the one you face: radians. */
const FACE_ANGLE = 0.9;

/** A surface, as which one you are facing needs it: its middle, and the way it faces. */
export interface Placed {
  id: string;
  center: Vec3;
  normal: Vec3;
}

/**
 * The surface you are facing, from `eye` looking along `dir`: within reach,
 * turned toward you, and near where you look, sideways (up and down don't
 * count: a body faces a wall, not a point on it). The nearest, with what is
 * off to the side counting as further.
 */
export function facingSurface(eye: Vec3, dir: Vec3, surfaces: Placed[], reach = FACE_REACH): string | undefined {
  const look = Math.atan2(dir[0], dir[2]);
  let best: { id: string; score: number } | undefined;
  for (const s of surfaces) {
    const to: Vec3 = [s.center[0] - eye[0], s.center[1] - eye[1], s.center[2] - eye[2]];
    const far = Math.hypot(to[0], to[2]);
    if (far > reach) continue;
    // Its face turned toward you: from behind, a surface is the back of a board.
    if (s.normal[0] * -to[0] + s.normal[1] * -to[1] + s.normal[2] * -to[2] <= 0) continue;
    const off =
      far < 1e-3
        ? 0
        : Math.abs(Math.atan2(Math.sin(Math.atan2(to[0], to[2]) - look), Math.cos(Math.atan2(to[0], to[2]) - look)));
    if (off > FACE_ANGLE) continue;
    const score = far * (1 + off);
    if (!best || score < best.score) best = { id: s.id, score };
  }
  return best?.id;
}

/**
 * Where on a surface `size` CSS pixels across a point is, from where on its
 * plane it is (`uv`, 0–1 from the bottom left, as a plane's texture
 * coordinates run): in the surface's own pixels, from its top left.
 */
export function surfacePoint(uv: [number, number], size: [number, number]): [number, number] {
  return [uv[0] * size[0], (1 - uv[1]) * size[1]];
}
