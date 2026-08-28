/**
 * Long text in a fixed-width slot, scrolled rather than cut.
 *
 * Some labels on this page genuinely cannot wrap. A party card's kit rail is a
 * fixed-height row of cells, a nameplate sits on one line beside a health bar,
 * and an item line has a value column to its right — give any of them a second
 * line and the card below it moves, on a page where five cards have to stay
 * aligned. So they ellipsise, and an ellipsis on "Executioner's Iron Sword of
 * the Bear" deletes the two words that say what it is.
 *
 * The resting state stays exactly as it was: one line, ellipsis, no motion. Only
 * the elements that *actually* overflow start moving, and only far enough to
 * show the rest. A page where nothing is truncated has no animation on it at
 * all, which is the property that keeps this from becoming a page of crawling
 * text.
 *
 * `text-indent` rather than a transform, because a transform needs an inner
 * element to move and every one of these sites would have to grow a wrapper
 * span. Indent shifts the first line of a single-line box, which is exactly what
 * is wanted, and it leaves the ellipsis parked at the right edge as a standing
 * reminder that there is more.
 */

/** How fast the text travels, in pixels per second. Reading pace, not a ticker. */
const SPEED = 22;

/** Below this there is nothing worth moving for, and motion would just be noise. */
const MIN_OVERFLOW = 6;

export const MARQUEE_CSS = `
.roving {
  animation: rove var(--rove-dur, 8s) ease-in-out infinite alternate;
}
@keyframes rove {
  0%, 18% { text-indent: 0; }
  82%, 100% { text-indent: var(--rove-by, 0px); }
}
@media (prefers-reduced-motion: reduce) {
  .roving { animation: none; }
}
`;

/**
 * Measure everything, then write everything.
 *
 * Two passes rather than one because reading `scrollWidth` after a style write
 * forces a synchronous layout, and this runs over every visible label on every
 * poll — interleaved, it would be one forced reflow per label rather than one
 * for the batch.
 */
export function rove(root: ParentNode, selector: string): void {
  const found = root.querySelectorAll<HTMLElement>(selector);
  const plan: Array<[HTMLElement, number]> = [];
  for (const node of found) {
    // `scrollWidth` on an ellipsised box is the untruncated width, so the
    // difference is exactly how far the text has to travel.
    const over = node.scrollWidth - node.clientWidth;
    plan.push([node, over > MIN_OVERFLOW ? over : 0]);
  }
  for (const [node, over] of plan) {
    if (over <= 0) {
      if (node.classList.contains("roving")) {
        node.classList.remove("roving");
        node.style.removeProperty("--rove-by");
        node.style.removeProperty("--rove-dur");
      }
      continue;
    }
    // Re-stamping identical values every poll would restart the animation and
    // leave the text permanently frozen at its first frame.
    const by = `-${over}px`;
    if (node.style.getPropertyValue("--rove-by") === by) continue;
    node.style.setProperty("--rove-by", by);
    // A long name takes proportionally longer, so two labels of different
    // lengths travel at the same speed rather than in the same time.
    node.style.setProperty("--rove-dur", `${Math.max(4, over / SPEED + 3).toFixed(1)}s`);
    node.classList.add("roving");
  }
}
