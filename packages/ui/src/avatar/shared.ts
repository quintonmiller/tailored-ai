import * as THREE from "three";
import { disposeTree } from "./props";

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
/** Whether the console has been told the table couldn't be found: once a page is enough. */
let warned = false;

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
  if (!lut) {
    let lit = false;
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const one of Array.isArray(m) ? m : m ? [m] : []) {
        const drawn = renderer.properties.get(one) as Drawn;
        // Only what this renderer drew has uniforms kept for it.
        if (drawn.uniforms && (one as THREE.MeshStandardMaterial).isMeshStandardMaterial) lit = true;
        const value = drawn.uniforms?.dfgLUT?.value;
        if (value instanceof THREE.Texture) lut ??= value;
      }
    });
    // A lit material was drawn with no table where three.js used to keep it: a newer three.js keeps it elsewhere, so
    // every stage taken down stays in memory again. Said where someone working on the world will see it.
    if (lit && !lut && !warned) {
      warned = true;
      console.warn("The 3D world couldn't find three.js's table for lit materials: old stages will stay in memory.");
    }
  }
  if (lut) kept.add(lut);
  for (const thing of kept) thing.dispose();
}

/**
 * Take a stage's renderer down with everything it drew, in the one order that lets the page forget it. What is kept
 * for the page goes first, while the renderer still knows what it drew: disposing the scene has it forget each
 * material, and disposing it forgets the rest, and then the table can't be found. Its drawing context goes straight
 * after, not whenever the page's garbage is next collected, since a browser keeps only a few.
 */
export function takeDown(
  renderer: Pick<THREE.WebGLRenderer, "properties" | "dispose" | "forceContextLoss" | "domElement">,
  scene: THREE.Object3D,
): void {
  releaseShared(renderer, scene);
  disposeTree(scene);
  renderer.dispose();
  renderer.forceContextLoss();
  renderer.domElement.remove();
}
