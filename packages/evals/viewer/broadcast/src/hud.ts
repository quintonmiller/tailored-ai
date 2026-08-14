/**
 * Who the party is, where they are, and how the run is going.
 *
 * Three boxes, one module, because they are the same question asked at three
 * scales and they have to agree: the party strip is this round, the shaft is
 * this floor, the progress panel is the whole run. Splitting them across three
 * files would mean three copies of "what counts as a cleared floor", and a
 * broadcast whose panels disagree about that reads as broken even when each
 * panel is individually right.
 *
 * ## What is worth showing, and why
 *
 * The scenario's own note (`scenarios/23-the-endless-descent.ts`) says the
 * interesting failure is *simultaneity*: five agents ready an action and the
 * whole round resolves at once, so "a fireball into the group the rogue just
 * put to sleep" is two individually sensible choices that are jointly terrible,
 * and nothing warns anybody. That is the one thing a viewer can see coming and
 * the agents cannot, so `readied` gets the loudest band on every card. Health
 * bars are table stakes; the readied row is the show.
 *
 * The same argument picks the map's contents. `dread` is invisible to a reader
 * of the transcript and decides how many extra enemies the next fight has
 * (`floor(dread / 4)`, from `content.ts`), so it gets a segmented meter where
 * each completed block of four is one more enemy rather than an abstract
 * gauge. And every fifth floor is a boss, which is knowable from the floor
 * number alone — so the shaft can mark what is coming before anybody walks
 * into it.
 *
 * ## Built once, updated in place
 *
 * The store announces about twice a second. Re-templating a panel at that rate
 * kills every CSS transition on it — a bar that is replaced mid-animation
 * always renders at its final width, which is exactly the information the
 * animation existed to carry — so every node here is created at mount (or on
 * the first scene, for the per-member cards) and afterwards only its text,
 * class list and transform change.
 *
 * Scene-driven panels are additionally gated on scene *identity*. `render` is
 * called for every event batch, most of which carry no new `state` event, and
 * gating on identity is also what makes `state.previous` a usable diff: it is
 * the scene before this one exactly once, which is when a health drop should
 * flash.
 *
 * ## This module renders and nothing else
 *
 * No fetch, no import except `derive`, no writes anywhere. The broadcast has to
 * be incapable of changing what it is watching — see `docs/broadcast-viewer.md`.
 */

import { derive } from "./state.js";
import type {
  BroadcastState,
  ClassId,
  Milestone,
  Phase,
  Renderer,
  RunRecord,
  Scene,
  ScenePartyMember,
  SceneStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Create an element with a class and optional text, which is most of the work here. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Assign text only when it changed.
 *
 * Not micro-optimisation: writing `textContent` collapses any selection inside
 * the node and, on a node being transitioned, can force a synchronous layout
 * every 700ms. Most frames change two numbers out of a hundred.
 */
function text(node: Node, value: string | number | null | undefined): void {
  const next = value == null ? "" : String(value);
  if (node.textContent !== next) node.textContent = next;
}

/** Add or remove a class without reading the whole list first. */
function flag(node: Element, className: string, on: boolean): void {
  node.classList.toggle(className, !!on);
}

/** Thousands separators, because a five-digit XP total is unreadable without them. */
function commas(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
}

/** 0..1, and never NaN — a zero `maxHp` would otherwise blank a whole card. */
function ratio(part: number, whole: number): number {
  const w = Number(whole);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const p = Number(part);
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p / w));
}

/**
 * `put-down-a-boss` → `Put down a boss`.
 *
 * Sentence case rather than title case on purpose: the milestone ids are
 * written as sentences (`did-not-fall-for-the-same-thing-twice`) and title
 * casing them produces `Did Not Fall For The Same Thing Twice`, which reads
 * like a headline for something that is actually a checklist line.
 */
function humanise(id: string): string {
  const words = String(id ?? "").split(/[-_]+/).filter(Boolean);
  if (!words.length) return "";
  return [words[0][0].toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ");
}

/** `shield_slam` → `SHIELD SLAM`. Derived rather than tabled, so a new ability needs no edit here. */
function shout(id: string): string {
  return String(id ?? "").replace(/[-_]+/g, " ").toUpperCase();
}

/** The viewer asked not to be moved at. Read live, because it can change mid-run. */
function stillness(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// ---------------------------------------------------------------------------
// Iconography
// ---------------------------------------------------------------------------

/*
 * Drawn as paths rather than typed as emoji.
 *
 * An emoji is a font lookup, and the three machines this page gets watched on
 * would render three different sets at three different weights — one of them
 * as a full-colour picture in the middle of a monochrome HUD. These are stroked
 * silhouettes in `currentColor`, so they inherit whatever the row they sit in
 * is already coloured and stay legible when the stream re-encodes them.
 */
const GLYPH = {
  /* readied actions, grouped by what the action *is* rather than by class */
  strike: "M5 19l9-9M13 5h6v6M4 15l5 5",
  ranged: "M4 20L19 5M19 5h-6M19 5v6",
  spell: "M12 3v5M12 16v5M3 12h5M16 12h5M6.5 6.5l3 3M14.5 14.5l3 3M17.5 6.5l-3 3M9.5 14.5l-3 3",
  guard: "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z",
  heal: "M12 5v14M5 12h14",
  utility: "M2 12s4-6 10-6 10 6 10 6-4 6-10 6-10-6-10-6zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  item: "M9.5 3h5M10.5 3v6l-4 8a2 2 0 0 0 1.8 3h7.4a2 2 0 0 0 1.8-3l-4-8V3",
  /* the four kinds of path out of a junction */
  unknown: "M6 21V11a6 6 0 0 1 12 0v10M12 21v-6",
  market: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v8M9.5 10.5h5M9.5 13.5h5",
  elite: "M6 11a6 6 0 1 1 12 0v3l-2 2v4H8v-4l-2-2zM9.5 11h.01M14.5 11h.01",
  shrine: "M12 3c3.2 4.2 5 6.2 5 9a5 5 0 0 1-10 0c0-2.8 1.8-4.8 5-9z",
  /* furniture */
  coin: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v8M9.5 10.5h5M9.5 13.5h5",
  boss: "M4 20l2.5-9L12 15l5.5-4 2.5 9z",
  down: "M6 6l12 12M18 6L6 18",
};

/** The name of one drawn shape. Every icon in this file is one of these. */
type GlyphName = keyof typeof GLYPH;

/**
 * Whether a string from the simulation names a shape we drew.
 *
 * Path kinds and readied action kinds are open-ended strings on the wire, so
 * asking this is the only honest way to pick between a glyph and the fallback.
 */
function isGlyph(name: string): name is GlyphName {
  return Object.hasOwn(GLYPH, name);
}

/** Which glyph a readied action gets. Anything unlisted falls back to `strike`. */
const ACTION_GLYPH = new Map<string, GlyphName>(
  Object.entries<GlyphName>({
    attack: "strike",
    backstab: "strike",
    shield_slam: "strike",
    shoot: "ranged",
    volley: "ranged",
    firebolt: "spell",
    fireball: "spell",
    lightning: "spell",
    frostbite: "spell",
    defend: "guard",
    shield: "guard",
    taunt: "guard",
    sanctuary: "guard",
    heal: "heal",
    bless: "heal",
    cleanse: "heal",
    revive: "heal",
    interrupt: "utility",
    sleep_powder: "utility",
    vanish: "utility",
    mark: "utility",
    use_item: "item",
  }),
);

/**
 * Actions whose `target` is legitimately null.
 *
 * The distinction matters because a missing target reads as an error and these
 * are not: `fireball` hits the room by definition, and `defend` can only be
 * aimed at the one casting it. Anything else with no target gets a plain dash.
 */
const AREA_ACTIONS = new Set(["fireball", "volley", "sanctuary", "cleanse"]);
const SELF_ACTIONS = new Set(["defend", "taunt", "vanish"]);

/** A stroked 24×24 icon. Cloned from a template so a hundred cards cost one parse. */
const iconCache = new Map<GlyphName, SVGSVGElement>();
function icon(name: GlyphName, className?: string): SVGSVGElement {
  let template = iconCache.get(name);
  if (!template) {
    template = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    template.setAttribute("viewBox", "0 0 24 24");
    template.setAttribute("fill", "none");
    template.setAttribute("stroke", "currentColor");
    template.setAttribute("stroke-width", "1.8");
    template.setAttribute("stroke-linecap", "round");
    template.setAttribute("stroke-linejoin", "round");
    template.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", GLYPH[name] ?? GLYPH.unknown);
    template.appendChild(path);
    iconCache.set(name, template);
  }
  const node = template.cloneNode(true) as SVGSVGElement;
  if (className) node.setAttribute("class", className);
  return node;
}

/** Swap the shape inside an icon that is already mounted, so nothing is re-created. */
function reshape(svg: SVGSVGElement, name: GlyphName): void {
  const d = GLYPH[name] ?? GLYPH.unknown;
  const path = svg.firstChild;
  if (path instanceof Element && path.getAttribute("d") !== d) path.setAttribute("d", d);
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/*
 * Four characters is what fits under a health bar at broadcast size, and a
 * status the viewer cannot name is worse than no chip at all. Kinds come from
 * `sim/descent/model.ts`; anything not listed falls back to its own first four
 * letters, so a new status shows up as itself rather than vanishing.
 */
const STATUS_SHORT = new Map(
  Object.entries({
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
  }),
);

/**
 * Which statuses are good news on a party member.
 *
 * Read from the party's side rather than in the abstract, because the same kind
 * means opposite things depending on who carries it. `taunt` on the guardian is
 * the guardian doing its job; `mark` on an ally is the tollHeal mechanic having
 * fired and is about to hurt. Every chip carries a `+`/`!` prefix as well as a
 * tint, so the reading does not depend on telling green from amber on a stream.
 */
const BOONS = new Set(["shield", "regen", "guard", "taunt"]);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The module's own stylesheet, injected once.
 *
 * `style.css` belongs to the page rather than to any module, and a HUD that
 * only works when somebody remembers to patch it is a HUD that will one day be
 * dropped into a page and render as unstyled divs. Tokens, `.meter`, `.k`,
 * `.num` and `.empty` all come from there; everything below is the layout of
 * three boxes nothing else touches, and every selector is `hud-` prefixed so it
 * cannot collide with the stage, the feed or the scoreboard.
 */
const STYLES = `
/* ---- shared ------------------------------------------------------------ */

.hud-stack { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* .meter is 6px, which is right in a dense list and invisible on a stage.
   Two classes deep so it beats the base rule regardless of sheet order. */
.meter.hud-tall { height: 11px; border-radius: 4px; }
.meter.hud-mid { height: 8px; }
.meter.hud-tall i, .meter.hud-mid i { transition: transform .5s cubic-bezier(.22,.61,.36,1), background .3s ease; }

.hud-row { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.hud-tag {
  font: 700 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase;
  padding: 3px 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--dim);
  white-space: nowrap;
}

/* ---- 1. the party strip ------------------------------------------------ */

.hud-party { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 8px; }

.hud-card {
  /* --who is the member's colour, picked up from style.css by class id so that
     a six-agent variant of the scenario needs no edit in this file. Torchlight
     is the fallback for a class nobody has assigned a colour to. */
  --who: var(--flame);
  position: relative; display: flex; flex-direction: column; gap: 5px;
  min-width: 0; padding: 7px 9px 0;
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px;
  border-top: 3px solid var(--who); overflow: hidden;
}
.hud-card[data-who="guardian"] { --who: var(--guardian); }
.hud-card[data-who="mage"]     { --who: var(--mage); }
.hud-card[data-who="rogue"]    { --who: var(--rogue); }
.hud-card[data-who="cleric"]   { --who: var(--cleric); }
.hud-card[data-who="ranger"]   { --who: var(--ranger); }

/* Dead is dimmed AND dashed AND labelled: three signals, because at streaming
   bitrates a 40% opacity difference is not one. */
.hud-card.dead { opacity: .42; border-style: dashed; border-top-color: var(--faint); }
.hud-card.active { box-shadow: 0 0 0 1px var(--who), 0 8px 20px -14px var(--who); }

.hud-who {
  font: 800 13px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase;
  color: var(--who); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-card.dead .hud-who { color: var(--dim); }

.hud-gold {
  display: flex; align-items: center; gap: 3px;
  font: 12px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--gold);
}
.hud-gold svg { width: 11px; height: 11px; opacity: .85; flex: 0 0 auto; }

.hud-barline { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
.hud-barline .num { font-size: 12px; }
.hud-barline .num.low { color: var(--bad); }

.hud-mana { display: block; }
.hud-mana.off { display: none; }

.hud-chips { display: flex; flex-wrap: wrap; gap: 3px; min-height: 15px; align-content: flex-start; }
.hud-chip {
  font: 700 9px/1 var(--mono); letter-spacing: .04em;
  padding: 3px 4px; border-radius: 3px; white-space: nowrap;
  background: rgba(217, 86, 79, .14); color: #f0938d; border: 1px solid rgba(217, 86, 79, .3);
}
.hud-chip.boon { background: rgba(95, 185, 138, .13); color: var(--good); border-color: rgba(95, 185, 138, .3); }
.hud-chip b { font-weight: 700; opacity: .7; margin-left: 3px; }

.hud-loadout {
  min-height: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 9px/1.3 var(--mono); color: var(--dim);
}

.hud-active {
  margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--active-who, var(--flame)) 8%, transparent), transparent 45%), #0d121b;
  display: grid; grid-template-columns: 150px minmax(0, 1fr) minmax(0, 1fr); gap: 10px;
  min-height: 104px; max-height: 142px; overflow: hidden;
}
.hud-active[data-who="guardian"] { --active-who: var(--guardian); }
.hud-active[data-who="mage"]     { --active-who: var(--mage); }
.hud-active[data-who="rogue"]    { --active-who: var(--rogue); }
.hud-active[data-who="cleric"]   { --active-who: var(--cleric); }
.hud-active[data-who="ranger"]   { --active-who: var(--ranger); }
.hud-activehead { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.hud-activename { color: var(--active-who); font: 800 12px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; }
.hud-statgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 7px; }
.hud-stat { padding: 4px; border: 1px solid rgba(35, 44, 61, .7); border-radius: 4px; }
.hud-stat b { display: block; color: var(--ink); font: 700 11px/1 var(--mono); }
.hud-stat span { display: block; margin-top: 3px; color: var(--faint); font: 700 7px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; }
.hud-detailcol { min-width: 0; overflow: hidden; }
.hud-detaillabel { margin-bottom: 5px; color: var(--faint); font: 700 8px/1 var(--sans); letter-spacing: .13em; text-transform: uppercase; }
.hud-itemline, .hud-skillline {
  display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-bottom: 4px;
  font: 9px/1.2 var(--mono); color: var(--dim);
}
.hud-itemline b, .hud-skillline b { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-itemline .slot, .hud-itemline .rarity {
  flex: 0 0 auto; padding: 2px 3px; border: 1px solid var(--line); border-radius: 3px;
  color: var(--faint); font: 700 7px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
}
.hud-itemline .rarity.rare, .hud-itemline .rarity.epic { color: var(--arcane); border-color: rgba(123, 143, 245, .5); }
.hud-affixes { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); }
.hud-affixes .bad { color: var(--bad); }
.hud-detail-empty { color: var(--faint); font: 10px/1.3 var(--sans); }

/* The readied band. Full-bleed at the foot of the card because it is the one
   thing on this strip a viewer can read a disaster off before it happens — the
   whole footer is tinted, so the card ends in the member's colour instead of
   wearing another stripe of it. */
.hud-ready {
  margin: auto -9px 0; padding: 7px 9px 8px;
  display: flex; align-items: center; gap: 7px; min-height: 40px;
  background: rgba(255, 255, 255, .035);
  background: color-mix(in srgb, var(--who) 13%, transparent);
  border-top: 1px solid var(--line);
}
.hud-ready svg { width: 17px; height: 17px; color: var(--who); flex: 0 0 auto; }
.hud-ready .lines { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hud-ready .verb {
  font: 800 11px/1 var(--sans); letter-spacing: .08em; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-ready .at {
  font: 10px/1 var(--mono); color: var(--dim);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Nothing readied while a fight is resolving is itself the story: somebody has
   not committed and the round is about to close without them. */
.hud-ready.idle { background: transparent; }
.hud-ready.idle svg, .hud-ready.idle .verb { color: var(--faint); }
.hud-ready.waiting { background: rgba(224, 176, 64, .12); border-top-color: var(--warn); }
.hud-ready.waiting svg, .hud-ready.waiting .verb { color: var(--warn); }
.hud-ready.gone { background: rgba(217, 86, 79, .14); border-top-color: var(--bad); }
.hud-ready.gone svg, .hud-ready.gone .verb { color: var(--bad); }

@keyframes hud-hurt {
  0%   { background: rgba(217, 86, 79, .38); }
  100% { background: var(--panel-2); }
}
.hud-card.hurt { animation: hud-hurt .75s ease-out; }

/* ---- 2. the shaft ------------------------------------------------------ */

.hud-map { gap: 8px; }

.hud-floors { position: relative; padding-left: 20px; flex: 0 0 auto; }
/* The shaft itself: one line the whole column hangs off, so the floors read as
   a descent rather than as a list. */
.hud-floors::before {
  content: ""; position: absolute; left: 6px; top: 4px; bottom: 4px; width: 2px;
  background: linear-gradient(180deg, transparent, var(--line) 12%, var(--line) 88%, transparent);
}
.hud-floor {
  position: relative; display: flex; align-items: center; gap: 7px; height: 22px;
  font: 12px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--faint);
}
.hud-floor::before {
  content: ""; position: absolute; left: -16px; top: 50%; margin-top: -3px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--line);
}
.hud-floor.cleared { color: var(--dim); }
.hud-floor.cleared::before { background: var(--faint); }
.hud-floor .lbl { font: 9px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; }
.hud-floor.bossfloor { color: var(--flame); }
.hud-floor.bossfloor::before { background: var(--flame); }
.hud-floor svg { width: 12px; height: 12px; opacity: .9; }

/* The unknown floors are the ones that may be clipped on a short screen, and
   they are the right thing to lose: the rail keeps running past the last row
   and fades, which reads as a shaft that carries on rather than as a list that
   was cut off. */
.hud-floors.deep { flex: 1 1 auto; min-height: 0; overflow: hidden; }

/* The floor they are standing on is the lit one.
   Warm all the way round rather than tabbed down one edge: torchlight is the
   only warm thing in this palette (see style.css), so "the box with light in
   it" is already the page's word for *here*, and the caret coming off the rail
   is what says which rung of the shaft it is hanging from. */
.hud-here {
  position: relative; margin: 5px 0 5px 20px; padding: 9px 10px; border-radius: 8px;
  background: linear-gradient(180deg, rgba(240, 160, 75, .07), transparent 60%), var(--panel-2);
  border: 1px solid var(--flame-dim);
  box-shadow: 0 8px 20px -12px rgba(240, 160, 75, .55);
}
.hud-here::before {
  content: ""; position: absolute; left: -17px; top: 18px;
  border: 6px solid transparent; border-left-color: var(--flame);
}
.hud-here.boss {
  background: linear-gradient(180deg, rgba(217, 86, 79, .09), transparent 60%), var(--panel-2);
  border-color: var(--bad);
  box-shadow: 0 8px 20px -12px rgba(217, 86, 79, .6);
}
.hud-here.boss::before { border-left-color: var(--bad); }
@keyframes hud-descend {
  from { opacity: 0; transform: translateY(-14px); }
  to   { opacity: 1; transform: none; }
}
.hud-here.moved { animation: hud-descend .5s cubic-bezier(.22,.61,.36,1); }

.hud-floorno { font: 800 22px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.hud-floorno span { font: 600 10px/1 var(--sans); letter-spacing: .18em; color: var(--faint); margin-right: 6px; }
.hud-here .hud-tag.boss { color: var(--bad); border-color: var(--bad); }

.hud-floorgraph { margin-top: 7px; }
.hud-zone {
  margin-bottom: 3px; font: 700 9px/1 var(--sans); letter-spacing: .13em;
  text-transform: uppercase; color: var(--flame);
}
.hud-graphcanvas { position: relative; height: 132px; border-radius: 6px; background: rgba(8, 12, 18, .52); }
.hud-graphcanvas[data-environment="flooded"] { background: radial-gradient(circle at 50% 100%, rgba(55, 128, 170, .24), transparent 66%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="spore-cloud"] { background: radial-gradient(circle at 20% 30%, rgba(104, 145, 73, .2), transparent 52%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="arcane-well"] { background: radial-gradient(circle at 50% 50%, rgba(128, 84, 190, .22), transparent 58%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="narrow-bridge"] { background: linear-gradient(90deg, rgba(8, 12, 18, .7) 34%, rgba(172, 127, 68, .13) 50%, rgba(8, 12, 18, .7) 66%); }
.hud-graphcanvas[data-environment="high-ground"] { background: linear-gradient(180deg, rgba(190, 203, 216, .13), transparent 55%), rgba(8, 12, 18, .62); }
.hud-graphedges { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.hud-graphedges line { stroke: var(--line); stroke-width: 1.5; }
.hud-graphedges line[data-kind="one-way"] { stroke: var(--flame); stroke-dasharray: 4 3; marker-end: url(#hud-route-arrow); }
.hud-graphedges line[data-kind="secret"] { stroke: var(--arcane); stroke-dasharray: 2 3; }
.hud-graphedges line[data-kind="trap"] { stroke: var(--bad); }
.hud-graphedges line[data-kind="locked"] { stroke: var(--gold); stroke-width: 3; stroke-dasharray: 1 2; }
.hud-graphedges line[data-kind="locked"][data-opened="true"] { stroke: var(--dim); stroke-width: 1.5; stroke-dasharray: none; }
.hud-roomnode {
  position: absolute; z-index: 1; width: 28px; height: 28px; margin: -14px 0 0 -14px;
  display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--line);
  background: var(--ground); color: var(--faint); font: 800 10px/1 var(--mono);
}
.hud-roomnode em {
  display: none; position: absolute; top: 30px; left: 50%; width: 92px; transform: translateX(-50%);
  font: 9px/1.15 var(--sans); font-style: normal; text-align: center; color: var(--dim);
}
.hud-roomnode.visited { border-color: var(--dim); color: var(--ink); }
.hud-roomnode.mapped { border-style: dashed; border-color: var(--arcane); }
.hud-roomnode.cleared { background: #18212d; }
.hud-roomnode.occupied {
  border-color: var(--bad); color: var(--bad);
  box-shadow: 0 0 0 4px rgba(220, 75, 75, .12);
}
.hud-roomnode.current { border: 2px solid var(--flame); color: var(--flame); box-shadow: 0 0 0 4px rgba(240, 160, 75, .12); }
.hud-roomnode.current em { display: block; color: var(--ink); }
.hud-roomnode[data-kind="boss"], .hud-roomnode[data-kind="elite"] { color: var(--bad); }
.hud-roomnode[data-kind="market"] { color: var(--gold); }
.hud-roomnode[data-kind="shrine"] { color: var(--arcane); }
.hud-roomnode.key { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(221, 182, 88, .1); }
.hud-roomnode[data-kind="stairs"] { color: var(--good); }
.hud-roomnode[data-environment]::after {
  position: absolute; right: -6px; top: -6px; min-width: 11px; height: 11px;
  display: grid; place-items: center; border-radius: 50%; background: var(--panel-2);
  font: 800 8px/1 var(--mono); color: var(--ink); border: 1px solid var(--line);
}
.hud-roomnode[data-environment="flooded"]::after { content: "≈"; color: #69b8e5; }
.hud-roomnode[data-environment="spore-cloud"]::after { content: "✺"; color: #91bc6c; }
.hud-roomnode[data-environment="arcane-well"]::after { content: "✧"; color: var(--arcane); }
.hud-roomnode[data-environment="narrow-bridge"]::after { content: "‖"; color: var(--gold); }
.hud-roomnode[data-environment="high-ground"]::after { content: "▲"; color: #c3d0dd; }

/* Where inside the floor they are. Four stops, because a floor is always
   junction → room → spoils → market and a phase name alone does not say
   whether the fight is ahead of them or behind them. */
.hud-track { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin: 9px 0 2px; }
.hud-stop { display: flex; flex-direction: column; align-items: center; gap: 5px; position: relative; }
.hud-stop::after {
  content: ""; position: absolute; top: 4px; left: 50%; width: 100%; height: 2px; background: var(--line);
}
.hud-stop:last-child::after { display: none; }
.hud-stop i {
  position: relative; z-index: 1; width: 10px; height: 10px; border-radius: 50%;
  background: var(--ground); border: 2px solid var(--line);
  transition: background .3s ease, border-color .3s ease, transform .3s ease;
}
.hud-stop em {
  font: 700 8px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
  color: var(--faint); font-style: normal; text-align: center;
}
.hud-stop.done i { background: var(--faint); border-color: var(--faint); }
.hud-stop.done em { color: var(--dim); }
.hud-stop.now i { background: var(--flame); border-color: var(--flame); transform: scale(1.45); }
.hud-stop.now em { color: var(--flame); }
.hud-oddphase { font: 700 11px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--flame); }

/* Dread. Segmented rather than continuous because every fourth segment is one
   more enemy in the next encounter (floor(dread / 4), in content.ts), so the
   blocks are the actual unit and a smooth bar would hide it. */
.hud-dread { margin-top: 10px; }
.hud-segs { display: flex; gap: 2px; margin-top: 4px; }
.hud-segs i {
  flex: 1; height: 7px; border-radius: 2px; background: #0d1219;
  transition: background .35s ease;
}
.hud-segs i.on { background: var(--warn); }
.hud-segs i.hot { background: var(--bad); }
.hud-segs i:nth-child(4n) { margin-right: 5px; }
.hud-segs i:last-child { margin-right: 0; }
.hud-dread .hud-tag.alarm { color: var(--bad); border-color: var(--bad); background: rgba(217, 86, 79, .12); }

/* The four ways on. */
.hud-paths { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; min-height: 0; }
.hud-path {
  display: flex; align-items: center; gap: 7px; padding: 5px 6px;
  border: 1px solid var(--line); border-radius: 6px; background: #0d121b;
  transition: border-color .3s ease, background .3s ease;
}
.hud-path svg { width: 16px; height: 16px; flex: 0 0 auto; color: var(--dim); }
.hud-path .txt { min-width: 0; flex: 1; }
.hud-path .lab {
  font: 11px/1.25 var(--sans); color: var(--ink);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.hud-path .hint { font: 10px/1.2 var(--mono); color: var(--faint); }
.hud-path[data-kind="market"] svg { color: var(--gold); }
.hud-path[data-kind="elite"] svg { color: var(--bad); }
.hud-path[data-kind="shrine"] svg { color: var(--arcane); }
.hud-path.chosen { border-color: var(--flame); background: rgba(240, 160, 75, .1); }
.hud-path.chosen .hud-tag { color: var(--flame); border-color: var(--flame); }

.hud-scouted {
  margin-top: 8px; padding: 6px 8px; border-left: 2px solid var(--rogue);
  background: rgba(176, 111, 214, .08); font: 11px/1.35 var(--sans); color: var(--dim);
}
.hud-scouted b { color: var(--rogue); font: 700 9px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; display: block; margin-bottom: 3px; }

.hud-note { margin-top: 9px; font: 11px/1.35 var(--sans); color: var(--dim); }
.hud-note b { color: var(--ink); font-variant-numeric: tabular-nums; }

/* ---- 3. progress ------------------------------------------------------- */

.hud-progress { gap: 11px; }
.hud-block { flex: 0 0 auto; }

.hud-big { font: 800 15px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }

/* Chasing the record: one track, the run's own XP as the fill, the best ever as
   a notch on it. Two bars would make the viewer measure lengths against each
   other; a notch makes the comparison a single yes/no. */
.hud-record { position: relative; }
.hud-notch {
  position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--flame);
  transition: left .5s cubic-bezier(.22,.61,.36,1);
}
.hud-notch::after {
  content: ""; position: absolute; top: -3px; left: -2px;
  border: 3px solid transparent; border-top-color: var(--flame);
}
.meter.hud-tall i.xp { background: var(--flame); }
.hud-recordfoot { display: flex; justify-content: space-between; margin-top: 5px; }
.hud-recordfoot .num { font-size: 12px; }
.hud-crown { color: var(--flame); border-color: var(--flame); background: rgba(240, 160, 75, .14); }
@keyframes hud-crown { 50% { opacity: .35; } }
.hud-crown.new { animation: hud-crown 1.4s ease-in-out infinite; }

.hud-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.hud-tile {
  padding: 6px 5px; background: var(--panel-2); border: 1px solid var(--line);
  border-radius: 6px; text-align: center; min-width: 0;
}
.hud-tile .v {
  font: 800 17px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink);
  display: block; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis;
}
.hud-tile .k { display: block; }
.hud-tile.alarm { border-color: rgba(217, 86, 79, .55); }
.hud-tile.alarm .v { color: var(--bad); }
.hud-tile.won .v { color: var(--flame); }

/* The ladder scrolls rather than shrinking its type: fifteen rows do not fit in
   a 320px column at a size anybody can read from a sofa, and the interesting
   row is always the frontier, which we keep centred. */
.hud-ladder {
  position: relative; flex: 1; min-height: 0; overflow-y: auto;
  scrollbar-width: none; margin-top: 2px;
}
.hud-ladder::-webkit-scrollbar { display: none; }
.hud-rung {
  display: flex; align-items: flex-start; gap: 7px; padding: 4px 2px;
  border-bottom: 1px solid rgba(35, 44, 61, .5);
}
.hud-rung .mk {
  flex: 0 0 auto; width: 13px; height: 13px; margin-top: 1px; border-radius: 50%;
  border: 2px solid var(--faint); position: relative;
  transition: background .35s ease, border-color .35s ease;
}
.hud-rung .nm { flex: 1; min-width: 0; font: 11.5px/1.3 var(--sans); color: var(--faint); }
.hud-rung .pt {
  flex: 0 0 auto; font: 11px/1.3 var(--mono); font-variant-numeric: tabular-nums; color: var(--faint);
}
.hud-rung.got .mk { background: var(--good); border-color: var(--good); }
.hud-rung.got .mk::after {
  content: ""; position: absolute; left: 2px; top: 0px; width: 3px; height: 6px;
  border: solid var(--ground); border-width: 0 2px 2px 0; transform: rotate(42deg);
}
.hud-rung.got .nm { color: var(--ink); }
.hud-rung.got .pt { color: var(--gold); }
/* The next one, which is what the party is actually playing for right now. */
.hud-rung.next .mk { border-color: var(--flame); }
.hud-rung.next .nm { color: var(--dim); }
@keyframes hud-lit {
  0%   { background: rgba(95, 185, 138, .3); }
  100% { background: transparent; }
}
.hud-rung.lit { animation: hud-lit 1.6s ease-out; }

@media (prefers-reduced-motion: reduce) {
  .meter.hud-tall i, .meter.hud-mid i, .hud-notch, .hud-stop i, .hud-segs i,
  .hud-path, .hud-rung .mk { transition: none; }
  .hud-card.hurt, .hud-here.moved, .hud-rung.lit, .hud-crown.new { animation: none; }
}
`;

/** Inject once. A second mount (a hot reload, a second page) must not duplicate the sheet. */
function installStyles() {
  if (document.getElementById("hud-styles")) return;
  const tag = el("style");
  tag.id = "hud-styles";
  tag.textContent = STYLES;
  document.head.appendChild(tag);
}

// ---------------------------------------------------------------------------
// 1. The party strip
// ---------------------------------------------------------------------------

/** One status chip: the pill itself, its four-letter name, and its tick count. */
interface ChipHandle {
  root: HTMLElement;
  label: HTMLElement;
  ticks: HTMLElement;
}

/** The nodes on one member's card that ever change after the card is built. */
interface CardHandle {
  root: HTMLElement;
  gold: HTMLElement;
  hpNum: HTMLElement;
  hpFill: HTMLElement;
  hpBar: HTMLElement;
  mana: HTMLElement;
  mpNum: HTMLElement;
  mpFill: HTMLElement;
  chips: HTMLElement;
  /** The chip nodes inside `chips`, held rather than re-queried — see `chips()`. */
  chipNodes: ChipHandle[];
  loadout: HTMLElement;
  ready: HTMLElement;
  readyIcon: SVGSVGElement;
  verb: HTMLElement;
  at: HTMLElement;
}

/** Draw a scene, given the one before it so a change can be animated. */
type SceneRenderer = (scene: Scene | null, before: Scene | null) => void;

/**
 * One card per member, built the first time a scene names them.
 *
 * Keyed by member id and rebuilt only when the roster changes, rather than
 * hard-coded to the five classes: `hud.js` should not be the file that has to
 * be edited when somebody writes a six-agent variant, and the class colours are
 * already data (`[data-who]` picks the token up from `style.css`).
 */
function buildParty(host: HTMLElement): SceneRenderer {
  const strip = el("div", "hud-party");
  const empty = el("div", "empty", "Waiting for the party.");
  host.appendChild(empty);
  host.appendChild(strip);

  /** id → the handful of nodes that ever change. */
  const cards = new Map<ClassId, CardHandle>();
  let roster = "";

  function card(id: ClassId): CardHandle {
    const root = el("div", "hud-card");
    root.dataset.who = id;

    const head = el("div", "hud-row");
    const who = el("div", "hud-who", shout(id));
    const gold = el("div", "hud-gold");
    const goldNum = el("span", null, "0");
    gold.append(icon("coin"), goldNum);
    head.append(who, gold);

    const hpLine = el("div", "hud-barline");
    const hpNum = el("span", "num");
    hpLine.append(el("span", "k", "HP"), hpNum);
    const hpBar = el("div", "meter hud-tall");
    const hpFill = el("i");
    hpBar.appendChild(hpFill);

    const mana = el("div", "hud-mana");
    const mpLine = el("div", "hud-barline");
    const mpNum = el("span", "num");
    mpLine.append(el("span", "k", "MANA"), mpNum);
    const mpBar = el("div", "meter mana hud-mid");
    const mpFill = el("i");
    mpBar.appendChild(mpFill);
    mana.append(mpLine, mpBar);

    const chips = el("div", "hud-chips");
    const loadout = el("div", "hud-loadout", "—");

    const ready = el("div", "hud-ready");
    const readyIcon = icon("strike");
    const lines = el("div", "lines");
    const verb = el("div", "verb", "—");
    const at = el("div", "at", "");
    lines.append(verb, at);
    ready.append(readyIcon, lines);

    root.append(head, hpLine, hpBar, mana, chips, loadout, ready);
    return {
      root,
      gold: goldNum,
      hpNum,
      hpFill,
      hpBar,
      mana,
      mpNum,
      mpFill,
      chips,
      chipNodes: [],
      loadout,
      ready,
      readyIcon,
      verb,
      at,
    };
  }

  /**
   * Statuses, reusing chip nodes.
   *
   * A member carries nought to four of these and they change every round, so the
   * list is grown to the count needed and the surplus hidden rather than
   * destroyed — creating five nodes twice a second for fifty minutes is the kind
   * of churn that shows up as a stutter on the canvas next door. The chips are
   * kept as handles on the card rather than read back off the box, so the two
   * nodes inside each one are the ones this function created.
   */
  function chips(refs: CardHandle, list: SceneStatus[]): void {
    const nodes = refs.chipNodes;
    const want = list.length;
    while (nodes.length < want) {
      const chip = el("span", "hud-chip");
      const label = el("span");
      const ticks = el("b");
      chip.append(label, ticks);
      refs.chips.appendChild(chip);
      nodes.push({ root: chip, label, ticks });
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (i >= want) {
        node.root.style.display = "none";
        continue;
      }
      const s = list[i];
      const kind = String(s.kind ?? "");
      node.root.style.display = "";
      flag(node.root, "boon", BOONS.has(kind));
      text(node.label, `${BOONS.has(kind) ? "+" : "!"}${STATUS_SHORT.get(kind) ?? kind.slice(0, 4).toUpperCase()}`);
      text(node.ticks, s.ticks > 0 ? `${s.ticks}` : "");
    }
  }

  /**
   * The readied band, which is the reason this panel exists.
   *
   * Four states rather than two. "Nothing readied" is ambiguous on its own —
   * out of combat it is normal and in combat it means somebody is about to be
   * skipped when the round closes — so the phase decides whether the empty case
   * is grey or amber.
   */
  function readied(
    refs: CardHandle,
    member: ScenePartyMember,
    scene: Scene,
    names: Map<string, string>,
  ): void {
    const box = refs.ready;
    if (member.dead) {
      flag(box, "idle", false);
      flag(box, "waiting", false);
      flag(box, "gone", true);
      reshape(refs.readyIcon, "down");
      text(refs.verb, "DOWN");
      text(refs.at, "needs a revive");
      return;
    }
    flag(box, "gone", false);

    const act = member.readied;
    if (act?.kind) {
      flag(box, "idle", false);
      flag(box, "waiting", false);
      reshape(refs.readyIcon, ACTION_GLYPH.get(act.kind) ?? "strike");
      text(refs.verb, shout(act.kind));
      const target = act.target ? (names.get(act.target) ?? humanise(act.target)) : null;
      text(
        refs.at,
        target
          ? `→ ${target}`
          : AREA_ACTIONS.has(act.kind)
            ? "→ everything"
            : SELF_ACTIONS.has(act.kind)
              ? "→ self"
              : "—",
      );
      return;
    }

    const fighting = scene.phase === "combat";
    flag(box, "waiting", fighting);
    flag(box, "idle", !fighting);
    reshape(refs.readyIcon, fighting ? "utility" : "guard");
    text(refs.verb, fighting ? "NOT READIED" : "STANDING BY");
    text(refs.at, fighting ? "the round closes without them" : shout(scene.phase ?? ""));
  }

  return function renderParty(scene, before) {
    const party = scene?.party ?? [];
    empty.style.display = party.length ? "none" : "";
    strip.style.display = party.length ? "" : "none";
    // A party can only be non-empty if there is a scene it came from; saying so
    // here is what lets everything below read the scene without a guard.
    if (!scene || !party.length) return;

    // Rebuild only when the cast itself changed; a reordering or a new run with
    // the same five classes reuses every node and keeps its transitions.
    const ids = party.map((p) => p.id).join(",");
    if (ids !== roster) {
      roster = ids;
      cards.clear();
      strip.textContent = "";
      for (const member of party) {
        const refs = card(member.id);
        cards.set(member.id, refs);
        strip.appendChild(refs.root);
      }
    }

    const names = new Map<string, string>((scene.enemies ?? []).map((e) => [e.ref, e.name]));
    const was = new Map<ClassId, ScenePartyMember>((before?.party ?? []).map((p) => [p.id, p]));

    for (const member of party) {
      const refs = cards.get(member.id);
      if (!refs) continue;

      flag(refs.root, "dead", !!member.dead);

      const hp = ratio(member.hp, member.maxHp);
      refs.hpFill.style.transform = `scaleX(${hp})`;
      flag(refs.hpBar, "hurt", hp < 0.55 && hp >= 0.25);
      flag(refs.hpBar, "dire", hp < 0.25);
      text(refs.hpNum, `${Math.max(0, member.hp ?? 0)}/${member.maxHp ?? 0}`);
      flag(refs.hpNum, "low", hp < 0.25);

      // Casters only, decided by the data rather than by a list of class names.
      const caster = (member.maxMana ?? 0) > 0;
      flag(refs.mana, "off", !caster);
      if (caster) {
        refs.mpFill.style.transform = `scaleX(${ratio(member.mana, member.maxMana)})`;
        text(refs.mpNum, `${Math.max(0, member.mana ?? 0)}/${member.maxMana}`);
      }

      text(refs.gold, commas(member.gold ?? 0));
      chips(refs, (member.statuses ?? []).filter((s) => (s?.ticks ?? 0) > 0).slice(0, 6));
      const worn = (member.worn ?? []).map((item) => `${item.slot.slice(0, 1).toUpperCase()}:${item.name}`);
      const talents = (member.talents ?? []).map((talent) => `${talent.name} ${talent.rank}`);
      const points = (member.talentPoints ?? 0) > 0 ? `${member.talentPoints} SP` : "";
      const loadout = [...worn, ...talents, points].filter(Boolean);
      text(refs.loadout, loadout.join(" · ") || "no equipment or skills");
      refs.loadout.title = loadout.join("\n") || "No equipment or invested skills";
      readied(refs, member, scene, names);

      // Flash on a drop. `before` is the previous *scene*, so this fires once
      // per round rather than on every poll — restarting the animation needs the
      // class removed, a reflow forced, and the class put back.
      const prior = was.get(member.id);
      if (prior && (member.hp ?? 0) < (prior.hp ?? 0)) {
        refs.root.classList.remove("hurt");
        void refs.root.offsetWidth;
        refs.root.classList.add("hurt");
      }
    }
  };
}

/**
 * Full data for whichever character most recently spoke or used a tool.
 *
 * The five-card strip answers "how is everyone?"; this answers "what is this
 * character actually carrying and built to do?" without making every card
 * dense enough to become unreadable at broadcast distance.
 */
function buildActiveCharacter(host: HTMLElement): Renderer {
  const root = el("div", "hud-active");
  root.style.display = "none";
  host.appendChild(root);
  let signature = "";

  const label = (name: string) => el("div", "hud-detaillabel", name);
  const stat = (name: string, value: string | number) => {
    const box = el("div", "hud-stat");
    box.append(el("b", null, String(value)), el("span", null, name));
    return box;
  };

  return (state) => {
    const scene = state.scene;
    const party = scene?.party ?? [];
    if (!scene || party.length === 0) {
      root.style.display = "none";
      return;
    }

    const latestAgent = [...state.feed]
      .reverse()
      .find((entry) => entry.type === "call" || entry.type === "say")?.agent.toLowerCase();
    const member =
      party.find((candidate) => latestAgent?.includes(candidate.id)) ??
      party.find((candidate) => !candidate.dead) ??
      party[0];
    root.style.display = "";
    root.dataset.who = member.id;
    for (const card of host.querySelectorAll<HTMLElement>(".hud-card")) {
      flag(card, "active", card.dataset.who === member.id);
    }

    const nextSignature = `${member.id}:${JSON.stringify(member)}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    root.textContent = "";

    const summary = el("div", "hud-detailcol");
    const head = el("div", "hud-activehead");
    head.append(el("div", "hud-activename", member.id), el("span", "hud-tag", "active character"));
    const stats = el("div", "hud-statgrid");
    stats.append(
      stat("HP", `${member.hp}/${member.maxHp}`),
      stat("Mana", `${member.mana}/${member.maxMana}`),
      stat("Gold", member.gold),
      stat("Armour", member.armor),
      stat("Power", member.power),
      stat("Speed", member.speed),
    );
    summary.append(head, stats);

    const items = el("div", "hud-detailcol");
    items.appendChild(label("Equipment and pack"));
    const allItems = [
      ...(member.worn ?? []).map((item) => ({ item, slot: item.slot })),
      ...(member.pack ?? []).map((item) => ({ item, slot: "pack" })),
    ];
    if (allItems.length === 0) items.appendChild(el("div", "hud-detail-empty", "Nothing carried or equipped."));
    for (const { item, slot } of allItems.slice(0, 6)) {
      const line = el("div", "hud-itemline");
      const source = item.provenance?.source ?? "legacy trace";
      const found = item.provenance?.floor ? `, floor ${item.provenance.floor}` : "";
      line.title = `${item.id}\n${item.description ?? item.name}\nFound: ${source}${found}`;
      const itemRarity = item.rarity ?? "common";
      const rarity = el("span", `rarity ${itemRarity}`, itemRarity);
      const affixes = el("span", "hud-affixes");
      for (const [index, affix] of (item.affixes ?? []).entries()) {
        if (index > 0) affixes.append(" · ");
        const effect = el("span", affix.polarity === "negative" ? "bad" : null, affix.description);
        affixes.appendChild(effect);
      }
      line.append(el("span", "slot", slot), rarity, el("b", null, item.name), affixes);
      items.appendChild(line);
    }

    const build = el("div", "hud-detailcol");
    build.appendChild(label("Skills and current action"));
    const skillLines = [
      ...(member.talents ?? []).map((talent) => `${talent.name} ${talent.rank}`),
      ...(member.cooldowns ?? []).map((cooldown) => `${humanise(cooldown.id)} · ${cooldown.ticks} cooldown`),
      ...(member.statuses ?? []).map((status) => `${humanise(status.kind)} · ${status.ticks} rounds`),
    ];
    if ((member.talentPoints ?? 0) > 0) skillLines.unshift(`${member.talentPoints} unspent skill points`);
    for (const line of skillLines.slice(0, 6)) build.appendChild(el("div", "hud-skillline", line));
    if (skillLines.length === 0) build.appendChild(el("div", "hud-detail-empty", "No talents, effects, or cooldowns."));
    const action = member.readied
      ? `${shout(member.readied.kind)}${member.readied.target ? ` → ${humanise(member.readied.target)}` : ""}`
      : scene.phase === "combat"
        ? "NOT READIED"
        : `Standing by · ${humanise(scene.phase)}`;
    const actionLine = el("div", "hud-skillline");
    actionLine.append(el("span", "hud-tag", "action"), el("b", null, action));
    build.appendChild(actionLine);

    root.append(summary, items, build);
  };
}

// ---------------------------------------------------------------------------
// 2. The shaft
// ---------------------------------------------------------------------------

/** Maze-mode broadcasts put a boss every fourth floor; legacy corridor runs use five. */
const isBossFloor = (floor: number, step = 5): boolean =>
  Number.isFinite(floor) && floor > 0 && floor % step === 0;

/** One station inside a floor, and what to call it on the track. */
interface Stop {
  phase: Phase;
  label: string;
}

/** The stops inside one floor, in the order the simulation walks them. */
const STOPS: Stop[] = [
  { phase: "explore", label: "junction" },
  { phase: "combat", label: "the room" },
  { phase: "spoils", label: "spoils" },
  { phase: "market", label: "market" },
];

/** How many segments the dread meter shows. Two full blocks of four is +2 enemies. */
const DREAD_SEGS = 8;

/** One rung of the shaft above the party: the row, its number, and its label. */
interface FloorRow {
  row: HTMLElement;
  num: HTMLElement;
  label: HTMLElement;
}

/** A rung below the party also carries the boss mark, hidden unless that floor holds one. */
interface DeepFloorRow extends FloorRow {
  mark: SVGSVGElement;
}

/** One of the ways out of a junction, as the map draws it. */
interface PathRow {
  row: HTMLElement;
  glyph: SVGSVGElement;
  lab: HTMLElement;
  hint: HTMLElement;
  tag: HTMLElement;
}

function buildMap(host: HTMLElement): (scene: Scene | null) => void {
  const root = el("div", "hud-stack hud-map");
  const empty = el("div", "empty", "The dungeon has not been entered yet.");
  root.appendChild(empty);

  const above = el("div", "hud-floors");
  const aboveRows: FloorRow[] = [];
  for (let i = 0; i < 3; i++) {
    const row = el("div", "hud-floor cleared");
    const num = el("span");
    const label = el("span", "lbl", "cleared");
    row.append(num, label);
    aboveRows.push({ row, num, label });
    above.appendChild(row);
  }

  const here = el("div", "hud-here");
  const headRow = el("div", "hud-row");
  const floorNo = el("div", "hud-floorno");
  const floorWord = el("span", null, "FLOOR");
  const floorNum = el("span", null, "—");
  floorNo.append(floorWord, floorNum);
  const bossTag = el("span", "hud-tag boss", "BOSS FLOOR");
  headRow.append(floorNo, bossTag);

  const graph = el("div", "hud-floorgraph");
  const graphZone = el("div", "hud-zone");
  const graphCanvas = el("div", "hud-graphcanvas");
  graph.append(graphZone, graphCanvas);

  const track = el("div", "hud-track");
  const stops = STOPS.map((stop) => {
    const node = el("div", "hud-stop");
    node.append(el("i"), el("em", null, stop.label));
    track.appendChild(node);
    return node;
  });
  const oddPhase = el("div", "hud-oddphase");

  const dread = el("div", "hud-dread");
  const dreadHead = el("div", "hud-row");
  const dreadNum = el("span", "num");
  const dreadTag = el("span", "hud-tag");
  dreadHead.append(el("span", "k", "Dread"), dreadNum, dreadTag);
  const segs = el("div", "hud-segs");
  const segNodes: HTMLElement[] = [];
  for (let i = 0; i < DREAD_SEGS; i++) {
    const seg = el("i");
    segNodes.push(seg);
    segs.appendChild(seg);
  }
  dread.append(dreadHead, segs);

  const paths = el("div", "hud-paths");
  const pathRows: PathRow[] = [];
  for (let i = 0; i < 8; i++) {
    const row = el("div", "hud-path");
    const glyph = icon("unknown");
    const txt = el("div", "txt");
    const lab = el("div", "lab");
    const hint = el("div", "hint");
    txt.append(lab, hint);
    const tag = el("span", "hud-tag");
    row.append(glyph, txt, tag);
    pathRows.push({ row, glyph, lab, hint, tag });
    paths.appendChild(row);
  }

  const scouted = el("div", "hud-scouted");
  const scoutedText = el("span");
  scouted.append(el("b", null, "The rogue went ahead"), scoutedText);

  const note = el("div", "hud-note");

  here.append(headRow, graph, track, oddPhase, dread, paths, scouted, note);

  const below = el("div", "hud-floors deep");
  const belowRows: DeepFloorRow[] = [];
  for (let i = 0; i < 5; i++) {
    const row = el("div", "hud-floor");
    const num = el("span");
    const label = el("span", "lbl");
    const mark = icon("boss");
    row.append(num, label, mark);
    belowRows.push({ row, num, label, mark });
    below.appendChild(row);
  }

  const body = el("div", "hud-stack");
  body.append(above, here, below);
  root.appendChild(body);
  host.appendChild(root);

  let lastFloor: number | null = null;
  let lastGraph = "";

  function drawFloorGraph(map: NonNullable<Scene["floorMap"]>): void {
    const key = JSON.stringify(map);
    if (key === lastGraph) return;
    lastGraph = key;
    graphCanvas.textContent = "";
    const current = map.rooms.find((room) => room.id === map.currentRoom);
    const environment = current?.environment;
    text(
      graphZone,
      `${map.zone} · ${map.keys} floor key${map.keys === 1 ? "" : "s"}${environment ? ` · ${environment.name}` : ""}`,
    );
    graphCanvas.dataset.environment = environment?.kind ?? "";

    const xs = map.rooms.map((room) => room.x);
    const ys = map.rooms.map((room) => room.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const point = (room: (typeof map.rooms)[number]) => ({
      x: 10 + ((room.x - minX) / Math.max(1, maxX - minX)) * 80,
      y: 10 + ((room.y - minY) / Math.max(1, maxY - minY)) * 80,
    });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "hud-graphedges");
    const roomById = new Map(map.rooms.map((room) => [room.id, room]));
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "hud-route-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "context-stroke");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);
    for (const route of map.routes) {
      const from = roomById.get(route.from);
      const to = roomById.get(route.to);
      if (!from || !to) continue;
      const a = point(from);
      const b = point(to);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.dataset.kind = route.kind;
      line.dataset.opened = route.openedBy ? "true" : "false";
      line.setAttribute("x1", `${a.x}%`);
      line.setAttribute("y1", `${a.y}%`);
      line.setAttribute("x2", `${b.x}%`);
      line.setAttribute("y2", `${b.y}%`);
      const routeTitle = document.createElementNS("http://www.w3.org/2000/svg", "title");
      routeTitle.textContent =
        route.kind === "locked"
          ? route.openedBy
            ? `Locked door · opened by ${route.openedBy}`
            : "Locked door · key, rogue lock-pick, or guardian breach"
          : route.kind;
      line.appendChild(routeTitle);
      svg.appendChild(line);
    }
    graphCanvas.appendChild(svg);

    const glyphs: Record<string, string> = {
      entrance: "IN",
      empty: "·",
      combat: "⚔",
      elite: "!",
      boss: "☠",
      market: "$",
      cache: "◇",
      shrine: "✦",
      stairs: "↓",
    };
    for (const room of map.rooms) {
      const at = point(room);
      const node = el("div", "hud-roomnode");
      node.dataset.kind = room.kind;
      if (room.environment) node.dataset.environment = room.environment.kind;
      node.style.left = `${at.x}%`;
      node.style.top = `${at.y}%`;
      flag(node, "current", room.id === map.currentRoom);
      flag(node, "visited", room.visited);
      flag(node, "mapped", room.revealed && !room.visited);
      flag(node, "cleared", room.cleared);
      flag(node, "occupied", !!room.threat);
      flag(node, "key", room.key);
      node.append(
        el(
          "b",
          null,
          room.threat ? `⚔${room.threat.enemies}` : room.key && !room.keyCollected ? "🔑" : (glyphs[room.kind] ?? "?"),
        ),
        el("em", null, room.label),
      );
      node.title = `${room.label} · ${room.kind}${room.environment ? ` · ${room.environment.name}: ${room.environment.effect}` : ""}${room.revealed && !room.visited ? " · revealed by equipment" : ""}${room.cleared ? " · cleared" : ""}${room.key ? room.keyCollected ? " · floor key recovered here" : " · floor key waiting here" : ""}${room.threat ? ` · ${room.threat.enemies} enemies remain at ${room.threat.hp}/${room.threat.maxHp} hp after ${room.threat.retreats} retreat${room.threat.retreats === 1 ? "" : "s"}` : ""}`;
      graphCanvas.appendChild(node);
    }
  }

  return function renderMap(scene) {
    empty.style.display = scene ? "none" : "";
    body.style.display = scene ? "" : "none";
    if (!scene) return;

    const floor = Number(scene.floor) || 0;
    const phase = String(scene.phase ?? "");
    const floorMap = scene.floorMap;
    const bossStep = floorMap ? 4 : 5;
    graph.style.display = floorMap ? "" : "none";
    track.style.display = floorMap ? "none" : "grid";
    if (floorMap) drawFloorGraph(floorMap);

    // Shallower floors, already behind them. Descending order top-to-bottom so
    // the column reads downward the way the party moves.
    for (let i = 0; i < aboveRows.length; i++) {
      const n = floor - (aboveRows.length - i);
      const row = aboveRows[i];
      row.row.style.visibility = n > 0 ? "" : "hidden";
      text(row.num, n > 0 ? String(n) : "");
      text(row.label, isBossFloor(n, bossStep) ? "boss · cleared" : "cleared");
      flag(row.row, "bossfloor", false);
    }

    text(floorNum, String(floor));
    const boss = isBossFloor(floor, bossStep);
    flag(here, "boss", boss);
    bossTag.style.display = boss ? "" : "none";

    // A floor change is the beat of the whole run, so it gets its own motion.
    if (lastFloor !== null && floor !== lastFloor) {
      here.classList.remove("moved");
      void here.offsetWidth;
      here.classList.add("moved");
    }
    lastFloor = floor;

    const at = STOPS.findIndex((s) => s.phase === phase);
    for (let i = 0; i < stops.length; i++) {
      flag(stops[i], "now", i === at);
      flag(stops[i], "done", at >= 0 && i < at);
    }
    // `camp` and `over` are not stations on the floor; naming them beats
    // showing four dead dots and no explanation.
    const odd = at < 0 && phase;
    oddPhase.style.display = odd ? "" : "none";
    track.style.opacity = odd ? "0.3" : "1";
    if (odd) text(oddPhase, phase === "over" ? "THE RUN IS OVER" : shout(phase));

    const d = Math.max(0, Number(scene.dread) || 0);
    text(dreadNum, d > DREAD_SEGS ? `${DREAD_SEGS}+` : String(d));
    for (let i = 0; i < segNodes.length; i++) {
      flag(segNodes[i], "on", i < d);
      flag(segNodes[i], "hot", i < d && i >= 4);
    }
    const extra = Math.min(1, Math.floor(d / 4));
    dreadTag.style.display = extra > 0 ? "" : "none";
    flag(dreadTag, "alarm", extra > 0);
    if (extra > 0) text(dreadTag, `+${extra} reinforcement${extra === 1 ? "" : "s"}`);

    // Paths are only the current offer while the party is standing at the
    // junction; `scene.paths` keeps its last value through the fight that
    // follows, and showing stale branches mid-combat would be a lie.
    const exploring = phase === "explore";
    const list = exploring ? (scene.paths ?? []) : [];
    paths.style.display = list.length ? "" : "none";
    for (let i = 0; i < pathRows.length; i++) {
      const row = pathRows[i];
      const path = list[i];
      row.row.style.display = path ? "" : "none";
      if (!path) continue;
      const kind = String(path.kind ?? "unknown");
      const route = String(path.route ?? "passage");
      row.row.dataset.kind = kind;
      reshape(row.glyph, isGlyph(kind) ? kind : "unknown");
      text(row.lab, path.label ?? path.id ?? "");
      text(row.hint, path.hint ? `“${path.hint}”` : "");
      row.hint.style.display = path.hint ? "" : "none";
      const chosen = !!scene.pendingPath && scene.pendingPath === path.id;
      flag(row.row, "chosen", chosen);
      text(row.tag, chosen ? "chosen" : route === "passage" ? kind : `${kind} · ${route}`);
    }

    const scout = exploring && scene.scouted ? String(scene.scouted) : "";
    scouted.style.display = scout ? "" : "none";
    if (scout) text(scoutedText, scout);

    // Out of the junction the useful line is what the phase is holding: loot
    // waiting to be divided, stock waiting to be bought, or who is left up.
    let line = "";
    if (phase === "combat") {
      const enemies = scene.enemies ?? [];
      line = enemies.length ? `In the room with ${enemies.length} of them.` : "The room is clear.";
    } else if (phase === "spoils") {
      const loot = (scene.loot ?? []).length;
      line = loot ? `${loot} drop${loot === 1 ? "" : "s"} to divide.` : "Nothing left on the floor.";
    } else if (phase === "market") {
      const stock = (scene.stock ?? []).length;
      line = stock ? `A merchant with ${stock} thing${stock === 1 ? "" : "s"} for sale.` : "The merchant has nothing left.";
    }
    note.style.display = line ? "" : "none";
    if (line) text(note, line);

    // Deeper floors, unknown except for where the bosses are — which is the one
    // thing about the dark ahead that the floor number alone already tells you.
    for (let i = 0; i < belowRows.length; i++) {
      const n = floor + i + 1;
      const row = belowRows[i];
      text(row.num, String(n));
      const bossAhead = isBossFloor(n, bossStep);
      flag(row.row, "bossfloor", bossAhead);
      text(row.label, bossAhead ? "boss" : "unknown");
      row.mark.style.display = bossAhead ? "" : "none";
    }
  };
}

// ---------------------------------------------------------------------------
// 3. Progress
// ---------------------------------------------------------------------------

/** The fused figures the progress panel prints, plus the last scene watched. */
interface TallyCounts {
  floors: number;
  bosses: number;
  deaths: number;
  down: number;
  seen: Scene | null;
}

/** The counters kept across scenes, because no single scene carries them. */
interface Tally {
  reset(): void;
  watch(scene: Scene | null, before: Scene | null): void;
  read(scene: Scene | null, milestones: Milestone[] | null): TallyCounts;
}

/**
 * Headline counters the scene does not carry, recovered from what does.
 *
 * `snapshot()` has `floorsCleared`, `bossesDefeated` and `permanentDeaths`, and
 * `state.js` keeps only `snapshot.scene` — so this panel has to reconstruct
 * them. Two sources, fused, because neither is sufficient alone:
 *
 * - **Watching.** Every scene is diffed against the last: the shallowest floor
 *   ever seen is where they started, a `death` beat against a ref that was a
 *   boss last time we saw it alive is a boss killed, and a member flipping to
 *   `dead` is a fall. Exact — but only from the moment the page loaded, and
 *   `/events?since=0` folds an entire in-progress trace into one batch, so a
 *   page opened mid-run has watched exactly one scene.
 * - **The milestone ladder.** `state.milestones` is recomputed each round by the
 *   real graders against the whole trace, so `went-six-floors-down` being
 *   reached is authoritative even for the fifty rounds nobody was watching. It
 *   is coarse — a threshold, not a count — which makes it a *lower bound*.
 *
 * Taking the larger of the two is right in both directions: a fresh page gets
 * the ladder's bound, and a page that has been open all run gets the exact
 * count as soon as it exceeds the last threshold crossed.
 */
function makeTally(): Tally {
  let startFloor: number | null = null;
  let deepest = 0;
  let bosses = 0;
  let falls = 0;
  /** ref → was it a boss, from the last scene it was alive in. */
  const known = new Map<string, boolean>();
  /** The tick whose `beats` have already been counted. See `watch`. */
  let counted: number | null = null;
  let seen: Scene | null = null;

  return {
    /** A different run under the same name must not inherit the last one's counts. */
    reset() {
      startFloor = null;
      deepest = 0;
      bosses = 0;
      falls = 0;
      known.clear();
      counted = null;
      seen = null;
    },

    watch(scene, before) {
      if (!scene) return;
      const floor = Number(scene.floor) || 0;
      if (startFloor === null || floor < startFloor) startFloor = floor;
      if (floor > deepest) deepest = floor;

      for (const e of scene.enemies ?? []) known.set(e.ref, !!e.boss);

      // A `state` event is written after every *turn* that changed the world, so
      // one round produces five scenes carrying the same `beats` — the round
      // that last resolved. Counting per tick rather than per scene is what
      // stops one dead boss being counted five times.
      const tick = Number(scene.tick) || 0;
      if (tick !== counted) {
        counted = tick;
        // A boss that died is already gone from `enemies`, so whether the ref
        // was a boss can only come from the map of everything seen alive.
        for (const beat of scene.beats ?? []) {
          if (beat?.kind === "death" && beat.to && known.get(beat.to)) {
            bosses += 1;
            known.set(beat.to, false);
          }
        }
      }

      // Party state, unlike beats, does change between turns — an out-of-combat
      // potion or a revive lands the moment the tool is called — so this is
      // diffed on every scene. A false→true flip can only happen once per fall.
      const was = new Map<ClassId, ScenePartyMember>((before?.party ?? []).map((p) => [p.id, p]));
      for (const member of scene.party ?? []) {
        const prior = was.get(member.id);
        if (member.dead && prior && !prior.dead) falls += 1;
      }
      seen = scene;
    },

    /** The fused figures, given the ladder as a second opinion. */
    read(scene, milestones) {
      const reached = new Set((milestones ?? []).filter((m) => m.reached).map((m) => m.id));
      const known_ = (milestones ?? []).length > 0;

      let floors = startFloor === null ? 0 : Math.max(0, deepest - startFloor);
      if (reached.has("went-six-floors-down")) floors = Math.max(floors, 6);
      else if (reached.has("went-three-floors-down")) floors = Math.max(floors, 3);
      else if (reached.has("cleared-a-floor")) floors = Math.max(floors, 1);

      let killed = bosses;
      if (reached.has("put-down-a-boss")) killed = Math.max(killed, 1);

      const down = (scene?.party ?? []).filter((p) => p.dead).length;
      let deaths = Math.max(falls, down);
      // `nobody-was-left-behind` is `permanentDeaths at_most 0`, so it is true
      // from round one and only ever goes false. Its absence is a real signal.
      if (known_ && !reached.has("nobody-was-left-behind")) deaths = Math.max(deaths, 1);

      return { floors, bosses: killed, deaths, down, seen };
    },
  };
}

/** A past run whose score is known, which is the only kind that can be ranked. */
type ScoredRun = RunRecord & { score: number };

/** A run that never finished scoring has a null score; this rules those out. */
function isScored(run: RunRecord): run is ScoredRun {
  return typeof run.score === "number";
}

/**
 * The best score this run is chasing, which must not be this run.
 *
 * `/history` reads every trace on disk including the one being appended to
 * right now, so `history.best` is frequently the live run and the comparison
 * would sit pinned at 100% for fifty minutes. `RunRecord.file` is a basename
 * and `state.file` is package-relative, so the current run is identifiable and
 * removable; `history.best` stays the fallback for the case where `runs` is
 * missing or the file cannot be matched.
 */
function bestElsewhere(s: BroadcastState): ScoredRun | null {
  const mine = String(s.file ?? "").split("/").pop();
  const runs = s.history?.runs ?? [];
  let best: ScoredRun | null = null;
  for (const run of runs) {
    if (!run || !isScored(run)) continue;
    if (mine && run.file === mine) continue;
    if (!best || run.score > best.score) best = run;
  }
  if (best) return best;
  const fallback = s.history?.best;
  if (fallback && isScored(fallback) && fallback.file !== mine) return fallback;
  return null;
}

/** One headline tile: the box, which gets tinted, and the figure inside it. */
interface TileHandle {
  box: HTMLElement;
  value: HTMLElement;
}

/** One rung of the milestone ladder: the row, which lights up, and its points cell. */
interface RungHandle {
  node: HTMLElement;
  pts: HTMLElement;
}

function buildProgress(host: HTMLElement): (s: BroadcastState, tally: Tally) => void {
  const root = el("div", "hud-stack hud-progress");

  // -- rounds ---------------------------------------------------------------
  const rounds = el("div", "hud-block");
  const roundHead = el("div", "hud-row");
  const roundNum = el("div", "hud-big");
  roundHead.append(el("span", "k", "The clock"), roundNum);
  const roundBar = el("div", "meter hud-tall");
  const roundFill = el("i");
  roundFill.style.background = "var(--dim)";
  roundBar.appendChild(roundFill);
  rounds.append(roundHead, roundBar);

  // -- chasing the record ---------------------------------------------------
  const record = el("div", "hud-block");
  const recordHead = el("div", "hud-row");
  const crown = el("span", "hud-tag hud-crown", "RECORD");
  recordHead.append(el("span", "k", "Chasing the record"), crown);
  const recordBar = el("div", "meter hud-tall hud-record");
  const recordFill = el("i", "xp");
  const notch = el("div", "hud-notch");
  recordBar.append(recordFill, notch);
  const recordFoot = el("div", "hud-recordfoot");
  const nowXp = el("span", "num");
  const bestXp = el("span", "num");
  recordFoot.append(nowXp, bestXp);
  record.append(recordHead, recordBar, recordFoot);

  // -- headline numbers -----------------------------------------------------
  const tiles = el("div", "hud-tiles hud-block");
  const tile = (label: string): TileHandle => {
    const box = el("div", "hud-tile");
    const value = el("b", "v", "0");
    box.append(value, el("span", "k", label));
    tiles.appendChild(box);
    return { box, value };
  };
  const tXp = tile("earned");
  const tFloors = tile("floors");
  const tBosses = tile("bosses");
  const tDeaths = tile("deaths");

  // -- the milestone ladder -------------------------------------------------
  const ladderHead = el("div", "hud-row hud-block");
  const ladderCount = el("div", "hud-big");
  ladderHead.append(el("span", "k", "Milestones"), ladderCount);
  const ladder = el("div", "hud-ladder");
  const empty = el("div", "empty", "No milestones scored yet.");
  ladder.appendChild(empty);

  root.append(rounds, record, tiles, ladderHead, ladder);
  host.appendChild(root);

  /** id → row, so the ladder is built once and only its classes change. */
  const rungs = new Map<string, RungHandle>();
  const wasReached = new Set<string>();
  let frontierAt = -1;
  let first = true;

  return function renderProgress(s, tally) {
    const scene = s.scene;
    const d = derive(scene);

    const tick = Number(scene?.tick) || 0;
    const horizon = Number(scene?.horizon) || Number(s.rounds) || 0;
    text(roundNum, horizon ? `${tick} of ${horizon}` : `${tick}`);
    roundFill.style.transform = `scaleX(${d ? d.progress : ratio(tick, horizon)})`;

    const earned = Number(scene?.earnedXp) || 0;
    const best = bestElsewhere(s);
    const bestScore = best?.score ?? 0;
    const ceiling = Math.max(earned, bestScore, 1);
    recordFill.style.transform = `scaleX(${ratio(earned, ceiling)})`;
    notch.style.display = bestScore > 0 ? "" : "none";
    notch.style.left = `${ratio(bestScore, ceiling) * 100}%`;
    text(nowXp, `${commas(earned)} xp`);
    text(bestXp, bestScore > 0 ? `best ${commas(bestScore)}` : "no run to beat");
    const ahead = bestScore > 0 && earned >= bestScore;
    crown.style.display = bestScore > 0 ? "" : "none";
    flag(crown, "new", ahead);
    text(crown, ahead ? "AHEAD OF THE RECORD" : `${Math.round(ratio(earned, bestScore) * 100)}% OF IT`);

    const counts = tally.read(scene, s.milestones);
    text(tXp.value, commas(earned));
    text(tFloors.value, String(counts.floors));
    text(tBosses.value, String(counts.bosses));
    text(tDeaths.value, String(counts.deaths));
    flag(tBosses.box, "won", counts.bosses > 0);
    flag(tDeaths.box, "alarm", counts.down > 0);

    const list = s.milestones ?? [];
    empty.style.display = list.length ? "none" : "";
    if (!list.length) return;

    // Points live on the `run` event and reached-ness on `progress`; joining
    // them here is what lets the ladder show what a rung is actually worth
    // instead of counting all fifteen as equals.
    const points = new Map<string, number>((s.run?.milestones ?? []).map((m) => [m.id, m.points ?? 0]));

    let got = 0;
    let scored = 0;
    let total = 0;
    let frontier = -1;

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      let row = rungs.get(m.id);
      if (!row) {
        const node = el("div", "hud-rung");
        const mark = el("i", "mk");
        const name = el("div", "nm", humanise(m.id));
        const pts = el("div", "pt");
        node.append(mark, name, pts);
        ladder.appendChild(node);
        row = { node, pts };
        rungs.set(m.id, row);
      }
      const worth = points.get(m.id) ?? 0;
      total += worth;
      text(row.pts, worth ? `${worth}` : "");
      flag(row.node, "got", !!m.reached);
      if (m.reached) {
        got += 1;
        scored += worth;
        // A rung that lit up between two renders is worth a beat of attention;
        // the whole ladder lighting up on first paint is not.
        if (!wasReached.has(m.id)) {
          wasReached.add(m.id);
          if (!first) {
            row.node.classList.remove("lit");
            void row.node.offsetWidth;
            row.node.classList.add("lit");
          }
        }
      } else if (frontier < 0) {
        frontier = i;
      }
      flag(row.node, "next", !m.reached && frontier === i);
    }

    text(ladderCount, total ? `${got}/${list.length} · ${scored} of ${total} pts` : `${got}/${list.length}`);

    // Keep the next unreached rung in view, and only move when it changes, so
    // the ladder is not scrolling under the viewer twice a second.
    if (frontier >= 0 && frontier !== frontierAt) {
      frontierAt = frontier;
      const node = rungs.get(list[frontier].id)?.node;
      if (node) {
        const top = node.offsetTop - (ladder.clientHeight - node.offsetHeight) / 2;
        ladder.scrollTo({ top: Math.max(0, top), behavior: first || stillness() ? "auto" : "smooth" });
      }
    }
    first = false;
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Build the three panels and hand back the renderer the page drives.
 *
 * Everything below the setup lines is defensive in one specific way: `state.scene`
 * is null until the run's first `state` event, which for a `watch` started
 * before its run can be minutes, and a HUD that threw there would take its two
 * siblings' panels down with it on every poll for those minutes. Each panel has
 * a calm empty state and every read of the scene is optional.
 */
export function mountHud(hosts: { party: HTMLElement; map: HTMLElement; progress: HTMLElement }): Renderer {
  const { party, map, progress } = hosts;
  installStyles();

  const renderParty = party ? buildParty(party) : null;
  const renderActiveCharacter = party ? buildActiveCharacter(party) : null;
  const renderMap = map ? buildMap(map) : null;
  const renderProgress = progress ? buildProgress(progress) : null;

  const tally = makeTally();
  /** The scene identity last drawn, which is how a real round is told from a poll. */
  let drawn: Scene | null | undefined;
  /** The `run` event last seen; a different one is a different run. */
  let lastRun: BroadcastState["run"] = null;

  return function render(s) {
    // `state.js` clears the store when the trace it is reading gets shorter — a
    // second run under the same name. The counters here are the only state in
    // this module that outlives a scene, so they are the only thing that has to
    // be told about it.
    const scene = s.scene ?? null;
    if (s.run !== lastRun) {
      lastRun = s.run;
      tally.reset();
      drawn = undefined;
    }
    if (scene && drawn && Number(scene.tick) < Number(drawn.tick)) {
      tally.reset();
      drawn = undefined;
    }

    const fresh = scene !== drawn;
    if (fresh) {
      tally.watch(scene, s.previous ?? null);
      // `state.previous` is the scene before this one and is only a meaningful
      // diff at the moment the scene changes — which is exactly here.
      renderParty?.(scene, s.previous ?? null);
      renderMap?.(scene);
      drawn = scene;
    }
    // Agent speech and tool calls can change the active character between
    // authoritative scene snapshots, so this detail view is intentionally not
    // scene-gated.
    renderActiveCharacter?.(s);

    // The progress panel is not scene-gated: milestones arrive on their own
    // event and the scoreboard refreshes on a twenty-second timer, so it has
    // reasons to change on frames where nothing in the dungeon moved.
    renderProgress?.(s, tally);
  };
}
