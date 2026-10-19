import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/** How much of a box things laid over it cover, in pixels: along its top, and along its bottom. */
export interface Covered {
  top: number;
  bottom: number;
}

const NONE: Covered = { top: 0, bottom: 0 };

/**
 * What covers the top and the bottom of a box: the things in it matching
 * `top` (a toolbar), and those matching `bottom` (the chat across the foot of
 * a phone, or whatever is open in its place), so the scene behind them can be
 * framed in what is left. Only what spans the box's width and can be seen
 * counts: the chat in a column down the side of a wide screen covers its side,
 * not its foot. Measured after every render, since a panel opening changes
 * what is there, and again whenever the box changes size.
 */
export function useCovered(box: RefObject<HTMLElement | null>, { top, bottom }: { top: string; bottom: string }) {
  const [covered, setCovered] = useState<Covered>(NONE);
  const measure = () => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const across = (e: Element) => {
      const b = e.getBoundingClientRect();
      return b.height > 0 && b.width >= r.width * 0.9 && getComputedStyle(e).visibility !== "hidden" ? b : undefined;
    };
    let t = 0;
    let u = 0;
    for (const e of el.querySelectorAll(top)) {
      const b = across(e);
      if (b) t = Math.max(t, b.bottom - r.top);
    }
    for (const e of el.querySelectorAll(bottom)) {
      const b = across(e);
      if (b) u = Math.max(u, r.bottom - b.top);
    }
    const next = { top: Math.round(Math.max(0, t)), bottom: Math.round(Math.max(0, u)) };
    setCovered((was) => (was.top === next.top && was.bottom === next.bottom ? was : next));
  };
  // After every render: whatever re-rendered may have opened or closed something.
  useLayoutEffect(measure);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the box is there for the page's life; its size is what changes.
  useEffect(() => {
    const el = box.current;
    // Where there is nothing to say a size changed, every render still measures.
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return covered;
}
