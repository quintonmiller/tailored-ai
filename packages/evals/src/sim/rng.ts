/**
 * A seeded generator, because a benchmark you cannot re-run is an anecdote.
 *
 * Every stochastic thing in a simulation — demand noise, machine failure,
 * supplier reliability, lead times — draws from here. Two runs with the same
 * seed and the same decisions produce the same world, which is what makes a
 * comparison between two frameworks a comparison rather than a coincidence.
 *
 * `Math.random()` is deliberately not used anywhere under `sim/`. It would make
 * the headline number un-reproducible, and worse, un-*attributable*: a
 * framework that scored higher might simply have been handed a kinder factory.
 *
 * mulberry32 rather than anything grander. 32 bits of state, a well-known
 * implementation, and a period far longer than any run needs. The requirement
 * here is reproducibility and independence between streams, not cryptography.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** Approximately normal, mean 0 stdev 1 — the sum of twelve uniforms, minus six. */
  normal(): number;
  /** An independent stream, derived from this one's seed and a label. */
  fork(label: string): Rng;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so a label maps to a stable 32-bit offset without a dependency. */
function hash(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    normal: () => {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += next();
      return sum - 6;
    },
    // Named streams, so adding a draw in one subsystem does not shift every
    // other subsystem's numbers. Without this, inserting one `chance()` in the
    // maintenance model changes the weather for the rest of the run and every
    // stored baseline becomes incomparable — which turns "this policy improved"
    // into an artefact of where the call was added.
    fork: (label) => makeRng((seed ^ hash(label)) >>> 0),
  };
}
