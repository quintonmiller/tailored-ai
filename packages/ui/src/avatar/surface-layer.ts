/**
 * Where surfaces live (`surfaces.ts`): real HTML laid on planes in the room,
 * under the picture rather than over it. Each live surface's plane is drawn
 * into the picture as a hole, clear pixels where it is, so the HTML beneath
 * shows through, and anything nearer the camera (a body, a chair) still
 * draws over it. The browser lays the HTML where its plane is with a 3D
 * transform every frame (three.js's `CSS3DRenderer`), so its words are the
 * browser's own text, crisp near and far, and its buttons, scrolling and
 * keys are the browser's own too.
 *
 * Only surfaces big enough on the stage to read are live. The rest, and all
 * of them in a photo, show the picture drawn of them into the room (a board
 * drawn on a canvas), which costs nothing to keep. A surface the stage is
 * told about outlives a change to the room it is in only while its id is
 * given again; the stage takes the rest down with the room.
 */
import type { ReactNode } from "react";
import * as THREE from "three";
import { CSS3DObject, CSS3DRenderer } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import type { ComponentSpec } from "../lib/content.js";
import type { Prop } from "./scene";
import {
  type Detail,
  detailFor,
  type Liveness,
  liveSurfaces,
  onScreenPx,
  type Placed,
  type Seen,
  SURFACE_PX,
  surfacePixels,
  surfacePoint,
} from "./surfaces";

/** How a surface is used: once brought up to read (a board, a screen), or there and then (a kiosk's button). */
export type SurfaceUse = "focus" | "direct";

/** A surface for the stage to lay in the room. */
export interface SurfaceSpec {
  /** Stays the same while it is the same surface: a room changing round it keeps it, and what it shows, as it was. */
  id: string;
  /** What it lies on: it covers this object's own flat face (its x–y plane, centred, facing +z). */
  anchor: THREE.Object3D;
  /** How big it is in metres, in the anchor's own units: an anchor made bigger shows it bigger. */
  size: [number, number];
  /** Kept live while it is near enough to read (the default), or always. */
  live?: Liveness;
  /** Brought up to read before it is used (the default), or used there and then. */
  use?: SurfaceUse;
  /** What a screen reader calls it. */
  label: string;
  /** What it shows. A prop's face leaves it out: the page draws that by the prop's kind. */
  render?: () => ReactNode;
  /** The prop whose face it is. */
  prop?: Prop;
  /** An agent interface it shows: a face on a model an agent made (`models.ts`). */
  component?: ComponentSpec;
  /**
   * The mesh it covers, which shows a picture of it while it isn't live (a
   * board drawn on a canvas). Without one, it gets a plane of its own, there
   * only while it is live.
   */
  face?: THREE.Mesh;
}

/** A live surface, as the page draws it. */
export interface SurfaceView {
  id: string;
  /** The element to draw into. */
  el: HTMLElement;
  /** Its size in CSS pixels: what its HTML is laid out in. */
  px: [number, number];
  label: string;
  use: SurfaceUse;
  /** Brought up close to be read and used. */
  focused: boolean;
  render?: () => ReactNode;
  prop?: Prop;
  component?: ComponentSpec;
}

interface Surface {
  spec: SurfaceSpec;
  /** Which laying of it this is: a remover given out for an earlier one leaves a later one alone. */
  laid: object;
  el: HTMLDivElement;
  object: CSS3DObject;
  /** What is drawn into the picture where it is: its face, or a plane of its own. */
  mesh: THREE.Mesh;
  /** What that mesh is drawn in while the surface isn't live; none for a plane of its own, which is hidden then. */
  own?: THREE.Material | THREE.Material[];
  px: [number, number];
  /** The page has drawn into it: the hole goes in only then, so it is never seen empty. */
  ready: boolean;
  detail?: Detail;
  /** Its middle, the way it faces, and how tall it is in the room, as of the last frame. */
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** Left over from the room before: taken away unless the room built now gives its id again. */
  stale?: boolean;
}

/** Milliseconds between looks at which surfaces should be live: often enough to keep up with walking. */
const LOOK_EVERY_MS = 150;

const ORIGIN = new THREE.Vector3();

/** Whether something is drawn: it and everything it is in are visible. */
function shown(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
const scratch = new THREE.Vector3();
/**
 * The browser's 3D is laid out in pixels, the room in metres. Laid out in
 * metres, everything sits a hair's breadth from the browser's eye, where its
 * sums for which element is under the pointer come apart: so the layer's
 * copy of the room is scaled up to pixels, the camera's place with it, which
 * looks just the same, and a surface's element is then its own size.
 */
const UP_TO_PX = new THREE.Matrix4().makeScale(SURFACE_PX, SURFACE_PX, SURFACE_PX);
const DOWN_TO_M = new THREE.Matrix4().makeScale(1 / SURFACE_PX, 1 / SURFACE_PX, 1 / SURFACE_PX);

export class SurfaceLayer {
  /** The layer's element: under the picture, over the page. */
  readonly dom: HTMLElement;
  private readonly css = new CSS3DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly all = new Map<string, Surface>();
  private readonly byMesh = new Map<THREE.Object3D, Surface>();
  private live = new Set<string>();
  private readonly listeners = new Set<(views: SurfaceView[]) => void>();
  private focusedId: string | undefined;
  private hovered: string | undefined;
  private lookedAt = Number.NEGATIVE_INFINITY;
  private readonly frustum = new THREE.Frustum();
  /** The camera, in the layer's pixel-sized copy of the room. */
  private readonly eye = new THREE.PerspectiveCamera();
  private readonly viewProjection = new THREE.Matrix4();
  /**
   * What a live surface's plane is drawn in: clear, so the HTML under the
   * picture shows, writing its depth like anything solid, so what is nearer
   * draws over it.
   */
  private readonly hole = new THREE.MeshBasicMaterial({
    color: 0x000000,
    opacity: 0,
    blending: THREE.NoBlending,
    toneMapped: false,
  });

  /** `lively`: whether any surface may go live at all; none does in a photo. */
  constructor(private readonly lively = true) {
    // Marked, so fading what a surface hangs on leaves its hole alone (`fade.ts`): a live surface isn't faded.
    this.hole.userData.hole = true;
    this.dom = this.css.domElement;
    this.dom.className = "world-surfaces";
    this.scene.matrixWorldAutoUpdate = false;
  }

  /** The surface being read close up, if any. */
  get focused(): string | undefined {
    return this.focusedId;
  }

  /**
   * Lay a surface in the room, or lay it again: a surface already there
   * under the same id keeps its element, and so what the page drew in it.
   * Returns which laying this is, for `remove` to take away only this one.
   */
  add(spec: SurfaceSpec): object {
    const px = surfacePixels(spec.size);
    const laid = {};
    let s = this.all.get(spec.id);
    if (s) {
      this.unhook(s);
      s.spec = spec;
      s.px = px;
      s.stale = false;
      s.laid = laid;
    } else {
      const el = document.createElement("div");
      el.className = "world-surface";
      el.dataset.surface = spec.id;
      const object = new CSS3DObject(el);
      object.matrixAutoUpdate = false;
      object.visible = false;
      this.scene.add(object);
      s = {
        spec,
        laid,
        el,
        object,
        mesh: spec.face ?? new THREE.Mesh(),
        px,
        ready: false,
        center: new THREE.Vector3(),
        normal: new THREE.Vector3(0, 0, 1),
      };
      this.all.set(spec.id, s);
    }
    s.el.style.width = `${px[0]}px`;
    s.el.style.height = `${px[1]}px`;
    s.el.setAttribute("aria-label", spec.label);
    s.el.dataset.use = spec.use ?? "focus";
    if (spec.face) {
      s.mesh = spec.face;
      s.own = spec.face.material;
    } else {
      // A plane of its own, the surface's size, hidden until it is live.
      s.mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.size[0], spec.size[1]), this.hole);
      s.mesh.visible = false;
      s.own = undefined;
      spec.anchor.add(s.mesh);
    }
    s.mesh.userData.surface = spec.id;
    this.byMesh.set(s.mesh, s);
    // Live already (a room rebuilt round it): its new face is a hole at once, as the old one was, and the page
    // draws it again for what may have changed on it (a board given a new heading).
    if (this.live.has(spec.id)) {
      if (s.ready) this.open(s);
      this.tell();
    }
    this.lookedAt = Number.NEGATIVE_INFINITY;
    return laid;
  }

  /** Take a surface away; given which laying of it, only while that is still the one there. */
  remove(id: string, laid?: object): void {
    const s = this.all.get(id);
    if (!s || (laid && s.laid !== laid)) return;
    this.unhook(s);
    this.scene.remove(s.object);
    s.el.remove();
    this.all.delete(id);
    if (this.focusedId === id) this.focusedId = undefined;
    if (this.live.delete(id)) this.tell();
  }

  /** Mark every surface laid with a room's things as left over: those the next room doesn't lay again go (`sweep`). */
  markStale(which: (spec: SurfaceSpec) => boolean): void {
    for (const s of this.all.values()) if (which(s.spec)) s.stale = true;
  }

  /**
   * Put every face back in its own picture before the room it is in is taken
   * down, so the picture is freed with the room and the hole is kept for the
   * next. Faces laid again in the room built next are holes again at once.
   */
  release(): void {
    for (const s of this.all.values()) if (s.own && s.mesh.material === this.hole) s.mesh.material = s.own;
  }

  /** Take away the surfaces left over from the room before. */
  sweep(): void {
    for (const [id, s] of [...this.all]) if (s.stale) this.remove(id);
  }

  /** The surface whose plane this is, if it is one. */
  surfaceAt(object: THREE.Object3D | undefined): string | undefined {
    for (let o = object; o; o = o.parent ?? undefined) {
      const s = this.byMesh.get(o);
      if (s) return s.spec.id;
    }
    return undefined;
  }

  /** Whether a surface takes the pointer now: it is live, and used there and then, or brought up to be used. */
  interactive(id: string | undefined): boolean {
    const s = id ? this.all.get(id) : undefined;
    return !!s && this.live.has(s.spec.id) && s.ready && (s.spec.use === "direct" || this.focusedId === id);
  }

  /** Whether any live surface is used there and then: only then does the pointer need looking at for one. */
  anyDirect(): boolean {
    for (const id of this.live) if (this.all.get(id)?.spec.use === "direct") return true;
    return false;
  }

  /** A surface's element, by id. */
  elementOf(id: string): HTMLElement | undefined {
    return this.all.get(id)?.el;
  }

  /** What a surface is called, as a screen reader says it: "the task board". */
  labelOf(id: string): string | undefined {
    return this.all.get(id)?.spec.label;
  }

  /** How a surface is used, and whether there is one by that id. */
  howUsed(id: string): SurfaceUse | undefined {
    const s = this.all.get(id);
    return s ? (s.spec.use ?? "focus") : undefined;
  }

  /** The surface the pointer is on, which says what a click on it does; or none. */
  hover(id: string | undefined): void {
    if (id === this.hovered) return;
    const was = this.hovered ? this.all.get(this.hovered) : undefined;
    if (was) delete was.el.dataset.hover;
    this.hovered = id;
    const now = id ? this.all.get(id) : undefined;
    if (now) now.el.dataset.hover = "true";
  }

  /** Bring a surface up to be read, or none. */
  focus(id: string | undefined): void {
    if (id !== undefined && !this.all.has(id)) id = undefined;
    if (id === this.focusedId) return;
    const was = this.focusedId;
    this.focusedId = id;
    for (const i of [was, id]) {
      const s = i ? this.all.get(i) : undefined;
      if (s) s.el.dataset.focused = i === id ? "true" : "";
    }
    this.lookedAt = Number.NEGATIVE_INFINITY;
    this.tell();
  }

  /** Where a surface is now, for the camera to frame it: its middle, the way it faces, and its size in the room. */
  placeOf(id: string): { center: THREE.Vector3; normal: THREE.Vector3; size: [number, number] } | undefined {
    const s = this.all.get(id);
    if (!s) return undefined;
    const m = s.spec.anchor.matrixWorld;
    s.spec.anchor.updateWorldMatrix(true, false);
    const sx = scratch.setFromMatrixColumn(m, 0).length();
    const sy = scratch.setFromMatrixColumn(m, 1).length();
    return {
      center: ORIGIN.clone().applyMatrix4(m),
      normal: new THREE.Vector3().setFromMatrixColumn(m, 2).normalize(),
      size: [s.spec.size[0] * sx, s.spec.size[1] * sy],
    };
  }

  /** Every surface's middle and the way it faces, as of the last frame: for which one you face. */
  placed(): Placed[] {
    return [...this.all.values()].map((s) => ({
      id: s.spec.id,
      center: s.center.toArray() as Placed["center"],
      normal: s.normal.toArray() as Placed["normal"],
    }));
  }

  /** The page drew into a live surface: its plane becomes a hole in the picture, showing it. */
  ready(id: string): void {
    const s = this.all.get(id);
    if (!s || s.ready) return;
    s.ready = true;
    if (this.live.has(id)) this.open(s);
  }

  /** Where a line of sight meets a surface, in the surface's own pixels from its top left; none if it misses. */
  pointOn(id: string, ray: THREE.Ray): [number, number] | undefined {
    const s = this.all.get(id);
    if (!s) return undefined;
    const m = s.spec.anchor.matrixWorld;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      new THREE.Vector3().setFromMatrixColumn(m, 2).normalize(),
      ORIGIN.clone().applyMatrix4(m),
    );
    const hit = ray.intersectPlane(plane, new THREE.Vector3());
    if (!hit) return undefined;
    const local = s.spec.anchor.worldToLocal(hit);
    return surfacePoint([local.x / s.spec.size[0] + 0.5, local.y / s.spec.size[1] + 0.5], s.px);
  }

  /** Hear which surfaces are live, each time that changes. */
  subscribe(listener: (views: SurfaceView[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.views());
    return () => this.listeners.delete(listener);
  }

  /** The live surfaces, as the page draws them. */
  views(): SurfaceView[] {
    return [...this.live].flatMap((id) => {
      const s = this.all.get(id);
      if (!s) return [];
      const { spec } = s;
      return [
        {
          id,
          el: s.el,
          px: s.px,
          label: spec.label,
          use: spec.use ?? "focus",
          focused: this.focusedId === id,
          ...(spec.render ? { render: spec.render } : {}),
          ...(spec.prop ? { prop: spec.prop } : {}),
          ...(spec.component ? { component: spec.component } : {}),
        },
      ];
    });
  }

  setSize(width: number, height: number): void {
    this.css.setSize(width, height);
  }

  /**
   * Each frame: where every surface is, and, a few times a second, which are
   * live and in how much detail; then the HTML is laid where the planes are.
   * `faded` says whether what a surface hangs on is faded for a body to be
   * seen past it.
   */
  update(camera: THREE.PerspectiveCamera, stageH: number, faded: (anchor: THREE.Object3D) => boolean, now: number) {
    if (!this.all.size) return;
    for (const s of this.all.values()) {
      const m = s.spec.anchor.matrixWorld;
      s.center.copy(ORIGIN).applyMatrix4(m);
      s.normal.setFromMatrixColumn(m, 2).normalize();
      s.object.matrixWorld.multiplyMatrices(UP_TO_PX, m).multiply(DOWN_TO_M);
    }
    if (now - this.lookedAt >= LOOK_EVERY_MS) {
      this.lookedAt = now;
      this.look(camera, stageH, faded);
    }
    this.eye.copy(camera);
    this.eye.position.multiplyScalar(SURFACE_PX);
    this.eye.updateMatrixWorld(true);
    this.css.render(this.scene, this.eye);
  }

  /** Which surfaces should be live, from how big each shows and whether it can be seen; and how much each shows. */
  private look(camera: THREE.PerspectiveCamera, stageH: number, faded: (anchor: THREE.Object3D) => boolean) {
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProjection);
    const seen: Seen[] = [];
    const tall = new Map<string, number>();
    for (const s of this.all.values()) {
      const m = s.spec.anchor.matrixWorld;
      const sx = scratch.setFromMatrixColumn(m, 0).length() * s.spec.size[0];
      const sy = scratch.setFromMatrixColumn(m, 1).length() * s.spec.size[1];
      const depth = -scratch.copy(s.center).applyMatrix4(camera.matrixWorldInverse).z;
      const px = onScreenPx(sy, depth, camera.fov, stageH);
      tall.set(s.spec.id, px);
      const facing = scratch.copy(camera.position).sub(s.center).dot(s.normal) > 0;
      seen.push({
        id: s.spec.id,
        px,
        facing,
        // Put out of sight with what it is on (a stand in the way of another surface being read) is out of view.
        inView:
          shown(s.spec.anchor) && this.frustum.intersectsSphere(new THREE.Sphere(s.center, Math.hypot(sx, sy) / 2)),
        faded: faded(s.spec.anchor),
        ...(s.spec.live ? { live: s.spec.live } : {}),
        focused: this.focusedId === s.spec.id,
      });
    }
    const next = this.lively ? liveSurfaces(seen, this.live) : new Set<string>();
    let changed = next.size !== this.live.size;
    for (const id of this.live)
      if (!next.has(id)) {
        changed = true;
        const s = this.all.get(id);
        if (s) this.close(s);
      }
    for (const id of next)
      if (!this.live.has(id)) {
        changed = true;
        const s = this.all.get(id);
        if (!s) continue;
        s.object.visible = true;
        if (s.ready) this.open(s);
      }
    this.live = next;
    for (const id of next) {
      const s = this.all.get(id);
      if (!s) continue;
      const detail = this.focusedId === id ? "near" : detailFor(tall.get(id) ?? 0, s.detail);
      if (detail !== s.detail) {
        s.detail = detail;
        s.el.dataset.detail = detail;
      }
    }
    if (changed) this.tell();
  }

  /** Show the HTML through the picture: the plane becomes a hole. */
  private open(s: Surface) {
    // Brought up while what it hangs on is faded, it wears a see-through copy (`fade.ts`), which is let go here:
    // the fading leaves a hole alone, and the face goes back to its own picture, not the copy, when it closes.
    const was = s.mesh.material;
    if (was !== this.hole && was !== s.own)
      for (const m of [was].flat()) if (m.userData.opacity !== undefined) m.dispose();
    s.mesh.material = this.hole;
    s.mesh.visible = true;
  }

  /** Back to the picture of it, and the HTML put away. */
  private close(s: Surface) {
    // Only from the hole: anything else on it is the room's own doing (a see-through copy while its wall fades).
    if (s.own && s.mesh.material === this.hole) s.mesh.material = s.own;
    else if (!s.own) s.mesh.visible = false;
    s.object.visible = false;
    s.ready = false;
    s.detail = undefined;
    delete s.el.dataset.detail;
  }

  /**
   * Let go of a surface's plane: a face goes back to its own picture, and
   * stays where it is, as part of the thing it is on; a plane of its own goes.
   */
  private unhook(s: Surface) {
    this.byMesh.delete(s.mesh);
    if (s.own) {
      if (s.mesh.material === this.hole) s.mesh.material = s.own;
    } else {
      s.mesh.removeFromParent();
      s.mesh.geometry.dispose();
    }
  }

  private tell() {
    const views = this.views();
    for (const l of this.listeners) l(views);
  }

  dispose(): void {
    for (const id of [...this.all.keys()]) this.remove(id);
    this.listeners.clear();
    this.hole.dispose();
    this.dom.remove();
  }
}
