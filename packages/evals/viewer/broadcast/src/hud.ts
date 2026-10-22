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

import { type BeatTally, beatTallies, shieldedRefs } from "./happenings.js";
import { insetPercent, insetViewBox, planFloor, roomGates } from "./floorplan.js";
import { MARQUEE_CSS, rove } from "./marquee.js";
import {
  CATEGORY,
  type Category,
  type MarkName,
  isMark,
  itemCategory,
  itemTitle,
  mark,
  remark,
  slotMark,
  statusMark,
  statusShort,
  statusTitle,
  statusTone,
} from "./marks.js";
import { revealedTraitors } from "./reveal.js";
import { derive } from "./state.js";
import type {
  BroadcastState,
  ClassId,
  Milestone,
  Phase,
  Renderer,
  RunRecord,
  Scene,
  SceneEnemy,
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
 * The shapes live in `marks.ts` now, because three panels and a feed all had to
 * agree about what a sword looks like and two copies of that table is one copy
 * too many. What stays here is the mapping from *this* panel's vocabulary —
 * readied actions, ways out of a junction — onto those shapes.
 */

/** Which glyph a readied action gets. Anything unlisted falls back to `strike`. */
const ACTION_GLYPH = new Map<string, MarkName>(
  Object.entries<MarkName>({
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

/** The three slots the simulation equips, in the order the rail draws them. */
const SLOTS = ["weapon", "armor", "trinket"] as const;

/**
 * A drop of health, as a number rather than as a shorter bar.
 *
 * `−143` and `0 · immune to fire` are the same shape of fact and a bar can
 * carry neither: the bar says "worse", the tick says by how much and, when the
 * answer is "not at all", says why. Everything it prints comes out of the
 * round's beats, which is the record the simulation writes at the point it
 * applies each blow.
 */
function tickText(tally: BeatTally | undefined): { text: string; tone: string } | null {
  if (!tally) return null;
  if (tally.damage > 0) return { text: `−${Math.round(tally.damage)}`, tone: "" };
  if (tally.wasted) return { text: `— ${tally.wasted}`, tone: "blank" };
  if (tally.blanks > 0) return { text: `0 · ${tally.reason ?? "nothing landed"}`, tone: "blank" };
  if (tally.healed > 0) return { text: `+${Math.round(tally.healed)}`, tone: "mend" };
  return null;
}

/** Restart a one-shot animation on a node that may still be running the last one. */
function replay(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

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
  font: 700 12px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase;
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

/* A revealed traitor. Audience-only — nothing in the run can see this, and the
   page is a pure reader — so it is free to be loud.

   Three redundant signals for the same reason the dead card has three: at streaming
   bitrates a colour shift alone does not survive, and a viewer who cannot
   separate flame from ink gets nothing from it. Edge, ground, and a dagger in
   front of the name. */
.hud-card.traitor {
  border-color: var(--flame-dim);
  background: color-mix(in srgb, var(--flame) 8%, var(--panel-2));
}
.hud-card.traitor::after {
  content: ""; position: absolute; inset: 0 auto 0 0; width: 3px;
  background: var(--flame);
}
.hud-card.traitor .hud-who::before { content: "\\2020\\00a0"; color: var(--flame); }
.hud-card.traitor .hud-persona { color: color-mix(in srgb, var(--flame) 65%, var(--dim)); }

/* Dead is dimmed AND dashed AND labelled: three signals, because at streaming
   bitrates a 40% opacity difference is not one. */
.hud-card.dead { opacity: .42; border-style: dashed; border-top-color: var(--faint); }
.hud-card.active { box-shadow: 0 0 0 1px var(--who), 0 8px 20px -14px var(--who); }

.hud-who {
  font: 800 15px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase;
  color: var(--who); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-card.dead .hud-who { color: var(--dim); }
.hud-persona {
  min-height: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 11px/1.2 var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: .04em;
}

.hud-gold {
  display: flex; align-items: center; gap: 3px;
  font: 14px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--gold);
}
.hud-gold svg { width: 11px; height: 11px; opacity: .85; flex: 0 0 auto; }

.hud-barline { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 3px; }
.hud-barline .num { font-size: 14px; }
.hud-barline .num.low { color: var(--bad); }

.hud-mana { display: block; }
.hud-mana.off { display: none; }

.hud-chips { display: flex; flex-wrap: wrap; gap: 3px; min-height: 15px; align-content: flex-start; }
.hud-chip {
  display: inline-flex; align-items: center; gap: 3px;
  font: 700 12px/1 var(--mono); letter-spacing: .04em;
  padding: 2px 4px; border-radius: 3px; white-space: nowrap;
  background: rgba(217, 86, 79, .14); color: #f0938d; border: 1px solid rgba(217, 86, 79, .3);
}
.hud-chip.boon { background: rgba(95, 185, 138, .13); color: var(--good); border-color: rgba(95, 185, 138, .3); }
.hud-chip b { font-weight: 700; opacity: .7; }

/*
 * The kit rail: three slots, then whatever they have learned.
 *
 * This replaced a truncated sentence. \`W:Ashen Blade · Bastion 2 · 1 SP\` was
 * accurate and unreadable — it ellipsised inside the first item's name on every
 * card, so the two facts a party strip is actually scanned for (is anybody
 * unarmed, has anybody a point they have not spent) were the two that never
 * survived the cut. A fixed-width shape per slot means the five cards can be
 * compared by looking across them rather than by reading five sentences.
 */
.hud-kit { display: flex; align-items: center; gap: 3px; min-height: 19px; flex-wrap: nowrap; overflow: hidden; }
.hud-kit-cell {
  position: relative; display: grid; place-items: center; flex: 0 0 auto;
  width: 18px; height: 18px; border-radius: 4px;
  border: 1px solid var(--line); background: #0b1017; color: var(--faint);
}
/* An empty slot is drawn, not omitted. A missing weapon has to read as a hole
   in the row rather than as a slightly shorter row. */
.hud-kit-cell.slot { border-style: dashed; opacity: .55; }
.hud-kit-cell.slot.on { border-style: solid; opacity: 1; color: var(--gold); border-color: rgba(217, 180, 92, .45); }
.hud-kit-cell.slot.on[data-rarity="rare"], .hud-kit-cell.slot.on[data-rarity="epic"] {
  color: var(--arcane); border-color: rgba(123, 143, 245, .55);
}
.hud-kit-cell.carried { opacity: .55; }
.hud-kit-cell.carried.on { opacity: 1; color: var(--dim); }
.hud-kit-cell.carried.drinkable { color: var(--cat-consumable); border-color: color-mix(in srgb, var(--cat-consumable) 40%, var(--line)); }
.hud-kit-cell.talent { color: var(--who); border-color: color-mix(in srgb, var(--who) 40%, var(--line)); }
.hud-kit-cell.cooling { color: var(--faint); }
.hud-kit-cell.unspent { color: var(--warn); border-color: rgba(224, 176, 64, .5); background: rgba(224, 176, 64, .1); }
.hud-kit-cell i {
  position: absolute; right: -1px; bottom: -2px;
  font: 700 11px/1 var(--mono); font-style: normal; color: var(--ink);
  background: var(--panel-2); border-radius: 2px; padding: 0 1px;
}
.hud-kit-cell i:empty { display: none; }

/* The round's damage, on the line with the health total it explains. */
.hud-barline .tick { margin-left: auto; margin-right: 6px; font-size: 13px; }
.hud-barline .tick.blank { font-size: 12px; letter-spacing: .02em; }

.hud-active {
  margin-top: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--active-who, var(--flame)) 8%, transparent), transparent 45%), #0d121b;
  display: grid; grid-template-columns: 150px minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr); gap: 10px;
  min-height: 126px; max-height: 174px; overflow: hidden;
}
.hud-active[data-who="guardian"] { --active-who: var(--guardian); }
.hud-active[data-who="mage"]     { --active-who: var(--mage); }
.hud-active[data-who="rogue"]    { --active-who: var(--rogue); }
.hud-active[data-who="cleric"]   { --active-who: var(--cleric); }
.hud-active[data-who="ranger"]   { --active-who: var(--ranger); }
.hud-activehead { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.hud-activename { color: var(--active-who); font: 800 14px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; }
.hud-statgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 7px; }
.hud-stat { padding: 4px; border: 1px solid rgba(35, 44, 61, .7); border-radius: 4px; }
.hud-stat b { display: block; color: var(--ink); font: 700 13px/1 var(--mono); }
.hud-stat span { display: block; margin-top: 3px; color: var(--faint); font: 700 10px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; }
.hud-detailcol { min-width: 0; overflow: hidden; }
.hud-detaillabel { margin-bottom: 5px; color: var(--faint); font: 700 11px/1 var(--sans); letter-spacing: .13em; text-transform: uppercase; }
.hud-itemline, .hud-skillline {
  display: flex; align-items: baseline; gap: 5px; min-width: 0; margin-bottom: 4px;
  font: 12px/1.2 var(--mono); color: var(--dim);
}
.hud-itemline b, .hud-skillline b { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-itemline .slot, .hud-itemline .rarity {
  flex: 0 0 auto; padding: 2px 3px; border: 1px solid var(--line); border-radius: 3px;
  color: var(--faint); font: 700 10px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
}
.hud-itemline .rarity.rare, .hud-itemline .rarity.epic { color: var(--arcane); border-color: rgba(123, 143, 245, .5); }
.hud-itemline .cat { flex: 0 0 auto; align-self: center; }
.hud-affixes { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); }
.hud-affixes .bad { color: var(--bad); }
.hud-detail-empty { color: var(--faint); font: 12px/1.3 var(--sans); }
.hud-bioline {
  margin-bottom: 4px; color: var(--dim); font: 12px/1.25 var(--sans);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud-traits { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 6px; margin-top: 5px; }
.hud-traitline {
  min-width: 0; color: var(--faint); font: 11px/1.15 var(--mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud-traitline b { color: var(--ink); margin-left: 3px; }
.hud-goalline {
  margin-top: 6px; padding: 4px 5px; border-left: 2px solid var(--active-who);
  background: color-mix(in srgb, var(--active-who) 7%, transparent);
  color: var(--dim); font: 11px/1.25 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud-goalline.done { color: var(--good); border-left-color: var(--good); }

/* Run-opening cast reveal and end recap. It is an observer-only overlay and
   never writes anything back to the simulation. */
.hud-cast-reveal {
  position: fixed; z-index: 100; inset: 54px 12px 12px; padding: 22px;
  display: none; flex-direction: column; justify-content: center; gap: 16px;
  background: radial-gradient(circle at 50% 25%, rgba(45, 57, 79, .97), rgba(7, 10, 16, .985) 68%);
  border: 1px solid var(--flame-dim); border-radius: 12px; box-shadow: 0 24px 80px #000;
}
.hud-cast-reveal.on { display: flex; }
.hud-cast-head { display: flex; align-items: end; justify-content: space-between; gap: 20px; }
.hud-cast-title { color: var(--flame); font: 800 25px/1 var(--sans); letter-spacing: .13em; text-transform: uppercase; }
.hud-cast-sub { margin-top: 7px; color: var(--dim); font: 14px/1.4 var(--sans); }
.hud-cast-close {
  border: 1px solid var(--line); border-radius: 4px; padding: 6px 9px; background: var(--panel-2);
  color: var(--dim); font: 700 12px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; cursor: pointer;
}
.hud-cast-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
.hud-cast-card {
  --cast-who: var(--flame); min-width: 0; padding: 13px; border: 1px solid var(--line); border-top: 3px solid var(--cast-who);
  border-radius: 8px; background: rgba(17, 22, 33, .94); opacity: 1; transform: none;
  animation: hud-cast-in .48s ease-out forwards; animation-delay: var(--cast-delay, 0ms);
}
.hud-cast-card[data-who="guardian"] { --cast-who: var(--guardian); }
.hud-cast-card[data-who="mage"] { --cast-who: var(--mage); }
.hud-cast-card[data-who="rogue"] { --cast-who: var(--rogue); }
.hud-cast-card[data-who="cleric"] { --cast-who: var(--cleric); }
.hud-cast-card[data-who="ranger"] { --cast-who: var(--ranger); }
.hud-cast-name { color: var(--cast-who); font: 800 18px/1 var(--sans); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-cast-class { margin-top: 5px; color: var(--faint); font: 700 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.hud-cast-appearance { height: 49px; margin-top: 12px; color: var(--dim); font: 13px/1.45 var(--sans); overflow: hidden; }
.hud-cast-traits { margin-top: 11px; display: flex; flex-direction: column; gap: 5px; }
.hud-cast-trait { display: grid; grid-template-columns: 76px 1fr 22px; align-items: center; gap: 5px; color: var(--faint); font: 11px/1 var(--mono); }
.hud-cast-trait i { display: block; height: 4px; border-radius: 2px; background: #090d14; overflow: hidden; }
.hud-cast-trait i::after { content: ""; display: block; width: var(--trait); height: 100%; background: var(--cast-who); }
.hud-cast-aim, .hud-cast-goal { margin-top: 12px; color: var(--ink); font: 12px/1.35 var(--sans); }
.hud-cast-goal { color: var(--faint); border-top: 1px solid var(--line); padding-top: 8px; }
.hud-cast-goal.done { color: var(--good); }
@keyframes hud-cast-in { from { transform: translateY(10px); } to { transform: none; } }

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
  font: 800 13px/1 var(--sans); letter-spacing: .08em; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hud-ready .at {
  font: 12px/1 var(--mono); color: var(--dim);
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

/* ---- 1b. the other side of the room ------------------------------------ */

/*
 * Enemy nameplates, above the party and never rotated away.
 *
 * Everything about this block says "not us": a colder ground, a hard left edge
 * in the enemy category colour, square corners against the party cards' rounded
 * ones, and the enemy silhouette at the head of every row. A viewer who has
 * looked at the strip once should never have to check again which half of the
 * panel is which.
 */
.hud-foes { margin-bottom: 8px; }
.hud-foes-head {
  display: flex; align-items: center; gap: 6px; margin-bottom: 5px;
  color: var(--cat-enemy);
}
.hud-foes-head .k { color: var(--cat-enemy); }
.hud-foes-head .n { font: 700 13px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.hud-foes-head::after { content: ""; flex: 1; height: 1px; background: color-mix(in srgb, var(--cat-enemy) 30%, transparent); }

/* Every class below is hud-prefixed, and the plates are the reason it matters:
   an earlier draft called the name row \`.top\`, which is the page header's own
   class in style.css, so each plate quietly inherited the header's padding and
   its bottom rule. */
.hud-foelist { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 5px; }
.hud-foe {
  display: flex; align-items: flex-start; gap: 7px; min-width: 0;
  padding: 5px 8px 6px; background: #0c1016;
  border: 1px solid var(--line); border-left: 3px solid var(--cat-enemy); border-radius: 0 5px 5px 0;
  color: var(--cat-enemy);
}
.hud-foe-body { flex: 1; min-width: 0; }
.hud-foe-top { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
.hud-foe-name {
  font: 700 14px/1.1 var(--sans); color: var(--ink);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.hud-foe-top .rank { flex: 0 0 auto; padding: 2px 4px; }
.hud-foe-top .tick { margin-left: auto; }
.hud-foe-top .num { flex: 0 0 auto; font-size: 13px; color: var(--dim); }
.hud-foe-bot { display: flex; align-items: center; gap: 6px; }
.hud-foe-bot:not(:empty) { margin-top: 4px; }
.hud-foe-bot .hud-chips { min-height: 0; flex: 0 1 auto; }
.hud-foe-tell {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 12px/1.2 var(--mono); color: var(--warn); text-transform: uppercase; letter-spacing: .06em;
}
.hud-foe[data-rank="elite"] { border-left-width: 4px; }
.hud-foe[data-rank="boss"] {
  border-left-width: 5px; border-color: var(--bad);
  background: linear-gradient(90deg, rgba(217, 86, 79, .12), #0c1016 55%);
}
.hud-foe[data-rank="boss"] .rank, .hud-foe[data-rank="elite"] .rank { color: var(--bad); border-color: var(--bad); }
.hud-foe.telegraph { border-top-color: var(--warn); box-shadow: inset 0 1px 0 var(--warn); }
.hud-foe.slain { opacity: .4; border-left-style: dashed; }
.hud-foe.slain .hud-foe-name { text-decoration: line-through; color: var(--dim); }

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
  font: 14px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--faint);
}
.hud-floor::before {
  content: ""; position: absolute; left: -16px; top: 50%; margin-top: -3px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--line);
}
.hud-floor.cleared { color: var(--dim); }
.hud-floor.cleared::before { background: var(--faint); }
.hud-floor .lbl { font: 12px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; }
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
.hud-floorno span { font: 600 12px/1 var(--sans); letter-spacing: .18em; color: var(--faint); margin-right: 6px; }
.hud-here .hud-tag.boss { color: var(--bad); border-color: var(--bad); }

.hud-floorgraph { margin-top: 7px; }
.hud-zone {
  margin-bottom: 3px; font: 700 12px/1 var(--sans); letter-spacing: .13em;
  text-transform: uppercase; color: var(--flame);
}
/* Taller than it was, because the map no longer rotates away and the left
   column now gives it a fixed share rather than a turn. */
.hud-graphcanvas { position: relative; height: 232px; border-radius: 6px; background: rgba(8, 12, 18, .52); }
.hud-graphcanvas[data-environment="flooded"] { background: radial-gradient(circle at 50% 100%, rgba(55, 128, 170, .24), transparent 66%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="spore-cloud"] { background: radial-gradient(circle at 20% 30%, rgba(104, 145, 73, .2), transparent 52%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="arcane-well"] { background: radial-gradient(circle at 50% 50%, rgba(128, 84, 190, .22), transparent 58%), rgba(8, 12, 18, .62); }
.hud-graphcanvas[data-environment="narrow-bridge"] { background: linear-gradient(90deg, rgba(8, 12, 18, .7) 34%, rgba(172, 127, 68, .13) 50%, rgba(8, 12, 18, .7) 66%); }
.hud-graphcanvas[data-environment="high-ground"] { background: linear-gradient(180deg, rgba(190, 203, 216, .13), transparent 55%), rgba(8, 12, 18, .62); }
/*
 * Corridors, in plan units, stretched to the box.
 *
 * preserveAspectRatio=none plus vector-effect:non-scaling-stroke is the
 * pair that makes this work: the geometry is free to stretch so it lines up
 * with the HTML room nodes positioned by percentage, while every corridor keeps
 * the same weight on screen instead of being squashed thin in one axis.
 */
.hud-graphedges { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.hud-graphedges polyline {
  fill: none; stroke: var(--line); stroke-width: 1.5;
  stroke-linejoin: round; stroke-linecap: round; vector-effect: non-scaling-stroke;
}
/* Kind is carried by dash pattern first and colour second, so the map survives
   a re-encoded stream that has eaten the difference between gold and amber. */
.hud-graphedges polyline[data-kind="one-way"] { stroke: var(--flame); stroke-dasharray: 5 4; marker-end: url(#hud-route-arrow); }
.hud-graphedges polyline[data-kind="secret"] { stroke: var(--arcane); stroke-dasharray: 1 4; }
.hud-graphedges polyline[data-kind="trap"] { stroke: var(--bad); stroke-dasharray: 6 2 1 2; }
/* Armed, spent, made safe. A trap already sprung is not a threat and must not
   keep reading as one; a disarmed one is somebody's four-point achievement. */
.hud-graphedges polyline[data-kind="trap"][data-state="spent"] { stroke: var(--faint); stroke-dasharray: 2 4; }
.hud-graphedges polyline[data-kind="trap"][data-state="disarmed"] { stroke: var(--good); stroke-dasharray: none; }
.hud-graphedges polyline[data-kind="locked"] { stroke: var(--gold); stroke-width: 3; stroke-dasharray: 2 3; }
.hud-graphedges polyline[data-kind="toll"] { stroke: var(--gold); stroke-width: 2.5; stroke-dasharray: 8 3; }
.hud-graphedges polyline[data-opened="true"] { stroke: var(--dim); stroke-width: 1.5; stroke-dasharray: none; }
/* A way nobody has found. Last rule, so it wins over every kind above: what
   matters about an undiscovered corridor is that it is undiscovered, not that
   it happens to be a locked door. */
.hud-graphedges polyline[data-found="no"] {
  stroke: color-mix(in srgb, var(--faint) 40%, transparent); stroke-width: 1;
  stroke-dasharray: 1 5; marker-end: none;
}
.hud-roomnode {
  position: absolute; z-index: 1; width: 28px; height: 28px; margin: -14px 0 0 -14px;
  display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--line);
  background: var(--ground); color: var(--faint); font: 800 12px/1 var(--mono);
}
/*
 * The room's name, under the room.
 *
 * Shown for the four kinds of room a viewer is ever actually looking for —
 * where the party is, where something is still alive, the way down, and an
 * uncollected key — rather than for the one they are standing in. Naming every
 * room would overrun the cell; naming only the current one meant the map could
 * not answer "which of these is the one with the enemies in it" without a
 * hover, which is not a question you can ask of a stream.
 */
/*
 * The room's name, under every room.
 *
 * Names used to show for four kinds of room and nothing else, so most of the
 * floor was an unlabelled circle with a symbol in it and the only way to learn
 * what anything was called was to hover — which is not a thing you can do to a
 * stream, and not a thing a viewer should have to do to read a map.
 *
 * Width is set per floor from the plan's own column pitch, so a name can never
 * be wider than the column it belongs to and two names can never overlap. Two
 * lines, then ellipsis: "collapsed gallery" fits, and nothing pushes the row
 * below it out of place.
 */
.hud-roomlabel {
  position: absolute; transform: translateX(-50%); z-index: 2; pointer-events: none;
  font: 10.5px/1.2 var(--sans); text-align: center; color: var(--dim);
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  /* Break between words. The 'anywhere' value split "guardroom" mid-word the
     moment the column was tight, which is unreadable in a way an ellipsis is
     not. */
  overflow-wrap: break-word; hyphens: auto;
}
.hud-roomlabel[data-state="visited"] { color: var(--ink); }
.hud-roomlabel[data-state="current"] { color: var(--flame); font-weight: 700; }
.hud-roomlabel[data-state="scouted"] { color: color-mix(in srgb, var(--arcane) 70%, var(--dim)); }
.hud-roomlabel[data-state="edge"] { color: var(--faint); font-style: italic; }
.hud-roomlabel[data-state="unfound"] {
  color: color-mix(in srgb, var(--faint) 62%, transparent); font-style: italic;
}
/* Three states of knowledge, drawn as three different things rather than two.
   Solid: been there. Dashed arcane: seen without entering. Faint dotted: a door
   goes that way and that is the whole of what anybody knows. */
.hud-roomnode.visited { border-color: var(--dim); color: var(--ink); }
.hud-roomnode.scouted { border-style: dashed; border-color: var(--arcane); }
.hud-roomnode.edge { border-style: dotted; border-color: var(--faint); opacity: .75; }
/* A room the party has not found. Present, placed, and clearly not theirs yet —
   the audience gets to watch them walk past it. */
.hud-roomnode.unfound {
  border-style: dashed; border-color: color-mix(in srgb, var(--faint) 55%, transparent);
  background: transparent; color: color-mix(in srgb, var(--faint) 60%, transparent); opacity: .55;
}
.hud-roomnode.unfound::after { opacity: .4; }

/* A door that has not been opened yet, marked on the room it guards — because
   "can we get in there" is a question about the room, and the corridor kind is
   only where the answer happens to be stored. */
.hud-roomnode[data-gate]::before {
  position: absolute; left: -7px; top: -7px; width: 13px; height: 13px;
  display: grid; place-items: center; border-radius: 50%;
  background: var(--panel-2); border: 1px solid currentColor;
  font: 800 9px/1 var(--mono);
}
.hud-roomnode[data-gate="locked"]::before { content: "⚿"; color: var(--gold); }
.hud-roomnode[data-gate="toll"]::before { content: "$"; color: var(--gold); }
.hud-roomnode[data-gate="secret"]::before { content: "?"; color: var(--arcane); }
.hud-roomnode.cleared { background: #18212d; }
.hud-roomnode.occupied {
  border-color: var(--bad); color: var(--bad);
  box-shadow: 0 0 0 4px rgba(220, 75, 75, .12);
}
.hud-roomnode.current { border: 2px solid var(--flame); color: var(--flame); box-shadow: 0 0 0 4px rgba(240, 160, 75, .12); }
.hud-roomnode[data-kind="boss"], .hud-roomnode[data-kind="elite"] { color: var(--bad); }
.hud-roomnode[data-kind="market"] { color: var(--gold); }
.hud-roomnode[data-kind="shrine"] { color: var(--arcane); }
.hud-roomnode.key { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(221, 182, 88, .1); }
.hud-roomnode[data-kind="stairs"] { color: var(--good); }
.hud-roomnode[data-environment]::after {
  position: absolute; right: -6px; top: -6px; min-width: 11px; height: 11px;
  display: grid; place-items: center; border-radius: 50%; background: var(--panel-2);
  font: 800 11px/1 var(--mono); color: var(--ink); border: 1px solid var(--line);
}
.hud-roomnode[data-environment="flooded"]::after { content: "≈"; color: #69b8e5; }
.hud-roomnode[data-environment="spore-cloud"]::after { content: "✺"; color: #91bc6c; }
.hud-roomnode[data-environment="arcane-well"]::after { content: "✧"; color: var(--arcane); }
.hud-roomnode[data-environment="narrow-bridge"]::after { content: "‖"; color: var(--gold); }
.hud-roomnode[data-environment="high-ground"]::after { content: "▲"; color: #c3d0dd; }

/*
 * The legend.
 *
 * Every swatch in it is built from the map's own classes, so the two cannot
 * disagree — and it lists only what this floor actually contains, because a
 * fixed legend naming six corridor kinds on a floor with two is six rows to
 * read past before reaching the two that matter.
 */
.hud-key {
  display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 8px;
  padding-top: 7px; border-top: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
}
.hud-keychip {
  display: inline-flex; align-items: center; gap: 5px;
  font: 10px/1 var(--mono); letter-spacing: .04em; color: var(--faint); white-space: nowrap;
}
/* Overrides for a swatch: same classes, smaller, and out of the absolute
   positioning the map puts every room node into. */
.hud-roomnode.hud-keydot {
  position: static; width: 15px; height: 15px; margin: 0; flex: 0 0 auto;
  font-size: 8px; box-shadow: none;
}
.hud-roomnode.hud-keydot.current { border-width: 1.5px; }
/*
 * Border *style* is the whole distinction these three rows are drawing, and at
 * 13px with a 1px stroke it does not survive: a dotted border around a circle
 * that small antialiases into an even ring, so the swatch for "a door leads
 * there — unseen" rendered as a plain filled dot, which is the one thing it
 * does not mean. Dots need arc length and stroke width to read as dots.
 *
 * The swatch is still built from the map's own classes — only its scale
 * differs, and its scale already differed. What is deliberately *not* copied is
 * the full fade: on the map, fainter means less known and the gradient is the
 * information. In a 15px swatch the same opacity is just illegible, so these
 * keep enough of it to rank against each other and no more.
 */
.hud-roomnode.hud-keydot.scouted,
.hud-roomnode.hud-keydot.edge,
.hud-roomnode.hud-keydot.unfound { border-width: 2px; }
.hud-roomnode.hud-keydot.edge { opacity: 1; }
.hud-roomnode.hud-keydot.unfound { opacity: .8; }
.hud-roomnode.hud-keydot::before, .hud-roomnode.hud-keydot::after { display: none; }
.hud-keyline { position: static; width: 26px; height: 6px; flex: 0 0 auto; }
.hud-keyline polyline { stroke-width: 2; }

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
  font: 700 11px/1 var(--sans); letter-spacing: .08em; text-transform: uppercase;
  color: var(--faint); font-style: normal; text-align: center;
}
.hud-stop.done i { background: var(--faint); border-color: var(--faint); }
.hud-stop.done em { color: var(--dim); }
.hud-stop.now i { background: var(--flame); border-color: var(--flame); transform: scale(1.45); }
.hud-stop.now em { color: var(--flame); }
.hud-oddphase { font: 700 13px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--flame); }

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
  font: 13px/1.25 var(--sans); color: var(--ink);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.hud-path .hint { font: 12px/1.2 var(--mono); color: var(--faint); }
.hud-path[data-kind="market"] svg { color: var(--gold); }
.hud-path[data-kind="elite"] svg { color: var(--bad); }
.hud-path[data-kind="shrine"] svg { color: var(--arcane); }
.hud-path.chosen { border-color: var(--flame); background: rgba(240, 160, 75, .1); }
.hud-path.chosen .hud-tag { color: var(--flame); border-color: var(--flame); }

.hud-scouted {
  margin-top: 8px; padding: 6px 8px; border-left: 2px solid var(--rogue);
  background: rgba(176, 111, 214, .08); font: 13px/1.35 var(--sans); color: var(--dim);
}
.hud-scouted b { color: var(--rogue); font: 700 12px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; display: block; margin-bottom: 3px; }

.hud-note { margin-top: 9px; font: 13px/1.35 var(--sans); color: var(--dim); }
.hud-note b { color: var(--ink); font-variant-numeric: tabular-nums; }

/* ---- 3. progress ------------------------------------------------------- */

.hud-progress { gap: 11px; }
.hud-block { flex: 0 0 auto; }

.hud-big { font: 800 16.5px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }

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
.hud-recordfoot .num { font-size: 14px; }
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
.hud-rung .nm { flex: 1; min-width: 0; font: 13.5px/1.3 var(--sans); color: var(--faint); }
.hud-rung .pt {
  flex: 0 0 auto; font: 13px/1.3 var(--mono); font-variant-numeric: tabular-nums; color: var(--faint);
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
  .hud-card.hurt, .hud-here.moved, .hud-rung.lit, .hud-crown.new, .hud-cast-card { animation: none; opacity: 1; transform: none; }
}
`;

/** Inject once. A second mount (a hot reload, a second page) must not duplicate the sheet. */
function installStyles() {
  if (document.getElementById("hud-styles")) return;
  const tag = el("style");
  tag.id = "hud-styles";
  tag.textContent = `${STYLES}\n${MARQUEE_CSS}`;
  document.head.appendChild(tag);
}

/** Introduce the rolled cast once, then return at the end with every motive disclosed. */
function buildCastReveal(): Renderer {
  const root = el("div", "hud-cast-reveal");
  document.body.appendChild(root);
  let run: BroadcastState["run"] = null;
  let openingShown = false;
  let recapShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  const hide = () => {
    root.classList.remove("on");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  };

  function draw(scene: Scene, recap: boolean): void {
    root.replaceChildren();
    const heading = el("div", "hud-cast-head");
    const copy = el("div");
    copy.append(
      el("div", "hud-cast-title", recap ? "Expedition recap" : "The dungeon rolls its cast"),
      el(
        "div",
        "hud-cast-sub",
        recap
          ? "The names they carried, the tendencies they wrestled with, and the motives the descent finally exposed."
          : "Five classes remain fixed. Everything that makes the people inside them belongs to this seeded run.",
      ),
    );
    const close = el("button", "hud-cast-close", recap ? "close recap" : "skip introduction");
    close.type = "button";
    close.addEventListener("click", hide);
    heading.append(copy, close);

    const grid = el("div", "hud-cast-grid");
    for (const [index, member] of (scene.party ?? []).entries()) {
      const identity = member.identity;
      const card = el("div", "hud-cast-card");
      card.dataset.who = member.id;
      card.style.setProperty("--cast-delay", `${index * 150}ms`);
      card.append(
        el("div", "hud-cast-name", identity?.displayName ?? member.id),
        el("div", "hud-cast-class", member.id),
        el("div", "hud-cast-appearance", identity?.appearance ?? "No identity recorded in this trace."),
      );
      const traits = el("div", "hud-cast-traits");
      for (const trait of identity?.traits ?? []) {
        const row = el("div", "hud-cast-trait");
        const meter = el("i");
        meter.style.setProperty("--trait", `${Math.max(1, Math.min(100, trait.score))}%`);
        row.append(el("span", null, trait.name), meter, el("b", null, String(trait.score)));
        row.title = `${trait.label} — ${trait.description}`;
        traits.appendChild(row);
      }
      card.appendChild(traits);
      card.appendChild(el("div", "hud-cast-aim", `Public aim · ${identity?.publicAspiration ?? "unknown"}`));
      const goal = identity?.secretGoal;
      const goalLabel = goal?.completed ? "Completed motive" : goal?.revealed ? "Revealed motive" : "Private motive";
      const goalText = (recap || goal?.revealed || goal?.completed) && goal?.title
        ? `${goalLabel} · ${goal.title}${
            goal.progress != null && goal.target != null ? ` · ${goal.progress}/${goal.target} ${goal.unit ?? ""}` : ""
          }`
        : "Private motive · sealed";
      card.appendChild(el("div", `hud-cast-goal${goal?.completed ? " done" : ""}`, goalText));
      grid.appendChild(card);
    }
    root.append(heading, grid);
    root.classList.add("on");
  }

  return (state) => {
    if (state.run !== run) {
      run = state.run;
      openingShown = false;
      recapShown = false;
      hide();
    }
    const scene = state.scene;
    if (!scene || !scene.party?.length) return;
    if (!openingShown && Number(scene.tick) <= 1 && !state.ended) {
      openingShown = true;
      draw(scene, false);
      hideTimer = setTimeout(hide, stillness() ? 18_000 : 14_000);
      return;
    }
    if (state.ended && !recapShown) {
      recapShown = true;
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = null;
      draw(scene, true);
    }
  };
}

// ---------------------------------------------------------------------------
// 1. The party strip
// ---------------------------------------------------------------------------

/** One status chip: the pill, its drawn shape, its four-letter name, its count. */
interface ChipHandle {
  root: HTMLElement;
  glyph: SVGSVGElement;
  label: HTMLElement;
  ticks: HTMLElement;
}

/** One cell of the kit rail: a shape, and a number under it when it has one. */
interface KitCell {
  root: HTMLElement;
  glyph: SVGSVGElement;
  note: HTMLElement;
}

/** The nodes on one member's card that ever change after the card is built. */
interface CardHandle {
  root: HTMLElement;
  who: HTMLElement;
  persona: HTMLElement;
  gold: HTMLElement;
  tick: HTMLElement;
  hpNum: HTMLElement;
  hpFill: HTMLElement;
  hpBar: HTMLElement;
  mana: HTMLElement;
  mpNum: HTMLElement;
  mpFill: HTMLElement;
  chips: HTMLElement;
  /** The chip nodes inside `chips`, held rather than re-queried — see `chips()`. */
  chipNodes: ChipHandle[];
  /** The three equipment slots, always drawn, filled or not. */
  slots: KitCell[];
  /** What is in the pack, which is the answer to "can anybody heal?". */
  pack: KitCell;
  /** Talents, cooldowns and unspent points, grown on demand. */
  kit: HTMLElement;
  kitCells: KitCell[];
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
  /** The beats tick already shown, so five scenes do not throw one sword five times. */
  let lastBeats: number | null = null;

  /** One shape with a number under it: a slot, a talent, a cooldown. */
  function cell(shape: MarkName, className: string): KitCell {
    const root = el("div", `hud-kit-cell ${className}`);
    const glyph = mark(shape, "mark sm");
    const note = el("i");
    root.append(glyph, note);
    return { root, glyph, note };
  }

  function card(id: ClassId): CardHandle {
    const root = el("div", "hud-card");
    root.dataset.who = id;

    const head = el("div", "hud-row");
    const who = el("div", "hud-who", shout(id));
    const gold = el("div", "hud-gold");
    const goldNum = el("span", null, "0");
    gold.append(mark("coin", "mark sm"), goldNum);
    head.append(who, gold);
    const persona = el("div", "hud-persona", "identity pending");

    const hpLine = el("div", "hud-barline");
    const hpNum = el("span", "num");
    const tick = el("span", "tick");
    hpLine.append(el("span", "k", "HP"), tick, hpNum);
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

    // The kit rail. Three slots, always present so an empty one reads as
    // "nothing in this hand" rather than as a shorter row, and then whatever
    // talents, cooldowns and unspent points the member has.
    const kit = el("div", "hud-kit");
    const slots = SLOTS.map((slot) => cell(slotMark(slot), `slot ${slot}`));
    for (const slotCell of slots) kit.appendChild(slotCell.root);
    const pack = cell("pack", "carried");
    kit.appendChild(pack.root);

    const ready = el("div", "hud-ready");
    const readyIcon = mark("strike");
    const lines = el("div", "lines");
    const verb = el("div", "verb", "—");
    const at = el("div", "at", "");
    lines.append(verb, at);
    ready.append(readyIcon, lines);

    root.append(head, persona, hpLine, hpBar, mana, chips, kit, ready);
    return {
      root,
      who,
      persona,
      gold: goldNum,
      tick,
      hpNum,
      hpFill,
      hpBar,
      mana,
      mpNum,
      mpFill,
      chips,
      chipNodes: [],
      slots,
      pack,
      kit,
      kitCells: [],
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
      const glyph = mark("effect", "mark sm");
      const label = el("span");
      const ticks = el("b");
      chip.append(glyph, label, ticks);
      refs.chips.appendChild(chip);
      nodes.push({ root: chip, glyph, label, ticks });
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
      flag(node.root, "boon", statusTone(kind) === "boon");
      remark(node.glyph, statusMark(kind));
      text(node.label, statusShort(kind));
      text(node.ticks, s.ticks > 0 ? `${s.ticks}` : "");
      node.root.title = statusTitle(s);
    }
  }

  /**
   * What they are wearing, what they have learned, and what is still cooling.
   *
   * One rail of small shapes rather than the truncated sentence this used to be.
   * `W:Ashen Blade · Bastion 2 · 1 SP` was accurate and unreadable: it ellipsised
   * inside the first item's name on every card, so the two facts a viewer
   * actually wants off a party strip — *is anybody unarmed* and *has anybody got
   * a point they have not spent* — were exactly the two that never survived the
   * cut. Shapes fit in a fixed width and are the same width for everyone, so the
   * five cards can be compared by scanning across rather than by reading five
   * different sentences.
   */
  function kitRail(refs: CardHandle, member: ScenePartyMember): void {
    const worn = new Map((member.worn ?? []).map((item) => [String(item.slot), item]));
    for (const [index, slot] of SLOTS.entries()) {
      const cellRef = refs.slots[index];
      const item = worn.get(slot);
      flag(cellRef.root, "on", !!item);
      cellRef.root.dataset.rarity = item?.rarity ?? "";
      text(cellRef.note, "");
      cellRef.root.title = item ? `${slot}\n${itemTitle(item)}` : `${slot} — empty`;
    }

    // The pack. A potion nobody remembers carrying is the difference between a
    // wipe and a floor, and the strip is the only place a viewer can see all
    // five packs at once.
    const carried = member.pack ?? [];
    const drinkable = carried.filter((item) => itemCategory(item) === "consumable").length;
    flag(refs.pack.root, "on", carried.length > 0);
    remark(refs.pack.glyph, drinkable > 0 ? "consumable" : "pack");
    flag(refs.pack.root, "drinkable", drinkable > 0);
    text(refs.pack.note, carried.length ? String(carried.length) : "");
    refs.pack.root.title = carried.length
      ? `pack\n${carried.map((item) => `${item.name}${itemCategory(item) === "consumable" ? " (consumable)" : ""}`).join("\n")}`
      : "pack — empty";

    // Talents, then cooldowns, then unspent points: what they have become, what
    // they cannot do yet, and what they still owe themselves.
    const extras: Array<{ shape: MarkName; note: string; className: string; title: string }> = [];
    for (const talent of member.talents ?? []) {
      extras.push({
        shape: "talent",
        note: String(talent.rank ?? ""),
        className: "talent",
        title: `${talent.name ?? talent.id} — rank ${talent.rank}`,
      });
    }
    for (const cooling of member.cooldowns ?? []) {
      if ((Number(cooling.ticks) || 0) <= 0) continue;
      extras.push({
        shape: "cooldown",
        note: String(cooling.ticks),
        className: "cooling",
        title: `${humanise(cooling.id)} — ${cooling.ticks} round${cooling.ticks === 1 ? "" : "s"} of cooldown`,
      });
    }
    const unspent = Number(member.talentPoints) || 0;
    if (unspent > 0) {
      extras.push({
        shape: "levelup",
        note: String(unspent),
        className: "unspent",
        title: `${unspent} skill point${unspent === 1 ? "" : "s"} unspent`,
      });
    }

    const nodes = refs.kitCells;
    while (nodes.length < extras.length) {
      const made = cell("talent", "extra");
      refs.kit.appendChild(made.root);
      nodes.push(made);
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const want = extras[i];
      node.root.style.display = want ? "" : "none";
      if (!want) continue;
      node.root.className = `hud-kit-cell extra ${want.className}`;
      remark(node.glyph, want.shape);
      text(node.note, want.note);
      node.root.title = want.title;
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
      remark(refs.readyIcon, "down");
      text(refs.verb, "DOWN");
      text(refs.at, "needs a revive");
      return;
    }
    flag(box, "gone", false);

    const act = member.readied;
    if (act?.kind) {
      flag(box, "idle", false);
      flag(box, "waiting", false);
      remark(refs.readyIcon, ACTION_GLYPH.get(act.kind) ?? "strike");
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
    remark(refs.readyIcon, fighting ? "utility" : "guard");
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

    const traitors = revealedTraitors(scene);
    const names = new Map<string, string>((scene.enemies ?? []).map((e) => [e.ref, e.name]));
    const was = new Map<ClassId, ScenePartyMember>((before?.party ?? []).map((p) => [p.id, p]));

    // One round's blows, folded per member. Only when the tick actually turned:
    // five scenes carry the same beats, and a tick replayed five times would
    // print `−143` five times for one sword.
    const beatsTick = Number(scene.beatsTick) || 0;
    const turned = beatsTick !== lastBeats;
    const tallies = turned ? beatTallies(scene.beats, shieldedRefs(before)) : null;
    if (turned) lastBeats = beatsTick;

    for (const member of party) {
      const refs = cards.get(member.id);
      if (!refs) continue;

      flag(refs.root, "dead", !!member.dead);
      // Audience-only, and the loudest place it can go: the party strip sits
      // directly under the stage and is where a viewer's eye already lives.
      // The side panel explains; this is what makes it legible at a glance.
      flag(refs.root, "traitor", traitors.has(member.id));

      text(refs.who, member.identity?.displayName || shout(member.id));
      const strongest = [...(member.identity?.traits ?? [])]
        .sort((a, b) => Math.abs(b.score - 50.5) - Math.abs(a.score - 50.5) || a.id.localeCompare(b.id))
        .slice(0, 2)
        .map((trait) => `${trait.label} ${trait.score}`);
      text(refs.persona, `${shout(member.id)} · ${strongest.join(" · ") || "identity pending"}`);
      refs.persona.title = (member.identity?.traits ?? [])
        .map((trait) => `${trait.name} ${trait.score}/100 — ${trait.label}`)
        .join("\n");

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
      kitRail(refs, member);
      readied(refs, member, scene, names);

      // What the round did to them, as a figure. A bar that shrank says "worse"
      // and nothing else; the tick says by how much, and when the answer is
      // "not at all" it says which mechanism ate it.
      if (tallies) {
        const said = tickText(tallies.get(member.id));
        refs.tick.className = `tick${said?.tone ? ` ${said.tone}` : ""}`;
        text(refs.tick, said?.text ?? "");
        if (said) replay(refs.tick, "on");
        else refs.tick.classList.remove("on");
      }

      // Flash on a drop. `before` is the previous *scene*, so this fires once
      // per round rather than on every poll — restarting the animation needs the
      // class removed, a reflow forced, and the class put back.
      const prior = was.get(member.id);
      if (prior && (member.hp ?? 0) < (prior.hp ?? 0)) replay(refs.root, "hurt");
    }
  };
}

// ---------------------------------------------------------------------------
// 1b. The other side of the room
// ---------------------------------------------------------------------------

/** The nodes on one enemy's plate that ever change after it is built. */
interface FoeHandle {
  root: HTMLElement;
  glyph: SVGSVGElement;
  name: HTMLElement;
  rank: HTMLElement;
  tick: HTMLElement;
  num: HTMLElement;
  fill: HTMLElement;
  bar: HTMLElement;
  fx: HTMLElement;
  fxNodes: ChipHandle[];
  tell: HTMLElement;
}

/**
 * A nameplate per enemy, kept up for as long as the enemy is.
 *
 * The stage draws them and the stage is the right place to *watch* a fight, but
 * a silhouette is not a name and a shrinking bar is not a number. Somebody
 * arriving thirty seconds into a boss fight could see four things being hit and
 * had no way to learn what any of them were called, which of them was the boss,
 * or whether the round had gone well — the bars were already the length they
 * ended at by the time the eye reached them.
 *
 * So: the plates sit above the party, permanently, in the one column that never
 * rotates away. Us and them, adjacent, in the same units. And each plate carries
 * the round's damage as a figure, because that is the number a viewer follows
 * and it is the one thing the bar cannot say.
 */
function buildEnemies(host: HTMLElement): SceneRenderer {
  const root = el("div", "hud-foes");
  const head = el("div", "hud-foes-head");
  const headCount = el("span", "n", "");
  head.append(mark("enemy", "mark"), el("span", "k", "In the room"), headCount);
  const list = el("div", "hud-foelist");
  root.append(head, list);
  root.style.display = "none";
  host.appendChild(root);

  const plates = new Map<string, FoeHandle>();
  let order = "";
  let lastBeats: number | null = null;

  function plate(): FoeHandle {
    const box = el("div", "hud-foe");
    const glyph = mark("enemy", "mark lg");
    const body = el("div", "hud-foe-body");

    const top = el("div", "hud-foe-top");
    const name = el("span", "hud-foe-name", "");
    const rank = el("span", "hud-tag rank", "");
    const tick = el("span", "tick");
    const num = el("span", "num");
    top.append(name, rank, tick, num);

    const bar = el("div", "meter hud-mid");
    const fill = el("i");
    bar.appendChild(fill);

    const bot = el("div", "hud-foe-bot");
    const fx = el("div", "hud-chips");
    const tell = el("div", "hud-foe-tell");
    bot.append(fx, tell);

    body.append(top, bar, bot);
    box.append(glyph, body);
    return { root: box, glyph, name, rank, tick, num, fill, bar, fx, fxNodes: [], tell };
  }

  /** The same chip machinery the party cards use, so an effect looks alike on both sides. */
  function effects(refs: FoeHandle, statuses: SceneStatus[]): void {
    const nodes = refs.fxNodes;
    while (nodes.length < statuses.length) {
      const chip = el("span", "hud-chip");
      const glyph = mark("effect", "mark sm");
      const label = el("span");
      const ticks = el("b");
      chip.append(glyph, label, ticks);
      refs.fx.appendChild(chip);
      nodes.push({ root: chip, glyph, label, ticks });
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const status = statuses[i];
      node.root.style.display = status ? "" : "none";
      if (!status) continue;
      const kind = String(status.kind ?? "");
      // Read from the *party's* side: a burn on an enemy is good news here,
      // which is the opposite of what the same chip means on a party card.
      flag(node.root, "boon", statusTone(kind) === "bane");
      remark(node.glyph, statusMark(kind));
      text(node.label, statusShort(kind));
      text(node.ticks, status.ticks > 0 ? `${status.ticks}` : "");
      node.root.title = statusTitle(status);
    }
  }

  return function renderEnemies(scene, before) {
    const enemies: SceneEnemy[] = scene?.enemies ?? [];

    // A death beat names a ref that has already left the roster, so the plate
    // for whatever just died is only drawable from the beats — and only for the
    // one tick they belong to.
    const beatsTick = Number(scene?.beatsTick) || 0;
    const turned = beatsTick !== lastBeats;
    const tallies = turned ? beatTallies(scene?.beats, shieldedRefs(before)) : null;
    if (turned) lastBeats = beatsTick;

    const standing = new Set(enemies.map((e) => String(e.ref)));
    // Something that died is already gone from the roster, so the only record
    // that it was ever here is its own plate — which is also why a ref this
    // panel never drew is skipped rather than given a blank nameplate.
    const slain = [...(tallies ?? new Map<string, BeatTally>())]
      .filter(([ref, tally]) => tally.died && !standing.has(ref) && plates.has(ref))
      .map(([ref]) => ref);

    const wanted = [...enemies.map((e) => String(e.ref)), ...slain];
    root.style.display = wanted.length ? "" : "none";
    if (!wanted.length) {
      for (const [ref, refs] of plates) {
        refs.root.remove();
        plates.delete(ref);
      }
      order = "";
      return;
    }

    text(headCount, `${enemies.length}`);

    for (const [ref, refs] of plates) {
      if (wanted.includes(ref)) continue;
      refs.root.remove();
      plates.delete(ref);
    }
    // Re-appending moves a node, which restarts anything transitioning on it —
    // so the list is only re-laid-out when its membership or order changed.
    const key = wanted.join(",");
    if (key !== order) {
      order = key;
      for (const ref of wanted) {
        let refs = plates.get(ref);
        if (!refs) {
          refs = plate();
          plates.set(ref, refs);
        }
        list.appendChild(refs.root);
      }
    }

    const names = new Map(enemies.map((e) => [String(e.ref), e]));
    for (const ref of wanted) {
      const refs = plates.get(ref);
      if (!refs) continue;
      const foe = names.get(ref);
      const tally = tallies?.get(ref);

      if (!foe) {
        // Dead, and only knowable from a beat. Named from whatever the plate
        // already said rather than from a guess at what the ref was called.
        flag(refs.root, "slain", true);
        text(refs.rank, "SLAIN");
        text(refs.num, "");
        refs.fill.style.transform = "scaleX(0)";
        text(refs.tell, "");
        effects(refs, []);
        continue;
      }

      flag(refs.root, "slain", false);
      refs.root.dataset.rank = foe.boss ? "boss" : foe.elite ? "elite" : "";
      remark(refs.glyph, foe.boss ? "boss" : foe.elite ? "elite" : "enemy");
      text(refs.name, foe.name || ref);
      refs.root.title = `${foe.name} — ${foe.family}${foe.boss ? " · boss" : foe.elite ? " · elite" : ""}`;
      text(refs.rank, foe.boss ? "BOSS" : foe.elite ? "ELITE" : "");
      refs.rank.style.display = foe.boss || foe.elite ? "" : "none";

      const hp = ratio(foe.hp, foe.maxHp);
      refs.fill.style.transform = `scaleX(${hp})`;
      flag(refs.bar, "hurt", hp < 0.55 && hp >= 0.25);
      flag(refs.bar, "dire", hp < 0.25);
      text(refs.num, `${Math.max(0, foe.hp ?? 0)}/${foe.maxHp ?? 0}`);

      effects(refs, (foe.statuses ?? []).filter((s) => (s?.ticks ?? 0) > 0).slice(0, 4));
      text(refs.tell, foe.telegraph ? `winding up · ${foe.telegraph}` : "");
      flag(refs.root, "telegraph", !!foe.telegraph);

      if (tallies) {
        const said = tickText(tally);
        refs.tick.className = `tick${said?.tone ? ` ${said.tone}` : ""}`;
        text(refs.tick, said?.text ?? "");
        if (said) replay(refs.tick, "on");
        else refs.tick.classList.remove("on");
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
    head.append(
      el("div", "hud-activename", member.identity?.displayName || member.id),
      el("span", "hud-tag", member.id),
    );
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

    const identity = el("div", "hud-detailcol");
    identity.appendChild(label("Identity, personality, and motive"));
    const identityData = member.identity;
    if (!identityData) {
      identity.appendChild(el("div", "hud-detail-empty", "No run-specific identity in this trace."));
    } else {
      const appearance = el("div", "hud-bioline", identityData.appearance);
      appearance.title = `${identityData.appearance}\n\n${identityData.backstory}\n\nPublic aspiration: ${identityData.publicAspiration}`;
      identity.append(appearance, el("div", "hud-bioline", `Aim · ${identityData.publicAspiration}`));
      const traits = el("div", "hud-traits");
      for (const trait of identityData.traits ?? []) {
        const row = el("div", "hud-traitline", trait.name);
        row.append(el("b", null, `${trait.score} · ${trait.label}`));
        row.title = trait.description;
        traits.appendChild(row);
      }
      identity.appendChild(traits);
      const goal = identityData.secretGoal;
      const goalDisclosed = goal?.revealed || goal?.completed;
      const goalLine = el(
        "div",
        `hud-goalline${goal?.completed ? " done" : ""}`,
        goalDisclosed && goal?.title
          ? `${goal.completed ? "Completed" : "Motive"} · ${goal.title} · ${goal.progress}/${goal.target} ${goal.unit}`
          : "Private motive · sealed",
      );
      goalLine.title = goalDisclosed ? (goal?.description ?? "") : "This motive has not been revealed.";
      identity.appendChild(goalLine);
    }

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
      // A thing you drink and a thing you wear are different events when they
      // are handed over, so they are different shapes wherever they are listed.
      const category: Category = itemCategory(item);
      const badge = el("span", "cat");
      badge.dataset.cat = category;
      badge.append(mark(slot === "pack" ? category : slotMark(slot), "mark sm"));
      badge.title = CATEGORY[category].label;
      line.append(badge, el("span", "slot", slot), rarity, el("b", null, item.name), affixes);
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

    root.append(summary, identity, items, build);
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
  bossMark: SVGSVGElement;
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
  const graphKey = el("div", "hud-key");
  graph.append(graphZone, graphCanvas, graphKey);

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
    const glyph = mark("unknown");
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
    const bossMark = mark("boss");
    row.append(num, label, bossMark);
    belowRows.push({ row, num, label, bossMark });
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

    // The layout is computed from the graph; the generator's `x`/`y` are
    // deliberately not read. See `floorplan.ts` for what they were doing wrong.
    const plan = planFloor({
      currentRoom: map.currentRoom,
      // `kind` is what anchors the layout at the entrance instead of at the
      // party, which is half of why the map used to rearrange itself.
      rooms: map.rooms.map((room) => ({ id: room.id, links: room.links, kind: room.kind })),
      routes: map.routes,
    });
    /*
     * Positions are inset, not raw percentages.
     *
     * A room at plan x=0 sat with its centre on the canvas edge, so half its
     * disc and all of its name were outside the box — on the *left-most* room
     * of every floor, which is usually the entrance. The inset reserves a
     * margin for the widest thing anchored at a node: the name under it.
     */
    const PAD_X = 11;
    const PAD_TOP = 6;
    const PAD_BOTTOM = 20;
    const at = (value: number, extent: number, pad: number, padEnd = pad) =>
      `${insetPercent(value, extent, pad, padEnd)}%`;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "hud-graphedges");
    /*
     * The inset goes in the viewBox, not in the element's position.
     *
     * Insetting the `<svg>` itself with left/right/top/bottom and `width: auto`
     * does not do what it does on a div: an SVG's `auto` width resolves to
     * 100% of the containing block rather than to the box its insets describe,
     * so the element kept full size *and* moved — and with `overflow: visible`
     * the corridors drew a quarter of the way down the page, straight through
     * the legend and the panels below it.
     *
     * Padding the coordinate system instead leaves the element at `inset: 0`,
     * which is the well-behaved case, and puts the geometry in exactly the same
     * place as the HTML room nodes.
     */
    const box = insetViewBox(plan, PAD_X, PAD_TOP, PAD_BOTTOM);
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.w} ${box.h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const defs = document.createElementNS(svgNS, "defs");
    const marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", "hud-route-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "8");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5");
    marker.setAttribute("markerHeight", "5");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(svgNS, "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    arrow.setAttribute("fill", "context-stroke");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const routeById = new Map(map.routes.map((route) => [route.id, route]));
    for (const corridor of plan.routes) {
      const source = routeById.get(corridor.id);
      const line = document.createElementNS(svgNS, "polyline");
      line.dataset.kind = corridor.kind;
      line.dataset.opened = source?.openedBy ? "true" : "false";
      // Drawn, not omitted. Leaving it out moved every room the moment somebody
      // found it; shading it keeps the picture still and tells the audience
      // something the party has not worked out yet.
      line.dataset.found = source?.discovered === false ? "no" : "yes";
      // A trap has three states and they are three different facts about the
      // floor: still armed, spent, or made safe by somebody spending a dread to
      // do it. The map drew all three identically, so `trapsDisarmed` — a
      // milestone worth four points — was invisible on the page that exists to
      // show what the party achieved.
      line.dataset.state = source?.disarmed ? "disarmed" : source?.triggered ? "spent" : "armed";
      line.setAttribute("points", corridor.points.map((point) => `${point.x},${point.y}`).join(" "));
      const title = document.createElementNS(svgNS, "title");
      title.textContent =
        corridor.kind === "locked"
          ? source?.openedBy
            ? `Locked door · opened by ${source.openedBy}`
            : "Locked door · key, rogue lock-pick, or guardian breach"
          : corridor.kind === "toll"
            ? source?.openedBy
              ? `Toll gate · paid`
              : `Toll gate · ${source?.toll ?? "?"} gold, and more than one purse holds`
            : corridor.kind === "one-way"
              ? "A drop. One way only."
              : corridor.kind === "trap"
                ? source?.disarmed
                  ? "Trap · disarmed, at the cost of a dread"
                  : source?.triggered
                    ? "Trap · already sprung"
                    : "Trap · armed. It changes the party only on the first crossing."
                : corridor.kind;
      line.appendChild(title);
      svg.appendChild(line);
    }
    graphCanvas.appendChild(svg);

    // Up and down, not "IN" and an arrow. The entrance *is* the stair the party
    // came down; drawing it as a word made the only two rooms that answer
    // "where did we come in and where is the way on" the two that looked least
    // like each other.
    const glyphs: Record<string, string> = {
      entrance: "↑",
      empty: "·",
      combat: "⚔",
      elite: "!",
      boss: "☠",
      market: "$",
      cache: "◇",
      shrine: "✦",
      stairs: "↓",
    };
    const roomById = new Map(map.rooms.map((room) => [room.id, room]));

    // Which rooms are still shut, and by what. Pure and tested in `floorplan.ts`
    // — see `roomGates` for why this is a property of the doors and drawn on
    // the room.
    const gates = roomGates(
      plan,
      new Set(map.routes.filter((route) => route.openedBy).map((route) => route.id)),
    );

    /*
     * Label width, measured rather than guessed.
     *
     * Sized to the narrowest gap between two room centres, which is the space a
     * name actually has. The first attempt used `cell.w` and produced labels
     * 82% of the canvas wide against a 19% gap — rows of different widths are
     * centred against each other, so neighbours routinely sit half a cell
     * apart, and every name on a four-room floor overlapped the one beside it.
     */
    const usable = 100 - 2 * PAD_X;
    const labelWidth = `${
      Number.isFinite(plan.minGapX) ? (plan.minGapX / Math.max(1, plan.width)) * usable * 0.94 : usable
    }%`;

    for (const seat of plan.rooms) {
      const room = roomById.get(seat.id);
      if (!room) continue;
      const node = el("div", "hud-roomnode");
      node.dataset.kind = room.kind;
      if (room.environment) node.dataset.environment = room.environment.kind;
      const gate = gates.get(room.id);
      if (gate) node.dataset.gate = gate;
      node.style.left = at(seat.x, plan.width, PAD_X);
      node.style.top = at(seat.y, plan.height, PAD_TOP, PAD_BOTTOM);
      flag(node, "current", room.id === map.currentRoom);
      flag(node, "visited", room.visited);
      // Three states, not two. Been there; seen it without going (a scout or a
      // revealing item); or known only because a door leads that way and
      // nothing more. The third was drawn identically to the second, so the
      // map could not answer "have we actually looked in there".
      flag(node, "scouted", room.revealed && !room.visited);
      flag(node, "edge", room.known && !room.visited && !room.revealed);
      // The party does not know this room is here. Drawn anyway, faintly: the
      // map is for the audience, and watching them walk past a room is the
      // whole reason to show one.
      flag(node, "unfound", !room.known);
      flag(node, "cleared", room.cleared);
      flag(node, "occupied", !!room.threat);
      flag(node, "key", room.key && !room.keyCollected);
      node.append(el("b", null, room.threat ? `${room.threat.enemies}` : (glyphs[room.kind] ?? "?")));
      node.title = `${room.label} · ${room.kind}${room.environment ? ` · ${room.environment.name}: ${room.environment.effect}` : ""}${room.revealed && !room.visited ? " · revealed by equipment" : ""}${room.cleared ? " · cleared" : ""}${room.key ? room.keyCollected ? " · floor key recovered here" : " · floor key waiting here" : ""}${room.threat ? ` · ${room.threat.enemies} enemies remain at ${room.threat.hp}/${room.threat.maxHp} hp after ${room.threat.retreats} retreat${room.threat.retreats === 1 ? "" : "s"}` : ""}`;
      graphCanvas.appendChild(node);

      /*
       * The name is a sibling of the room, not a child of it.
       *
       * A percentage width resolves against the containing block, and an
       * absolutely-positioned room node *is* the containing block for anything
       * inside it — so a label sized at 37% of the map came out as 37% of a
       * 28-pixel circle. Ten pixels. Every room name on the floor rendered as
       * two characters and a line break, which is how "silted guardroom" drew
       * as "sil / te".
       */
      const label = el("div", "hud-roomlabel", room.label);
      label.dataset.state = !room.known
        ? "unfound"
        : room.id === map.currentRoom
          ? "current"
          : room.visited
            ? "visited"
            : room.revealed
              ? "scouted"
              : "edge";
      label.style.left = at(seat.x, plan.width, PAD_X);
      label.style.top = `calc(${at(seat.y, plan.height, PAD_TOP, PAD_BOTTOM)} + 16px)`;
      label.style.width = labelWidth;
      label.title = room.label;
      graphCanvas.appendChild(label);
    }

    drawKey(map, plan);
  }

  /**
   * What the symbols mean, for this floor only.
   *
   * Every swatch is built from the *same class* the map draws with, so a legend
   * entry cannot drift from the thing it explains — change a dash pattern and
   * both move together. A legend maintained separately from its map is worse
   * than none, because it is believed.
   *
   * Only what is on screen. A fixed legend listing six corridor kinds on a floor
   * that has two is six rows of noise to read past, and the two that matter are
   * no easier to find than they were without it.
   */
  function drawKey(map: NonNullable<Scene["floorMap"]>, plan: ReturnType<typeof planFloor>): void {
    graphKey.textContent = "";
    const routeById2 = new Map(map.routes.map((r) => [r.id, r]));
    const seen = new Set<string>();
    const add = (node: HTMLElement, label: string, order: number) => {
      if (seen.has(label)) return;
      seen.add(label);
      const chip = el("span", "hud-keychip");
      chip.style.order = String(order);
      chip.append(node, el("span", null, label));
      graphKey.append(chip);
    };

    const roomSwatch = (classes: string, glyph = "") => {
      const dot = el("div", `hud-roomnode hud-keydot ${classes}`);
      dot.append(el("b", null, glyph));
      return dot;
    };
    const lineSwatch = (kind: string, state?: string, opened?: boolean, unfound?: boolean) => {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "hud-graphedges hud-keyline");
      svg.setAttribute("viewBox", "0 0 30 6");
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS(svgNS, "polyline");
      line.dataset.kind = kind;
      if (state) line.dataset.state = state;
      line.dataset.opened = opened ? "true" : "false";
      line.dataset.found = unfound ? "no" : "yes";
      line.setAttribute("points", "1,3 29,3");
      svg.appendChild(line);
      return svg as unknown as HTMLElement;
    };

    // Where they are always comes first; it is the question the map is asked
    // most often and the only one with a single right answer.
    add(roomSwatch("current"), "you are here", 0);
    const rooms = map.rooms;
    if (rooms.some((r) => r.visited)) add(roomSwatch("visited"), "visited", 1);
    if (rooms.some((r) => r.revealed && !r.visited)) add(roomSwatch("scouted"), "scouted, not entered", 2);
    if (rooms.some((r) => r.known && !r.visited && !r.revealed)) {
      add(roomSwatch("edge"), "a door leads there — unseen", 3);
    }
    if (rooms.some((r) => !r.known)) add(roomSwatch("unfound"), "they have not found this (you can see it)", 4);
    if (rooms.some((r) => r.threat)) add(roomSwatch("occupied", "2"), "enemies still there", 4);
    if (rooms.some((r) => r.key && !r.keyCollected)) add(roomSwatch("key", "◇"), "floor key here", 5);
    if (rooms.some((r) => r.kind === "entrance")) add(roomSwatch("visited", "↑"), "stairs up (came in)", 6);
    if (rooms.some((r) => r.kind === "stairs")) add(roomSwatch("visited", "↓"), "stairs down", 7);

    if (map.routes.some((r) => r.discovered === false)) {
      add(lineSwatch("passage", undefined, false, true), "way they have not found", 19);
    }
    for (const corridor of plan.routes) {
      const source = routeById2.get(corridor.id);
      if (source?.discovered === false) continue;
      if (source?.openedBy) {
        add(lineSwatch(corridor.kind, undefined, true), "door already opened", 20);
        continue;
      }
      if (corridor.kind === "locked") add(lineSwatch("locked"), "locked — key, pick or breach", 21);
      else if (corridor.kind === "toll") add(lineSwatch("toll"), `toll gate — ${source?.toll ?? "?"} gold`, 22);
      else if (corridor.kind === "secret") add(lineSwatch("secret"), "secret way", 23);
      else if (corridor.kind === "one-way") add(lineSwatch("one-way"), "one-way drop", 24);
      else if (corridor.kind === "trap") {
        const state = source?.disarmed ? "disarmed" : source?.triggered ? "spent" : "armed";
        add(
          lineSwatch("trap", state),
          state === "disarmed" ? "trap — made safe" : state === "spent" ? "trap — already sprung" : "trap — armed",
          25,
        );
      } else add(lineSwatch("passage"), "open corridor", 26);
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
      remark(row.glyph, isMark(kind) ? kind : "unknown");
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
      row.bossMark.style.display = bossAhead ? "" : "none";
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
  // A second row of four, because the first four describe a run that descends
  // and fights and nothing else. A party that pooled nine purses, paid a toll
  // and found three hidden ways had a far more interesting run than "3 floors,
  // 0 bosses" suggests, and none of it was on the page.
  const tEnemies = tile("felled");
  const tRooms = tile("rooms");
  const tPooled = tile("pooled");
  const tSecrets = tile("secrets");

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
    // The simulation's own counter wins wherever it exists. `tally` is the
    // reconstruction that was necessary while the store dropped these, and it
    // stays as the fallback for a trace written before they were kept — but a
    // number the simulation computed beats one this panel inferred from scene
    // diffs, which cannot tell a boss killed from a boss escaped.
    const stat = (key: string, fallback: number): number => (key in s.stats ? s.stats[key] : fallback);
    const bosses = stat("bossesDefeated", counts.bosses);
    const deaths = stat("permanentDeaths", counts.deaths);
    text(tXp.value, commas(earned));
    text(tFloors.value, String(stat("floorsCleared", counts.floors)));
    text(tBosses.value, String(bosses));
    text(tDeaths.value, String(deaths));
    flag(tBosses.box, "won", bosses > 0);
    flag(tDeaths.box, "alarm", counts.down > 0 || deaths > 0);

    const elites = stat("elitesDefeated", 0);
    const secrets = stat("secretRoutesFound", 0);
    const pooled = stat("goldTransfers", 0);
    text(tEnemies.value, elites > 0 ? `${stat("enemiesDefeated", 0)}+${elites}` : String(stat("enemiesDefeated", 0)));
    text(tRooms.value, String(stat("roomsExplored", 0)));
    text(tPooled.value, String(pooled));
    text(tSecrets.value, String(secrets));
    // Light up only what the party actually did, so eight tiles still read as a
    // shape rather than a wall of numbers.
    flag(tEnemies.box, "won", elites > 0);
    flag(tPooled.box, "won", pooled > 0);
    flag(tSecrets.box, "won", secrets > 0);

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
/**
 * The labels allowed to travel when they overflow.
 *
 * A deliberate list rather than every ellipsised element on the page. A number
 * that has been truncated is a bug to fix, not a thing to scroll, and a
 * one-word status chip that overflows is telling you the chip is too small —
 * only the places carrying an open-ended *name* belong here, because a name is
 * the one thing on this page whose length nobody controls.
 */
const ROVING = [
  ".hud-who",
  ".hud-activename",
  ".hud-foe-name",
  ".hud-foe-tell",
  ".hud-itemline b",
  ".hud-skillline b",
  ".hud-affixes",
  ".hud-persona",
].join(", ");

export function mountHud(hosts: { party: HTMLElement; map: HTMLElement; progress: HTMLElement }): Renderer {
  const { party, map, progress } = hosts;
  installStyles();

  // The enemy plates are built first so they sit above the party strip: them,
  // then us, in the reading order a viewer already has for a fight.
  const renderEnemies = party ? buildEnemies(party) : null;
  const renderParty = party ? buildParty(party) : null;
  const renderActiveCharacter = party ? buildActiveCharacter(party) : null;
  const renderCastReveal = buildCastReveal();
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
      renderEnemies?.(scene, s.previous ?? null);
      renderParty?.(scene, s.previous ?? null);
      renderMap?.(scene);
      drawn = scene;
    }
    // Agent speech and tool calls can change the active character between
    // authoritative scene snapshots, so this detail view is intentionally not
    // scene-gated.
    renderActiveCharacter?.(s);
    renderCastReveal(s);

    // The progress panel is not scene-gated: milestones arrive on their own
    // event and the scoreboard refreshes on a twenty-second timer, so it has
    // reasons to change on frames where nothing in the dungeon moved.
    renderProgress?.(s, tally);

    // Anything that had to be cut to fit now travels instead. One batched pass
    // for the whole HUD rather than a measurement at each site — see marquee.ts
    // for why the reads and the writes are separated.
    if (party) rove(party, ROVING);
  };
}
