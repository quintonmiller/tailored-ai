/**
 * Who is thinking together: several agents thinking at once round a meeting
 * table, or side by side, show one shared cue over them rather than a sign
 * each, which in a crowded room is a wall of thought clouds over everyone's
 * names. Pure, so it is tested without a GPU; the stage draws the cue.
 */

/**
 * Bodies this near each other on the floor, in metres, are together: across
 * a meeting table, or every other seat round one, or side by side.
 */
export const TOGETHER = 3;
/** How many thinking together share one cue: fewer each keep their own sign, which reads well enough. */
export const SHARED_THINKING = 3;

/** A body as this needs it: who, where it stands on the floor, and whether it is thinking now. */
export interface Thinker {
  id: string;
  at: [number, number];
  thinking: boolean;
}

/**
 * The groups thinking together: the bodies thinking now, each within `reach`
 * of another in its group, so a table of them is one group however long the
 * table is, in groups of at least `least`. Each group's ids in order, and the
 * groups in the order of their first; the rest think alone.
 */
export function thinkingTogether(bodies: Thinker[], reach = TOGETHER, least = SHARED_THINKING): string[][] {
  const thinking = bodies.filter((b) => b.thinking).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const group = thinking.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < thinking.length; i++)
    for (let j = i + 1; j < thinking.length; j++) {
      const [a, b] = [thinking[i].at, thinking[j].at];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= reach) group[root(i)] = root(j);
    }
  const byRoot = new Map<number, string[]>();
  for (const [i, b] of thinking.entries()) byRoot.set(root(i), [...(byRoot.get(root(i)) ?? []), b.id]);
  return [...byRoot.values()].filter((ids) => ids.length >= least);
}

/** What a shared cue says under its thought cloud: how many are thinking there. */
export function thinkingWords(count: number): string {
  return `${count} thinking`;
}
