/**
 * What is made once for the page and drawn by every stage: as a stage goes,
 * each renderer that drew it must be let go of, or every stage taken down
 * stays in memory for as long as the page is open.
 */
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { buildPiece, wearColors } from "./dress";
import { releaseShared, share } from "./shared";
import { bubbleTail } from "./signs";
import type { Piece } from "./wear";

// No drawing here: a sign's canvas stays blank, which is all these need.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

/**
 * A renderer as far as these things know one: what it keeps for each, and the
 * listener it hangs on each it draws, which lets go of itself once told the
 * thing is disposed, as three.js's own does.
 */
function renderer(drawn: Map<object, unknown> = new Map()) {
  const kept = new WeakMap<object, object>();
  const listeners = new Map<THREE.EventDispatcher<{ dispose: object }>, () => void>();
  return {
    properties: {
      get: (thing: object) => {
        let p = kept.get(thing);
        if (!p) kept.set(thing, (p = (drawn.get(thing) as object | undefined) ?? {}));
        return p;
      },
    } as unknown as THREE.WebGLRenderer["properties"],
    draw(thing: THREE.EventDispatcher<{ dispose: object }>) {
      const off = () => thing.removeEventListener("dispose", off);
      thing.addEventListener("dispose", off);
      listeners.set(thing, off);
    },
    holds: (thing: THREE.EventDispatcher<{ dispose: object }>) => {
      const off = listeners.get(thing);
      return !!off && thing.hasEventListener("dispose", off);
    },
  };
}

describe("releaseShared", () => {
  it("has every renderer that drew something shared let go of it", () => {
    const shape = share(new THREE.BoxGeometry(1, 1, 1));
    const paint = share(new THREE.MeshStandardMaterial());
    const first = renderer();
    const second = renderer();
    for (const r of [first, second]) {
      r.draw(shape);
      r.draw(paint);
    }
    releaseShared(first, new THREE.Scene());
    for (const r of [first, second]) {
      expect(r.holds(shape)).toBe(false);
      expect(r.holds(paint)).toBe(false);
    }
  });

  it("finds three.js's table for lit materials through what was drawn, and lets it go with later stages too", () => {
    const lut = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const wall = new THREE.MeshStandardMaterial();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), wall));
    const first = renderer(new Map([[wall, { uniforms: { dfgLUT: { value: lut } } }]]));
    first.draw(lut);
    releaseShared(first, scene);
    expect(first.holds(lut)).toBe(false);
    // The next stage goes with nothing in it that says where the table is: it is let go of all the same.
    const next = renderer();
    next.draw(lut);
    releaseShared(next, new THREE.Scene());
    expect(next.holds(lut)).toBe(false);
  });
});

describe("what bodies wear", () => {
  it("is let go of as a stage goes, and is the same to wear again after", () => {
    const piece: Piece = { shape: "box", bone: "head", tone: "main", at: [0, 0, 0], size: [0.1, 0.1, 0.1] };
    const colors = wearColors(undefined);
    const worn = buildPiece(piece, colors);
    const r = renderer();
    r.draw(worn.geometry);
    r.draw(worn.material as THREE.Material);
    releaseShared(r, new THREE.Scene());
    expect(r.holds(worn.geometry)).toBe(false);
    expect(r.holds(worn.material as THREE.Material)).toBe(false);
    const again = buildPiece(piece, colors);
    expect(again.geometry).toBe(worn.geometry);
    expect(again.material).toBe(worn.material);
  });
});

describe("the square sprites are drawn on", () => {
  it("is let go of as a stage goes: three.js makes one for every sprite on the page", () => {
    const tail = bubbleTail();
    const r = renderer();
    r.draw(tail.geometry);
    releaseShared(r, new THREE.Scene());
    expect(r.holds(tail.geometry)).toBe(false);
    // And it is the one the next sprite is drawn on.
    expect(bubbleTail().geometry).toBe(tail.geometry);
  });
});
