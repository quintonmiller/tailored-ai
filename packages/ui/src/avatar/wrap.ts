/**
 * Words wrapped into a few short lines: what a speech bubble shows of what
 * was said, and a note's title on a board. Apart from the signs that draw
 * them, so the page can use it without loading three.js.
 */

/** Lines of a bubble, and characters on each: a glimpse of what was said, not the transcript. */
export const BUBBLE_LINES = 3;
export const BUBBLE_CHARS = 30;

/** Words wrapped into at most a few short lines, the last cut short with an ellipsis when there is more. */
export function wrap(text: string, width = BUBBLE_CHARS, lines = BUBBLE_LINES): string[] {
  const out: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    if (word.length > width) word = `${word.slice(0, width - 1)}…`;
    const next = line ? `${line} ${word}` : word;
    if (next.length <= width) {
      line = next;
      continue;
    }
    out.push(line);
    line = word;
    if (out.length === lines) {
      // Out of room: the last line ends in an ellipsis.
      const last = out[lines - 1];
      out[lines - 1] = last.length >= width ? `${last.slice(0, width - 1)}…` : `${last}…`;
      return out;
    }
  }
  if (line) out.push(line);
  return out;
}
