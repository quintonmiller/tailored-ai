import * as THREE from "three";

/**
 * What is made once for the whole page and drawn by every stage on it: the
 * shapes and paints bodies wear (`dress.ts`), the one square every sprite is
 * drawn on, and three.js's own table for lit materials. A renderer that draws
 * with something hangs a listener on it, to hear when it is disposed, and that
 * listener holds the renderer, its canvas, and through them everything the
 * stage was made of. These things last as long as the page, so without more
 * every stage taken down would too: one more each time you go from the agent's
 * own view to a visit and back. Disposing them as a stage goes
 * (`releaseShared`) has every renderer that drew them let go; a stage still
 * drawing them uploads them again on its next frame.
 */
const kept = new Set<{ dispose(): void }>();
/** Three.js's table for lit materials, once a stage going has found it: the same one for the whole page. */
let lut: THREE.Texture | undefined;

/** Keep something for the whole page, drawn by every stage: let go of with each one as it goes. */
export function share<T extends { dispose(): void }>(thing: T): T {
  kept.add(thing);
  return thing;
}

/** What a renderer keeps for a material it drew: the values of its uniforms. */
interface Drawn {
  uniforms?: { dfgLUT?: { value?: unknown } };
}

/**
 * Let go of what is kept for the whole page, as a stage goes, while its
 * renderer can still free them on the GPU: before the stage's own things are
 * disposed and its renderer is. Three.js's table isn't to be had from it, so it
 * is found through what this renderer drew.
 */
export function releaseShared(renderer: Pick<THREE.WebGLRenderer, "properties">, scene: THREE.Object3D): void {
  if (!lut)
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const one of Array.isArray(m) ? m : m ? [m] : []) {
        const value = (renderer.properties.get(one) as Drawn).uniforms?.dfgLUT?.value;
        if (value instanceof THREE.Texture) lut ??= value;
      }
    });
  if (lut) kept.add(lut);
  for (const thing of kept) thing.dispose();
}
