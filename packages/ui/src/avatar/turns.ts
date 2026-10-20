/**
 * What a body says, in the order it was said: the line in its bubble now, and
 * those said after it waiting their turn. A call is the case that needs it:
 * the question and the answer come at once, the answer timed to follow, and
 * either may come first; on the phone, the other end's words come out of the
 * same body's phone between its own. Pure, so it is tested without a GPU.
 */

/** A line in its turn: shown from `from` to `until` on the stage's clock. */
export interface Turn<T> {
  what: T;
  from: number;
  until: number;
  /** How long it takes to read, when nothing said after it cuts it short. */
  long: number;
}

/** How many lines wait their turn at most: past that, the earliest go unsaid. */
const WAITING = 4;

/** Speech lines by speaker, earliest said first: the order a stage hears them in, whatever order they came in. */
export function inOrder<L extends { at: string }>(speech: Record<string, L | undefined>): [string, L][] {
  const when = (l: L) => {
    const t = Date.parse(l.at);
    return Number.isFinite(t) ? t : 0;
  };
  return Object.entries(speech)
    .filter((e): e is [string, L] => !!e[1])
    .sort((a, b) => when(a[1]) - when(b[1]));
}

/**
 * A body's lines in turn. Lines are said from now on: a line's `from` is
 * never before the stage's clock as it is added, so one said before the line
 * in the bubble is one that hasn't started yet, and goes first. Each line
 * stays up until the next one is due; a line no later than the one before it
 * takes that one's place.
 */
export class Turns<T> {
  /** The line in the bubble, or about to be. */
  now: Turn<T> | undefined;
  private waiting: Turn<T>[] = [];

  /** Add a line said from `from`, `long` seconds to read. Whether the line in the bubble is another one now. */
  add(what: T, from: number, long: number): boolean {
    const was = this.now;
    // Sorted by when each is said; one said at the same moment as another comes after it, and takes its place.
    const all = [...(was ? [was] : []), ...this.waiting, { what, from, long, until: from + long }].sort(
      (a, b) => a.from - b.from,
    );
    const kept: Turn<T>[] = [];
    for (const [i, line] of all.entries()) {
      const next = all[i + 1];
      const until = next ? Math.min(line.from + line.long, next.from) : line.from + line.long;
      if (until > line.from) kept.push({ ...line, until });
    }
    // The line in the bubble keeps its identity while it stays there, so it isn't drawn again.
    const first = kept[0];
    if (was && first && first.what === was.what && first.from === was.from) {
      was.until = first.until;
      kept[0] = was;
    }
    this.now = kept.shift();
    this.waiting = kept.slice(-WAITING);
    return this.now !== was;
  }

  /** At `clock`: a line whose time is up gives way to the next. Whether the line in the bubble is another one now. */
  tick(clock: number): boolean {
    const was = this.now;
    while (this.now && clock >= this.now.until) this.now = this.waiting.shift();
    return this.now !== was;
  }

  /** Whether the line in the bubble is being said at `clock`. */
  speaking(clock: number): boolean {
    return !!this.now && clock >= this.now.from && clock < this.now.until;
  }
}
