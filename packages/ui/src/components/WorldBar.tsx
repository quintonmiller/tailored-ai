/**
 * The tools over the 3D world on a narrow screen, in one row: the way you get
 * around, the map, the tasks, and whatever wants you now (what agents wait on
 * you for, someone to talk to beside you) as icons, a menu for the rest, and
 * where you are at the end of the row. Each icon says what it is when the
 * pointer is over it or a finger holds it down; the menu says it in words,
 * and takes you anywhere along the way to where you are.
 */
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import type { Crumb } from "../lib/wayfinding";

/** The icons the row and the menu draw, by name. Drawn in the text's colour, so a pressed or urgent one is too. */
const PATHS: Record<string, ReactNode> = {
  walk: (
    <>
      <circle cx="13" cy="4" r="2" />
      <path d="M10.5 21l1.6-6.2-2.6-2.4.9-4.2 2.4 2.3 2.7 1.1M8.2 12.4l1.3-4.2 2.9-.6M13.6 14.6l2.2 2.4.6 4" />
    </>
  ),
  fly: <path d="M3 11.5l18-7-5.5 16-3.4-6.4L3 11.5zM12.1 14.1L21 4.5" />,
  room: <path d="M4 10.5L12 4l8 6.5V20H4v-9.5zM9.5 20v-5.5h5V20" />,
  close: (
    <>
      <circle cx="12" cy="8.5" r="3.6" />
      <path d="M5 20.5c.8-4 3.6-6 7-6s6.2 2 7 6" />
    </>
  ),
  map: <path d="M9 4.5L3.5 6.6v13l5.5-2.1 6 2.1 5.5-2.1v-13L15 6.6 9 4.5zM9 4.5v13M15 6.6v13" />,
  tasks: (
    <path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20M4 6.5l1.2 1.2L7.4 5.4M4 12l1.2 1.2 2.2-2.3M4 17.5l1.2 1.2 2.2-2.3" />
  ),
  needs: <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.8 2H4.7l1.8-2zM10 20.5a2.2 2.2 0 0 0 4 0" />,
  talk: <path d="M4.5 5.5h15v10h-8.2L7 19.5v-4H4.5v-10z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  edit: <path d="M4.5 19.5l.9-4.1L15.6 5.2a2 2 0 0 1 2.9 0l.3.3a2 2 0 0 1 0 2.9L8.6 18.6l-4.1.9zM13.8 7l3.2 3.2" />,
  back: <path d="M10 6l-6 6 6 6M4.5 12H20" />,
  voices: <path d="M4.5 9.5h3.2L12 5.5v13l-4.3-4H4.5v-5zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  quiet: <path d="M4.5 9.5h3.2L12 5.5v13l-4.3-4H4.5v-5zM15.5 9.5l5 5M20.5 9.5l-5 5" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </>
  ),
};

/** One of the icons, the size of the text it sits in. */
export function WorldIcon({ name }: { name: string }) {
  return (
    <svg className="world-icon" viewBox="0 0 24 24" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** One thing the row offers. */
export interface BarItem {
  id: string;
  /** What it is called: under a finger held on it, by the pointer, to a screen reader, and in the menu. */
  label: string;
  /** More about it, by the pointer. */
  title?: string;
  icon: string;
  onClick: () => void;
  pressed?: boolean;
  expanded?: boolean;
  /**
   * How much it wants a place in the row rather than the menu: the most used,
   * and whatever wants you now. Left out, it is in the menu.
   */
  rank?: number;
  /** Words beside its icon in the row, short: whom you talk to beside you is in the row by name. */
  words?: string;
  /** How it stands out: something waiting on you, someone beside you. */
  tone?: "needs" | "near";
  /** A number on its icon: how many wait on you. */
  count?: number;
}

/** Pixels the row gives each thing in it, and between them: icons, icons with words, the menu, and where you are. */
export const BAR = { icon: 34, gap: 4, letter: 7, wordsMax: 150, here: 72, travel: 68, pad: 8 };

/** How wide a thing is in the row. */
const widthOf = (item: BarItem) =>
  item.words ? Math.min(BAR.wordsMax, BAR.icon + item.words.length * BAR.letter) : BAR.icon;

/**
 * Which things are in the row and which in the menu, for a row `width`
 * pixels wide: as many of those that want a place as fit, the keenest first,
 * in the order given; beside them the way you get around, the menu's button,
 * and room for where you are. The rest are in the menu, in the order given.
 */
export function barLayout(items: BarItem[], width: number): { row: BarItem[]; menu: BarItem[] } {
  let left = width - BAR.pad - BAR.travel - BAR.icon - BAR.here - 3 * BAR.gap;
  const keen = items.filter((i) => i.rank !== undefined).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  const inRow = new Set<string>();
  for (const item of keen) {
    const w = widthOf(item) + BAR.gap;
    if (w > left) continue;
    left -= w;
    inRow.add(item.id);
  }
  return { row: items.filter((i) => inRow.has(i.id)), menu: items.filter((i) => !inRow.has(i.id)) };
}

/** How long a finger is held on an icon before it says what it is, and how long it says it after. */
const HOLD_MS = 450;
const TIP_MS = 1400;

/**
 * An icon's words under a finger held on it: shown after a moment, and the
 * click that ends the hold doesn't count, since asking what it is isn't
 * asking for it. The pointer's hover shows them by CSS alone.
 */
function useHeldTip() {
  const [held, setHeld] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const told = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const props = (id: string) => ({
    "data-tip": held === id ? "on" : undefined,
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType === "mouse") return;
      told.current = false;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        told.current = true;
        setHeld(id);
      }, HOLD_MS);
    },
    onPointerUp: () => {
      clearTimeout(timer.current);
      if (told.current) timer.current = setTimeout(() => setHeld(null), TIP_MS);
    },
    onPointerCancel: () => {
      clearTimeout(timer.current);
      setHeld(null);
    },
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    /** Whether this click ends a hold for the words, and so isn't one. */
    asked: () => {
      const was = told.current;
      told.current = false;
      return was;
    },
  });
  return props;
}

/**
 * The row: `lead` first (the way you get around, from the stage), the things
 * that fit as icons, the menu's button, and where you are, which opens the
 * menu too. The menu has the rest in words, then each step of the way to
 * where you are, to go back up it.
 */
export function WorldBar({
  items,
  lead,
  trail,
  here,
  onStep,
  onOpen,
}: {
  items: BarItem[];
  lead?: ReactNode;
  trail: Crumb[];
  /** The place you are in, by id: its step in the trail is where you are, not somewhere to go. */
  here: string | undefined;
  onStep: (step: Crumb) => void;
  /** The menu opened or closed: on a phone, the chat steps aside for it, as for anything open over the scene. */
  onOpen?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const told = useRef(onOpen);
  told.current = onOpen;
  useEffect(() => {
    told.current?.(open);
  }, [open]);
  // Gone with the menu open (rearranging the room took the row's place, say): it is closed.
  useEffect(() => () => told.current?.(false), []);
  const box = useRef<HTMLDivElement>(null);
  const tip = useHeldTip();
  // As wide as the stage lets it be, measured: what fits in the row depends on it.
  const [width, setWidth] = useState(360);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width) || 360);
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    measure();
    return () => watch.disconnect();
  }, []);
  const { row, menu } = barLayout(items, width);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Claimed, so the page doesn't also close a panel or stop a reply with the same Escape.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away);
    box.current?.querySelector<HTMLButtonElement>(".world-more-menu button")?.focus();
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away);
    };
  }, [open]);
  const where = trail.at(-1);
  const steps = trail.filter((s) => s.id !== here || s.from);
  return (
    <div className="world-bar" ref={box}>
      {lead}
      {row.map((item) => {
        const held = tip(item.id);
        return (
          <button
            key={item.id}
            type="button"
            className={`world-bar-btn${item.words ? " with-words" : ""}${item.tone ? ` is-${item.tone}` : ""}`}
            aria-label={item.label}
            aria-pressed={item.pressed}
            aria-expanded={item.expanded}
            title={item.title ?? item.label}
            data-tip={held["data-tip"]}
            onPointerDown={held.onPointerDown}
            onPointerUp={held.onPointerUp}
            onPointerCancel={held.onPointerCancel}
            onContextMenu={held.onContextMenu}
            onClick={() => {
              if (held.asked()) return;
              setOpen(false);
              item.onClick();
            }}
          >
            <WorldIcon name={item.icon} />
            {item.count !== undefined && <span className="world-bar-count">{item.count}</span>}
            {item.words ? (
              <span className="world-bar-words" aria-hidden="true">
                {item.words}
              </span>
            ) : (
              <span className="world-bar-tip" aria-hidden="true">
                {item.label}
              </span>
            )}
          </button>
        );
      })}
      <button
        type="button"
        className="world-bar-btn"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More: this place, going back, voices"
        onClick={() => setOpen(!open)}
      >
        <WorldIcon name="more" />
      </button>
      {where && (
        <button
          type="button"
          className="world-bar-here"
          aria-haspopup="menu"
          aria-expanded={open}
          title={`You are in ${where.label}: the way here, and more`}
          onClick={() => setOpen(!open)}
        >
          {where.label}
        </button>
      )}
      {open && (
        <div className="world-more-menu" role="menu" aria-label="More">
          {menu.map((item) => {
            const run = () => {
              setOpen(false);
              item.onClick();
            };
            const inside = (
              <>
                <WorldIcon name={item.icon} />
                <span>{item.label}</span>
              </>
            );
            const tone = item.tone ? `is-${item.tone}` : undefined;
            // Something on or off (the voices) is ticked in the menu, as it is pressed in a row of buttons.
            return item.pressed === undefined ? (
              <button key={item.id} type="button" role="menuitem" className={tone} title={item.title} onClick={run}>
                {inside}
              </button>
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.pressed}
                className={tone}
                title={item.title}
                onClick={run}
              >
                {inside}
              </button>
            );
          })}
          {steps.length > 0 && (
            <nav className="world-more-trail" aria-label="Where you are">
              {trail.map((step, i) => (
                <span key={`${i}:${step.id}`} className="world-trail-step">
                  {i > 0 && (
                    <span className="world-trail-sep" aria-hidden="true">
                      ›
                    </span>
                  )}
                  {step.id === here ? (
                    <span aria-current={i === trail.length - 1 ? "location" : undefined}>{step.label}</span>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      title={`Go to ${step.label}`}
                      onClick={() => {
                        setOpen(false);
                        onStep(step);
                      }}
                    >
                      {step.label}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

/** The way you get around (or the view, in an agent's own room) as two icons, for the front of the row. */
export function BarSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: T; label: string; icon: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const tip = useHeldTip();
  return (
    <fieldset className="world-bar-switch" aria-label={label}>
      {options.map((o) => {
        const held = tip(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={value === o.id}
            aria-label={o.label}
            title={o.label}
            data-tip={held["data-tip"]}
            onPointerDown={held.onPointerDown}
            onPointerUp={held.onPointerUp}
            onPointerCancel={held.onPointerCancel}
            onContextMenu={held.onContextMenu}
            onClick={() => {
              if (held.asked()) return;
              onChange(o.id);
            }}
          >
            <WorldIcon name={o.icon} />
            <span className="world-bar-tip" aria-hidden="true">
              {o.label}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
