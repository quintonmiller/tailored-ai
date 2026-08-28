/**
 * One drawn vocabulary, shared by every panel that has to name a thing.
 *
 * The page's failure mode was never that it showed too little — it was that a
 * dropped sword, a potion, a burning status and a flooded room all arrived as
 * the same grey line of text, so a viewer had to *read* to find out which kind
 * of thing had just happened. Reading is exactly what a broadcast cannot ask
 * for: at streaming bitrate, three metres away, the only things that survive
 * are silhouette and position.
 *
 * So category is carried by **shape first and colour second**. Six silhouettes
 * that cannot be confused with each other at eleven pixels — a figure, a horned
 * head, a chest, a flask, an arch, a ring — and a colour token behind each one
 * that only has to distinguish, not to identify. A stream that crushes the
 * palette still leaves the shapes intact, and a viewer with no colour vision
 * loses nothing.
 *
 * Everything here is either a pure table or a builder that only touches the DOM
 * when it is called, so the Node tests can import the classifiers without a
 * document existing.
 */

import type { ClassId, SceneItem, SceneStatus } from "./types.js";

// ---------------------------------------------------------------------------
// The drawn shapes
// ---------------------------------------------------------------------------

/*
 * Stroked paths on a 24×24 grid, in `currentColor`.
 *
 * Not emoji, and the reason is worth keeping written down: an emoji is a font
 * lookup, so the three machines this page gets watched on would render three
 * different sets at three different weights, one of them as a full-colour
 * picture dropped into a monochrome instrument. These inherit the colour of
 * whatever row they sit in and re-encode cleanly.
 *
 * Each shape is kept to two or three subpaths. Anything more disappears at the
 * size these are actually drawn — eleven to sixteen pixels — and a detail that
 * only resolves on a developer's monitor is a detail that is not doing any
 * work.
 */
const MARK_PATHS = {
  /* --- the six categories ------------------------------------------------ */
  /** A person: head over shoulders. The only rounded-top silhouette here. */
  character: "M12 4.3a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2M5.6 20v-2.3c0-3 2.9-5 6.4-5s6.4 2 6.4 5V20",
  /** Something that wants you dead: horns, and a jaw that is wider than a head. */
  enemy: "M4.4 10.6a7.6 7.6 0 0 1 15.2 0c0 3.2-2 5.4-4 6.2V20H8.4v-3.2c-2-.8-4-3-4-6.2zM4.6 6.2L7.4 8M19.4 6.2L16.6 8",
  /** Treasure and equipment: a banded chest, flat-topped and heavy. */
  loot: "M3.6 9.6h16.8V19a1.2 1.2 0 0 1-1.2 1.2H4.8A1.2 1.2 0 0 1 3.6 19zM3.6 9.6l2-5.2h12.8l2 5.2M12 9.6v10.6",
  /** Something you drink once: a flask, narrow neck over a fat body. */
  consumable: "M9.8 3.4h4.4M10.6 3.4v6L6.5 17a2 2 0 0 0 1.8 3h7.4a2 2 0 0 0 1.8-3l-4.1-7.6v-6M7.6 15.2h8.8",
  /** The room itself: an arch. Architecture, so it cannot be read as a creature. */
  feature: "M4 20v-8.4a8 8 0 0 1 16 0V20M3 20h18M8.6 20v-8a3.4 3.4 0 0 1 6.8 0v8",
  /** An effect on somebody: concentric arcs around a core. Nothing else here is circular. */
  effect: "M12 10.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2M8.6 8.6a4.8 4.8 0 0 0 0 6.8M15.4 15.4a4.8 4.8 0 0 0 0-6.8M5.8 5.8a8.8 8.8 0 0 0 0 12.4M18.2 18.2a8.8 8.8 0 0 0 0-12.4",

  /* --- equipment slots ---------------------------------------------------- */
  /* Upright, not diagonal: a blade drawn corner-to-corner reads as an arrow at
     ten pixels, which is the size this is actually used at. */
  weapon: "M12 2.6l2.6 4.8v6H9.4v-6zM7.6 13.4h8.8M12 13.4v6M10.2 19.4h3.6",
  armor: "M12 3.2l7 3v5.9c0 3.9-2.9 6.8-7 8.7-4.1-1.9-7-4.8-7-8.7V6.2z",
  trinket: "M12 3.4l3.6 4.2-3.6 12.8L8.4 7.6zM8.4 7.6h7.2",
  pack: "M8 8.2V6.6a4 4 0 0 1 8 0v1.6M5.2 8.2h13.6l.9 11.1a1 1 0 0 1-1 1.1H5.3a1 1 0 0 1-1-1.1z",

  /* --- statuses ----------------------------------------------------------- */
  burn: "M12 3.4c3.2 4.2 5 6.2 5 9a5 5 0 0 1-10 0c0-2.8 1.8-4.8 5-9zM12 12.6c1.3 1.7 2 2.5 2 3.6a2 2 0 0 1-4 0c0-1.1.7-1.9 2-3.6z",
  poison: "M12 3.4l5.2 7.6a5.8 5.8 0 1 1-10.4 0zM10.4 13.6h.01M13.6 13.6h.01",
  freeze: "M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9",
  sleep: "M7.6 6.4h5.6l-5.6 5.6h5.6M15 14.4h4.4l-4.4 4.4h4.4",
  stun: "M5 12a7 7 0 0 1 11.8-5.1M19 12a7 7 0 0 1-11.8 5.1M17.2 3.6v3.6h-3.6M6.8 20.4v-3.6h3.6",
  shield: "M12 3.2l7 3v5.9c0 3.9-2.9 6.8-7 8.7-4.1-1.9-7-4.8-7-8.7V6.2z",
  taunt: "M4 9.4h4l5-4v13.2l-5-4H4zM16.6 9a4 4 0 0 1 0 6M19.2 6.8a7.4 7.4 0 0 1 0 10.4",
  mark: "M12 3.4v3.8M12 16.8v3.8M3.4 12h3.8M16.8 12h3.8M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2",
  weaken: "M12 3.6v12.8M7.4 11.8L12 16.4l4.6-4.6M5 20.2h14",
  regen: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8.2v7.6M8.2 12h7.6",
  antiheal: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M8.2 12h7.6M5.6 18.4L18.4 5.6",
  guard: "M12 3.2l7 3v5.9c0 3.9-2.9 6.8-7 8.7-4.1-1.9-7-4.8-7-8.7V6.2zM8.6 11.8h6.8",
  cooldown: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 7.6v4.9l3.4 2",
  talent: "M12 3.4l2.3 5.1 5.6.6-4.2 3.8 1.2 5.5L12 15.6l-4.9 2.8 1.2-5.5L4.1 9.1l5.6-.6z",
  // A thought bubble: the private half of a batched turn, and the only glyph on
  // the page for something nobody inside the run can see.
  think:
    "M8.2 6.2a3.9 3.9 0 0 1 7.2-1.3 3.3 3.3 0 0 1 4.2 4.5 3.1 3.1 0 0 1-2.1 5.4H8.6a4 4 0 0 1-.4-8zM7.4 17.6h.01M4.8 20.6h.01",

  /* --- events ------------------------------------------------------------- */
  move: "M3.4 20V4.6l8-2v19zM9.2 12h.01M14 12h6.6M17.8 8.8l3.2 3.2-3.2 3.2",
  descend: "M20 4.6h-4.6v4.8h-4.6v4.8H6.2v4.8M3.6 20.2h16.8",
  retreat: "M20.4 4v16M16.6 12H3.8M8.6 7.2L3.8 12l4.8 4.8",
  opportunity: "M6.2 3.8L14 18.6M10.6 2.9L18.4 17.7M2.6 8.4L10 21M3.4 18.6c4.6-1 9.6-2 14.4-2.4",
  give: "M3.4 12h9.8M9.6 8.4L13.2 12l-3.6 3.6M16.4 5.4h4.2v13.2h-4.2",
  equip: "M12 3.2l7 3v5.9c0 3.9-2.9 6.8-7 8.7-4.1-1.9-7-4.8-7-8.7V6.2zM8.8 11.8l2.2 2.2 4.2-4.4",
  levelup: "M5.4 12.6L12 6l6.6 6.6M5.4 18.2L12 11.6l6.6 6.6",
  nodamage: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M6.4 6.4l11.2 11.2",
  trade: "M4 8.4h13.4M14.2 5.2l3.2 3.2-3.2 3.2M20 15.6H6.6M9.8 12.4l-3.2 3.2 3.2 3.2",
  scout: "M2.6 12S6.4 6.4 12 6.4 21.4 12 21.4 12 17.6 17.6 12 17.6 2.6 12 2.6 12zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2",
  speak: "M4.4 5.4h15.2v10.2H10l-4.4 3.6v-3.6H4.4z",
  strike: "M5 19l9-9M13 5h6v6M4 15l5 5",
  heal: "M12 5.4v13.2M5.4 12h13.2",

  /* --- readied actions, grouped by what the action is rather than by class -- */
  ranged: "M4 20L19 5M19 5h-6M19 5v6",
  spell: "M12 3v5M12 16v5M3 12h5M16 12h5M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3",
  utility: "M2.6 12S6.4 6.4 12 6.4 21.4 12 21.4 12 17.6 17.6 12 17.6 2.6 12 2.6 12zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2",
  item: "M9.8 3.4h4.4M10.6 3.4v6L6.5 17a2 2 0 0 0 1.8 3h7.4a2 2 0 0 0 1.8-3l-4.1-7.6v-6",
  down: "M6 6l12 12M18 6L6 18",

  /* --- what is through a door, on the map and in the list of ways on ------- */
  unknown: "M6 21V11a6 6 0 0 1 12 0v10M12 21v-6",
  empty: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 11.8h.01",
  entrance: "M4 20v-8.4a8 8 0 0 1 16 0V20M3 20h18M8.6 20v-8a3.4 3.4 0 0 1 6.8 0v8",
  combat: "M4.6 4.6l10 10M19.4 4.6l-10 10M4.6 19.4l3.6-3.6M19.4 19.4l-3.6-3.6",
  elite: "M6 11a6 6 0 1 1 12 0v3l-2 2v4H8v-4l-2-2zM9.5 11h.01M14.5 11h.01",
  boss: "M4 20l2.5-9L12 15l5.5-4 2.5 9z",
  market: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v8M9.5 10.5h5M9.5 13.5h5",
  coin: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v8M9.5 10.5h5M9.5 13.5h5",
  cache: "M8 8.2V6.6a4 4 0 0 1 8 0v1.6M5.2 8.2h13.6l.9 11.1a1 1 0 0 1-1 1.1H5.3a1 1 0 0 1-1-1.1z",
  shrine: "M12 3c3.2 4.2 5 6.2 5 9a5 5 0 0 1-10 0c0-2.8 1.8-4.8 5-9z",
  stairs: "M20 4.6h-4.6v4.8h-4.6v4.8H6.2v4.8M3.6 20.2h16.8",
} as const;

/** The name of one drawn shape. Every icon on this page is one of these. */
export type MarkName = keyof typeof MARK_PATHS;

/** Whether a string from the simulation names a shape somebody drew. */
export function isMark(name: string): name is MarkName {
  return Object.hasOwn(MARK_PATHS, name);
}

/** The path data for a shape, or the slashed circle for one nobody drew. */
export function markPath(name: string): string {
  return isMark(name) ? MARK_PATHS[name] : MARK_PATHS.nodamage;
}

// ---------------------------------------------------------------------------
// The six categories
// ---------------------------------------------------------------------------

/**
 * The kinds of thing a viewer must never confuse for one another.
 *
 * Six is the whole list, and it is closed on purpose: the moment a seventh
 * appears the shapes stop being distinguishable at broadcast size, and a
 * category that cannot be told apart from its neighbour is worse than no
 * category at all.
 */
export type Category = "character" | "enemy" | "loot" | "consumable" | "feature" | "effect";

/** What each category is called when it is spelled out, and how it is tinted. */
export const CATEGORY: Record<Category, { label: string; colour: string }> = {
  character: { label: "character", colour: "var(--cat-character)" },
  enemy: { label: "enemy", colour: "var(--cat-enemy)" },
  loot: { label: "gear", colour: "var(--cat-loot)" },
  consumable: { label: "consumable", colour: "var(--cat-consumable)" },
  feature: { label: "room", colour: "var(--cat-feature)" },
  effect: { label: "effect", colour: "var(--cat-effect)" },
};

/**
 * Which category an item belongs to.
 *
 * `SceneItem.kind` is one of weapon/armor/trinket/consumable, so the split is
 * the simulation's own rather than a guess: a thing you wear is gear and a
 * thing you drink is a consumable, and the two get different silhouettes
 * because "the cleric handed over a potion" and "the cleric handed over a
 * sword" are different events for anybody watching.
 */
export function itemCategory(item: { kind?: string } | null | undefined): Category {
  return String(item?.kind ?? "") === "consumable" ? "consumable" : "loot";
}

/** The slot mark for a worn item, falling back to the generic chest. */
export function slotMark(slot: string | null | undefined): MarkName {
  const key = String(slot ?? "").toLowerCase();
  if (key === "weapon" || key === "armor" || key === "trinket" || key === "pack") return key;
  return "loot";
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * Four letters is what fits under a health bar, and a status a viewer cannot
 * name is worse than no chip at all. Kinds come from `sim/descent/model.ts`;
 * anything unlisted falls back to its own first four letters, so a status added
 * to the simulation shows up as itself rather than vanishing.
 */
const STATUS_SHORT: Record<string, string> = {
  burn: "BURN",
  poison: "POIS",
  freeze: "FRZE",
  sleep: "SLEP",
  stun: "STUN",
  shield: "SHLD",
  taunt: "TAUNT",
  mark: "MARK",
  weaken: "WEAK",
  regen: "REGN",
  antiheal: "NOHL",
  guard: "GARD",
};

/**
 * Which statuses are good news *on a party member*.
 *
 * Read from the party's side rather than in the abstract, because the same kind
 * means opposite things depending on who carries it: `taunt` on the guardian is
 * the guardian doing its job, and `mark` on an ally is the tollHeal mechanic
 * having fired and about to hurt.
 */
const BOONS = new Set(["shield", "regen", "guard", "taunt"]);

/** Good news or bad news, from the carrier's point of view. */
export function statusTone(kind: string): "boon" | "bane" {
  return BOONS.has(String(kind)) ? "boon" : "bane";
}

/** `freeze` → `FRZE`. Four letters, or the first four of whatever this is. */
export function statusShort(kind: string): string {
  const key = String(kind ?? "");
  return STATUS_SHORT[key] ?? key.slice(0, 4).toUpperCase();
}

/** The drawn shape for a status, or the generic effect ring. */
export function statusMark(kind: string): MarkName {
  const key = String(kind ?? "");
  return isMark(key) ? key : "effect";
}

/** `burn 3` — what a status chip says when there is room for words. */
export function statusTitle(status: SceneStatus | null | undefined): string {
  if (!status) return "";
  const rounds = Number(status.ticks) || 0;
  const amount = Number(status.amount) || 0;
  const parts = [String(status.kind ?? "")];
  if (rounds > 0) parts.push(`${rounds} round${rounds === 1 ? "" : "s"} left`);
  if (amount > 0) parts.push(`${amount}`);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Item wording
// ---------------------------------------------------------------------------

/** `Ashen Blade · rare · +6 power`, for a tooltip that has room for all of it. */
export function itemTitle(item: SceneItem | null | undefined): string {
  if (!item) return "";
  const lines = [`${item.name}${item.rarity ? ` · ${item.rarity}` : ""}`];
  if (item.description) lines.push(item.description);
  for (const affix of item.affixes ?? []) {
    lines.push(`${affix.polarity === "negative" ? "−" : "+"} ${affix.description}`);
  }
  const source = item.provenance?.source;
  if (source) lines.push(`Found: ${source}${item.provenance?.floor ? `, floor ${item.provenance.floor}` : ""}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Building one
// ---------------------------------------------------------------------------

/**
 * A stroked 24×24 icon, cloned from a template.
 *
 * The party strip alone asks for about thirty of these per render, and a
 * template clone is one parse for the whole run instead of one per icon.
 */
const templates = new Map<string, SVGSVGElement>();

export function mark(name: string, className?: string): SVGSVGElement {
  let template = templates.get(name);
  if (!template) {
    template = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    template.setAttribute("viewBox", "0 0 24 24");
    template.setAttribute("fill", "none");
    template.setAttribute("stroke", "currentColor");
    template.setAttribute("stroke-width", "1.7");
    template.setAttribute("stroke-linecap", "round");
    template.setAttribute("stroke-linejoin", "round");
    template.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", markPath(name));
    template.appendChild(path);
    templates.set(name, template);
  }
  const node = template.cloneNode(true) as SVGSVGElement;
  if (className) node.setAttribute("class", className);
  return node;
}

/** Swap the shape inside a mounted icon, so nothing is created or discarded. */
export function remark(svg: SVGSVGElement, name: string): void {
  const d = markPath(name);
  const path = svg.firstChild;
  if (path instanceof Element && path.getAttribute("d") !== d) path.setAttribute("d", d);
}

// ---------------------------------------------------------------------------
// The party's own colours
// ---------------------------------------------------------------------------

const CLASSES: readonly ClassId[] = ["guardian", "mage", "rogue", "cleric", "ranger"];

/** Is this arbitrary word one of the five? Keeps a stranger out of their colours. */
export function isClassId(name: unknown): name is ClassId {
  return CLASSES.includes(String(name ?? "") as ClassId);
}
