/**
 * The scoreboard: what this run is chasing, and what it is *allowed* to chase.
 *
 * A single run of a fifty-round dungeon is only interesting to a person with no
 * context if it is visibly *part of something* — a number that means "better
 * than yesterday" rather than a number that just gets larger. Every other panel
 * on this page shows the present tense; this one is the only place the viewer
 * finds out whether what they are watching is a good run or a bad one.
 *
 * ## Why it is not simply a leaderboard
 *
 * It used to be, and the leaderboard was wrong. The trace directory today holds
 * runs that began on floor 31 of a single-corridor dungeon and runs that begin
 * on floor 1 of a room graph with a surface outfitter. The first kind scores
 * seven thousand experience because it starts thirty floors down; the second
 * scores a few hundred because it starts at the top. Ranked together, the deep
 * starts own the record permanently and the panel tells a viewer watching a
 * floor-1 run that it is seven thousand behind — which is not a hard run, it is
 * a different game.
 *
 * So every comparison here is scoped to a **cohort**: the runs that played the
 * same game, decided in `src/run-cohort.ts` from what the trace actually records.
 * The panel names the cohort it is using, says how many runs it set aside and
 * why, and says out loud that a cohort spans seeds — because a lucky world is
 * not an organisational improvement, and a board that hid the difference would
 * be claiming it was.
 *
 * ## Three rules this module keeps
 *
 * 1. **It never fetches.** `state.js` polls `/history` every twenty seconds and
 *    hands the result over as `state.history`. A renderer that fetched would be
 *    a second thing that can fail, and it would fail on the page rather than in
 *    the store where the retry logic lives.
 * 2. **It builds its DOM once.** `render` is called on every poll that carried
 *    an event — a few times a second during a busy round — and rebuilding the
 *    panel each time would restart every CSS transition, so the whole panel
 *    would sit frozen mid-fade forever. Mount creates the nodes; render only
 *    writes text, classes, transforms and path data into them.
 * 3. **Nothing is compared across different rounds.** A live run at round nine
 *    against a finished run's fortieth is not a comparison, it is a restatement
 *    that the run is not over. Every figure in the comparison table and every
 *    ghost line is sampled at the same round.
 *
 * ## The run on screen is also a file on disk
 *
 * `/history` reads every `.ndjson` in the trace directory, and the run being
 * broadcast is one of them, half-written. `buildCohort` drops it from its own
 * cohort by filename for that reason; everything that asks "where does this run
 * rank" puts it back and marks it.
 */

import {
  type Axis,
  AXIS_MEANS,
  buildCohort,
  type Cohort,
  type CohortRun,
  count,
  deltasAt,
  isScored,
  lastPoint,
  leadSource,
  markersFor,
  pacePhrase,
  phrase,
  type RunFingerprint,
  type RunMarker,
  type RunPoint,
  sampleAt,
  type ScoredRun,
} from "../../../src/run-cohort.js";
import type { BroadcastState, History, Renderer } from "./types.js";

/** Rows in the honours list. More than this and the type has to shrink below broadcast size. */
const TOP_ROWS = 6;

/** Axes the comparison table carries, in the order a reader asks about them. */
const AXES: readonly Axis[] = ["xp", "floor", "rooms", "bosses", "deaths"];

/** Row labels. Short because the column is 270px wide and the numbers matter more. */
const AXIS_LABEL: Record<Axis, string> = {
  xp: "xp",
  floor: "floor",
  rooms: "rooms",
  bosses: "bosses",
  deaths: "deaths",
};

/**
 * The ghost chart's internal coordinate space. Stretched horizontally to
 * whatever width the column has (`preserveAspectRatio="none"`), which is why
 * markers are drawn as axis-aligned rectangles rather than circles — a circle
 * squashed by an unknown factor is an ellipse of unknown eccentricity, and at
 * this size that reads as a rendering bug.
 */
const GHOST_W = 240;
const GHOST_H = 76;
const GHOST_PAD = 3;

/** Count-up duration for the headline figure. Long enough to read as motion, short enough to finish between polls. */
const TWEEN_MS = 520;

/**
 * Styles live in the module rather than in `style.css` because that file is
 * shared by every panel and this one needs two dozen selectors nobody else
 * wants. The `<style>` goes inside the host element and every rule is prefixed
 * `.rec`, so the panel cannot reach out and restyle the stage even by accident.
 *
 * Colours are all tokens from `style.css`. A panel that invented its own orange
 * would drift away from the rest of the page the first time the palette moved.
 */
const CSS = `
.rec { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; font-family: var(--sans); }
.rec [hidden] { display: none !important; }

/* ---- hero: this run against the cohort's record ------------------------- */

.rec-hero {
  position: relative;
  padding: 9px 11px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #0d121c;
  transition: background .45s ease, border-color .45s ease, box-shadow .45s ease;
}
.rec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rec-xp {
  margin: 6px 0 8px;
  font: 700 34px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  color: var(--ink);
  transition: color .45s ease;
}
.rec-unit { margin-left: 7px; font: 600 13px/1 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
.rec-bar { position: relative; margin-bottom: 7px; }
/* Taller than the shared .meter default: this is the one bar on the page a
   viewer is meant to read from across a room. */
.rec .meter { height: 10px; border-radius: 5px; }
.rec-tick {
  position: absolute; top: -3px; bottom: -3px; width: 2px;
  background: var(--gold); border-radius: 1px;
  transition: left .45s ease;
}
.rec-gap { font: 14px/1.35 var(--sans); color: var(--dim); }
.rec-gap b { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.rec-flag {
  position: absolute; top: -9px; right: 9px;
  padding: 3px 8px; border-radius: 999px;
  font: 700 12px/1 var(--sans); letter-spacing: .18em; text-transform: uppercase;
  color: #20140a; background: var(--flame);
  box-shadow: 0 0 18px -2px rgba(240, 160, 75, .55);
  animation: rec-glow 2.4s ease-in-out infinite;
}
/* Beating the cohort record is the one thing on this panel worth interrupting a
   viewer for, so it is the only state that changes more than a number: the card
   warms up, the figure turns to torchlight, the bar stops being a progress bar. */
.rec.is-record .rec-hero {
  border-color: var(--flame-dim);
  background: linear-gradient(180deg, #1d1409, #0f1219);
  box-shadow: 0 0 0 1px rgba(240, 160, 75, .18), 0 8px 26px -14px rgba(240, 160, 75, .6);
}
.rec.is-record .rec-xp { color: var(--flame); }
.rec.is-record .meter i { background: linear-gradient(90deg, var(--flame-dim), var(--flame)); }
.rec.is-record .rec-gap b { color: var(--flame); }
@keyframes rec-glow { 50% { box-shadow: 0 0 4px 0 rgba(240, 160, 75, .25); } }

/* ---- the cohort this panel is using ------------------------------------- */

/* Deliberately the plainest block on the panel. It is a disclosure, not a
   score, and a disclosure that competes with the headline gets read as one. */
.rec-cohort {
  padding: 7px 9px 8px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--panel-2);
}
.rec-cohort-label { display: block; margin-top: 4px; font: 13px/1.35 var(--sans); color: var(--ink); }
.rec-cohort-sub { display: block; margin-top: 3px; font: 12px/1.35 var(--sans); color: var(--dim); }
.rec-cohort-aside { display: block; margin-top: 3px; font: 12px/1.35 var(--sans); color: var(--warn); }

/* ---- the comparison, at one round --------------------------------------- */

.rec-vs { display: flex; flex-direction: column; gap: 3px; }
.rec-vs-row {
  display: grid; grid-template-columns: minmax(0, 1fr) 40px 40px 40px 40px;
  align-items: baseline; gap: 3px;
}
.rec-vs-h { font: 12px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; color: var(--faint); text-align: right; }
.rec-vs-h:first-child { text-align: left; }
.rec-vs-k { font: 13px/1.2 var(--sans); color: var(--dim); }
.rec-vs-n { text-align: right; font: 13px/1.2 var(--mono); font-variant-numeric: tabular-nums; color: var(--faint); }
.rec-vs-n.is-mine { color: var(--ink); font-weight: 600; }
.rec-vs-n.is-up { color: var(--good); }
.rec-vs-n.is-down { color: var(--bad); }

.rec-read { font: 13px/1.4 var(--sans); color: var(--dim); }
.rec-read b { color: var(--ink); font-weight: 600; }
.rec-read span { display: block; }

/* ---- the ghost line ----------------------------------------------------- */

.rec-ghost svg { display: block; width: 100%; height: ${GHOST_H}px; margin-top: 5px; }
.rec-g-mine { fill: none; stroke: var(--flame); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.rec-g-best { fill: none; stroke: var(--gold); stroke-width: 1; stroke-dasharray: 3 3; opacity: .8; vector-effect: non-scaling-stroke; }
.rec-g-median { fill: none; stroke: var(--faint); stroke-width: 1; opacity: .8; vector-effect: non-scaling-stroke; }
.rec-g-axis { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.rec-g-mark { stroke: none; }
.rec-g-mark.is-boss { fill: var(--gold); }
.rec-g-mark.is-death { fill: var(--bad); }
.rec-g-mark.is-end { fill: var(--dim); }
.rec-key { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; font: 12px/1 var(--sans); color: var(--faint); }
.rec-key i { display: inline-block; width: 9px; height: 2px; margin-right: 4px; vertical-align: middle; }

/* ---- honours: the cohort's finished runs -------------------------------- */

/* A one-pixel gap over the line colour makes the hairline grid of a results
   board without four separate borders that never quite meet at the corners. */
.rec-stats {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--line); overflow: hidden;
}
.rec-cell { padding: 6px 9px 7px; background: var(--panel-2); }
.rec-cell .k { display: block; margin-bottom: 5px; }
.rec-cell-v { font: 600 17px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.rec-cell-s { display: block; margin-top: 4px; font: 12px/1.2 var(--sans); color: var(--faint); }
.rec-cell.is-gold .rec-cell-v { color: var(--gold); }

/* ---- baselines ---------------------------------------------------------- */

.rec-base { font: 12px/1.35 var(--sans); color: var(--faint); }

/* ---- the ranked list ---------------------------------------------------- */

.rec-board { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.rec-board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.rec-rows { display: flex; flex-direction: column; gap: 3px; min-height: 0; overflow: hidden; }
.rec-row {
  display: grid; grid-template-columns: 15px minmax(0, 1fr) auto auto;
  align-items: center; gap: 8px;
  padding: 4px 7px; border-radius: 5px;
  border-left: 2px solid transparent;
  background: #0d121c;
  transition: background .3s ease, border-color .3s ease;
}
.rec-row.is-now { border-left-color: var(--flame); background: #17140f; }
.rec-rank { font: 600 13px/1 var(--mono); color: var(--faint); }
.rec-row.is-now .rec-rank { color: var(--flame); }
.rec-score { text-align: right; font: 600 15.5px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.rec-floor { font: 13px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--dim); }
.rec-tag {
  padding: 2px 5px; border: 1px solid var(--line); border-radius: 3px;
  font: 12px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--faint);
}
.rec-tag.is-wipe { color: var(--bad); border-color: #4a2725; }
.rec-tag.is-now { color: var(--flame); border-color: var(--flame-dim); }
.rec-you { margin-top: 6px; font: 13px/1.3 var(--sans); color: var(--dim); font-variant-numeric: tabular-nums; }

@media (prefers-reduced-motion: reduce) {
  .rec-hero, .rec-xp, .rec-tick, .rec-row, .rec .meter i { transition: none; }
  .rec-flag { animation: none; }
}
`;

/* ------------------------------------------------------------------------ */
/* small helpers                                                             */
/* ------------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The SVG half of `el`. A separate function rather than a branch inside it
 * because the namespace decides the *type* of the node as well as the call:
 * a `<rect>` built with `createElement` is an `HTMLUnknownElement` that draws
 * nothing, and `SVGRectElement` is not an `HTMLElement`, so the two cannot
 * share a return type either.
 */
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

/** Writes only on change, so an unchanged panel does not thrash layout sixty times a minute. */
function setText(node: Element, text: string | null | undefined) {
  const next = text == null ? "" : String(text);
  if (node.textContent !== next) node.textContent = next;
}

/** The same, for an attribute — the ghost paths are rewritten on every poll. */
function setAttr(node: Element, name: string, value: string) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setClass(node: Element, value: string) {
  if (node.getAttribute("class") !== value) node.setAttribute("class", value);
}

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

/** A trace path from `/events` and a filename from `/history` have to be comparable. */
function base(path: string | null | undefined) {
  return String(path ?? "").split(/[\\/]/).pop() ?? "";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `/history` carries more per run than the store's mirror of it declares.
 *
 * `viewer/broadcast/src/types.ts` is the store's contract and describes the
 * fields the store itself reads; the fingerprint, the per-round track and the
 * baseline list arrive over the same endpoint and are consumed only here. The
 * widening is safe in the direction it is used — every field this panel touches
 * is optional on `CohortRun` and checked before it is read.
 */
interface CohortHistory extends Omit<History, "runs"> {
  runs: CohortRun[];
  baselines?: CohortRun[];
}

/**
 * "just now", "14m ago", "3 days ago".
 *
 * Hand-rolled rather than `Intl.RelativeTimeFormat` on purpose: this needs one
 * fixed English phrasing that stays the same width from frame to frame, and
 * `Intl` would hand back whatever the viewing machine's locale produces —
 * a broadcast that says "il y a 3 jours" on one laptop is not the same page.
 *
 * Floors rather than rounds every unit above a minute, because "2 days ago" for
 * something 35 hours old reads as a lie to anybody who knows when they ran it.
 */
function ago(at: number | null | undefined, now: number) {
  if (!isNum(at) || at <= 0) return "";
  const secs = Math.max(0, (now - at) / 1000);
  if (secs < 45) return "just now";
  const mins = secs / 60;
  if (mins < 60) return `${Math.max(1, Math.floor(mins))}m ago`;
  const hours = mins / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) {
    const d = Math.floor(days);
    return d <= 1 ? "yesterday" : `${d} days ago`;
  }
  const weeks = days / 7;
  if (weeks < 5) {
    const w = Math.floor(weeks);
    return w <= 1 ? "last week" : `${w} weeks ago`;
  }
  const months = days / 30;
  const m = Math.max(1, Math.floor(months));
  return m === 1 ? "a month ago" : `${m} months ago`;
}

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The headline figure's node, with the two handles `tweenTo` parks on it.
 *
 * Both are absent until the first tween runs, which is what `undefined` means
 * here and why neither is required: `_recTo` missing is "this number has never
 * been shown", the state `render` puts it back into when the run has no score.
 */
interface TweenTarget extends HTMLElement {
  _recTo?: number;
  _recFrame?: number;
}

/**
 * Counts a number up to its new value instead of snapping.
 *
 * The headline figure moves in jumps of a few hundred XP when a fight resolves,
 * and a jump is easy to miss on a stream; a half-second roll is not. The value
 * is cached on the node so a re-render with the same number is free, and the
 * frame handle is cached so two overlapping updates cannot fight each other.
 */
function tweenTo(node: TweenTarget, value: number) {
  if (node._recTo === value) return;
  const from = isNum(node._recTo) ? node._recTo : value;
  node._recTo = value;
  if (node._recFrame) cancelAnimationFrame(node._recFrame);

  if (reduced() || from === value) {
    node._recFrame = 0;
    setText(node, fmt(value));
    return;
  }

  const started = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - started) / TWEEN_MS);
    const eased = 1 - (1 - k) ** 3;
    setText(node, fmt(from + (value - from) * eased));
    node._recFrame = k < 1 ? requestAnimationFrame(step) : 0;
  };
  node._recFrame = requestAnimationFrame(step);
}

/* ------------------------------------------------------------------------ */
/* the cohort, said in one sentence                                          */
/* ------------------------------------------------------------------------ */

/** How many seeds fit on one line before the list stops being readable and becomes a count. */
const SEEDS_LISTED = 4;

/**
 * How many distinct worlds the cohort spans, and the caveat that goes with it.
 *
 * The single most important sentence on the panel and the whole reason the
 * cohort exists: a cohort is a set of runs of the same game on *different*
 * seeds, so a run that is ahead may simply have drawn an easier dungeon.
 *
 * Seeds are named where a trace recorded them and counted as casts where it did
 * not — the two identify the same thing, because the party's generated names
 * come from the seed. Runs that recorded neither are counted separately rather
 * than folded in, so "across two worlds" never quietly means "across two of the
 * five we could identify".
 */
export function worldsLine(cohort: Cohort): string {
  const { distinct, unknown, sharedWithCurrent } = cohort.worlds;
  if (!cohort.members.length) return "";
  const parts = [
    distinct
      ? `across ${plural(distinct, "seeded world")}${unknown ? `, ${unknown} unrecorded` : ""}`
      : "worlds not recorded",
  ];
  if (sharedWithCurrent) parts.push(plural(sharedWithCurrent, "shares this world", "share this world"));
  // This run's seed first and separately from the rest, because "which world am
  // I watching" and "which worlds is it being measured against" are two
  // questions and a single list answers neither.
  const mine = cohort.fingerprint?.seed;
  const others = cohort.seeds.filter((s) => s !== mine);
  if (isNum(mine)) parts.push(`seed ${mine}`);
  if (others.length) {
    // Named rather than counted while the list is short, because a seed a
    // viewer can read is a seed they can re-run.
    parts.push(
      others.length <= SEEDS_LISTED ? `against ${others.join(", ")}` : `against ${plural(others.length, "seed")}`,
    );
  }
  if (cohort.seedsUnknown) {
    // Never silently: a cohort where half the seeds are unknown is a weaker
    // claim than one where they are all different, and it has to look weaker.
    parts.push(
      cohort.seeds.length
        ? `${cohort.seedsUnknown} without a recorded seed`
        : "no seed recorded in any of these traces",
    );
  }
  return parts.join(" · ");
}

/** "6 set aside: 5 a different starting floor, 1 unverified" — the exclusions, named. */
export function setAsideLine(cohort: Cohort): string {
  if (!cohort.setAside.length) return "";
  const tally = new Map<string, number>();
  for (const item of cohort.setAside) {
    // Grouped on the headline difference rather than the full list, or seven
    // excluded runs come out as one group per *combination* of differences.
    const reason = item.verdict === "unverified" ? "unverified configuration" : item.primary;
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  const parts = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${reason}`);
  return `${cohort.setAside.length} set aside — ${parts.join("; ")}`;
}

/* ------------------------------------------------------------------------ */
/* mount                                                                     */
/* ------------------------------------------------------------------------ */

/** One honours cell: the box, the figure in it, and the line underneath. */
interface StatCell {
  cell: HTMLDivElement;
  value: HTMLSpanElement;
  sub: HTMLSpanElement;
}

/** One row of the ranked list. The rank number never changes, so it is not kept. */
interface BoardRow {
  row: HTMLDivElement;
  score: HTMLSpanElement;
  floor: HTMLSpanElement;
  tag: HTMLSpanElement;
}

/** One axis of the comparison table: its label and the four figures beside it. */
interface VsRow {
  mine: HTMLSpanElement;
  median: HTMLSpanElement;
  best: HTMLSpanElement;
  previous: HTMLSpanElement;
}

/** As many marker dots as one run can plausibly earn before the chart is unreadable. */
const MARKS = 14;

/**
 * Build the panel once and hand back the renderer.
 *
 * Everything below is created here — including every leaderboard row, every
 * table cell and every marker dot, at their maximum count — so that `render`
 * never calls `createElement`. Rows and dots that have no data are hidden
 * rather than removed, which keeps their CSS transitions alive across a run
 * where the ranking shuffles.
 */
export function mountRecords(host: HTMLElement): Renderer {
  if (!host) return () => {};

  const root = el("div", "rec");
  const style = el("style");
  style.textContent = CSS;
  root.append(style);

  // --- hero ---------------------------------------------------------------
  const hero = el("section", "rec-hero");
  const heroLabel = el("span", "k", "chasing the record");
  const heroPct = el("span", "k");
  const heroHead = el("div", "rec-head");
  heroHead.append(heroLabel, heroPct);

  const xp = el("div", "rec-xp");
  const xpNum: TweenTarget = el("span", "rec-xp-n", "0");
  const xpUnit = el("span", "rec-unit", "xp earned");
  xp.append(xpNum, xpUnit);

  const barWrap = el("div", "rec-bar");
  const meter = el("div", "meter");
  const meterFill = el("i");
  meter.append(meterFill);
  const tick = el("span", "rec-tick");
  tick.hidden = true;
  barWrap.append(meter, tick);

  const gap = el("div", "rec-gap");
  const gapNum = el("b");
  const gapText = el("span");
  gap.append(gapNum, gapText);

  const flag = el("div", "rec-flag", "new record");
  flag.hidden = true;

  hero.append(heroHead, xp, barWrap, gap, flag);

  // --- the cohort ---------------------------------------------------------
  const cohortBox = el("section", "rec-cohort");
  const cohortLabel = el("span", "rec-cohort-label");
  const cohortSub = el("span", "rec-cohort-sub");
  const cohortAside = el("span", "rec-cohort-aside");
  cohortBox.append(el("span", "k", "comparing against"), cohortLabel, cohortSub, cohortAside);

  // --- the comparison at one round ---------------------------------------
  const vs = el("section", "rec-vs");
  const vsHead = el("div", "rec-vs-row");
  const vsRound = el("span", "rec-vs-h", "at round —");
  vsHead.append(vsRound, ...["now", "med", "best", "prev"].map((t) => el("span", "rec-vs-h", t)));
  vs.append(vsHead);
  const vsRows = new Map<Axis, VsRow>();
  for (const axis of AXES) {
    const row = el("div", "rec-vs-row");
    const mine = el("span", "rec-vs-n is-mine");
    const median = el("span", "rec-vs-n");
    const best = el("span", "rec-vs-n");
    const previous = el("span", "rec-vs-n");
    row.append(el("span", "rec-vs-k", AXIS_LABEL[axis]), mine, median, best, previous);
    vs.append(row);
    vsRows.set(axis, { mine, median, best, previous });
  }

  // --- the same thing in words -------------------------------------------
  const read = el("section", "rec-read");
  const readLead = el("span");
  const readPace = el("span");
  const readSpread = el("span");
  read.append(readLead, readPace, readSpread);

  // --- the ghost line -----------------------------------------------------
  const ghost = el("section", "rec-ghost");
  const ghostHead = el("div", "rec-board-head");
  const ghostNote = el("span", "k", "ghosts");
  ghostHead.append(el("span", "k", "xp by round"), ghostNote);
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${GHOST_W} ${GHOST_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  const axis = svgEl("path");
  axis.setAttribute("class", "rec-g-axis");
  axis.setAttribute("d", `M0 ${GHOST_H - 0.5} H${GHOST_W}`);
  const medianLine = svgEl("path");
  medianLine.setAttribute("class", "rec-g-median");
  const bestLine = svgEl("path");
  bestLine.setAttribute("class", "rec-g-best");
  const mineLine = svgEl("path");
  mineLine.setAttribute("class", "rec-g-mine");
  // Order matters: the run on screen is drawn last so it is never hidden under
  // a ghost that happens to follow the same path.
  svg.append(axis, medianLine, bestLine, mineLine);

  const marks: SVGRectElement[] = [];
  for (let i = 0; i < MARKS; i += 1) {
    const dot = svgEl("rect");
    dot.setAttribute("class", "rec-g-mark");
    dot.setAttribute("width", "3");
    dot.setAttribute("height", "3");
    dot.style.display = "none";
    svg.append(dot);
    marks.push(dot);
  }

  const key = el("div", "rec-key");
  const keyMine = el("span");
  const keyMedian = el("span");
  const keyBest = el("span");
  for (const [node, cls, label] of [
    [keyMine, "var(--flame)", "this run"],
    [keyMedian, "var(--faint)", "median"],
    [keyBest, "var(--gold)", "best"],
  ] as const) {
    const swatch = el("i");
    swatch.style.background = cls;
    node.append(swatch, document.createTextNode(label));
    key.append(node);
  }
  ghost.append(ghostHead, svg, key);

  // --- honours ------------------------------------------------------------
  const stats = el("section", "rec-stats");
  const cells: StatCell[] = ["cohort best", "cohort median", "previous in cohort", "on file today"].map((label) => {
    const cell = el("div", "rec-cell");
    const value = el("span", "rec-cell-v", "—");
    const sub = el("span", "rec-cell-s");
    cell.append(el("span", "k", label), value, sub);
    stats.append(cell);
    return { cell, value, sub };
  });
  cells[0].cell.classList.add("is-gold");

  // --- baselines ----------------------------------------------------------
  const baseLine = el("section", "rec-base");
  baseLine.hidden = true;

  // --- ranked list --------------------------------------------------------
  const board = el("section", "rec-board");
  const boardHead = el("div", "rec-board-head");
  const boardCount = el("span", "k");
  boardHead.append(el("span", "k", "cohort ranking"), boardCount);
  const rowsBox = el("div", "rec-rows");
  const rows: BoardRow[] = [];
  for (let i = 0; i < TOP_ROWS; i += 1) {
    const row = el("div", "rec-row");
    const rank = el("span", "rec-rank", String(i + 1));
    const score = el("span", "rec-score");
    const floor = el("span", "rec-floor");
    const tag = el("span", "rec-tag");
    row.append(rank, score, floor, tag);
    row.hidden = true;
    rowsBox.append(row);
    rows.push({ row, score, floor, tag });
  }
  // Where the current run sits when it is not good enough to be on the list —
  // which is most of a run, and is exactly when a viewer wants to know.
  const you = el("div", "rec-you");
  you.hidden = true;
  const youText = el("span");
  you.append(youText);
  board.append(boardHead, rowsBox, you);

  // --- the nothing-to-show case ------------------------------------------
  const none = el("div", "empty");
  none.hidden = true;

  root.append(hero, cohortBox, vs, read, ghost, stats, baseLine, board, none);
  host.replaceChildren(root);

  /* ---------------------------------------------------------------------- */
  /* render                                                                  */
  /* ---------------------------------------------------------------------- */

  return function render(state: BroadcastState) {
    const now = Date.now();
    const history = (state?.history ?? null) as CohortHistory | null;
    const runs: CohortRun[] = Array.isArray(history?.runs) ? history.runs : [];
    const baselines: CohortRun[] = Array.isArray(history?.baselines) ? history.baselines : [];

    // The run on screen, as a row in its own history. It is on disk like every
    // other run; `buildCohort` excludes it from its own cohort by filename.
    // Looked up in the baselines too, because `watch --trace` is routinely
    // pointed at a rehearsal, and a rehearsal has to be able to find its own
    // configuration to know what it may be compared with.
    const currentFile = base(state?.file);
    const isCurrent = (r: CohortRun) => !!currentFile && base(r.file) === currentFile;
    const mine = runs.find(isCurrent) ?? baselines.find(isCurrent) ?? null;
    const fingerprint: RunFingerprint | null = mine?.fingerprint ?? null;

    // Rehearsals go in with the rest; `buildCohort` keeps them out of the
    // ranking by their own flag and hands back the comparable ones separately,
    // so a bot cannot become the record this panel says the agents are chasing.
    const cohort = buildCohort([...runs, ...baselines], currentFile, fingerprint);
    const record = cohort.best;

    // The live scene is fresher than the trace summary — `/history` is polled
    // every twenty seconds, the scene every round — so it wins when both exist.
    const liveScore = isNum(state?.scene?.earnedXp) ? state.scene.earnedXp : null;
    const current = liveScore ?? (isNum(mine?.score) ? mine.score : null);

    const ahead = current != null && record != null && current > record.score;
    const haveCohort = cohort.members.length > 0;

    root.classList.toggle("is-record", !!ahead);

    // --- hero -------------------------------------------------------------
    // Worth showing only if there is either a run in progress or a record; with
    // neither, the empty line below carries the whole panel.
    hero.hidden = current == null && record == null;
    if (!hero.hidden) {
      setText(heroLabel, ahead ? "cohort record broken" : record ? "chasing the cohort" : "first of its kind");

      if (current == null) {
        setText(xpNum, "—");
        xpNum._recTo = undefined;
      } else {
        tweenTo(xpNum, current);
      }

      if (record && current != null && record.score > 0) {
        const pct = Math.round((current / record.score) * 100);
        setText(heroPct, `${Math.min(pct, 9999)}% of record`);
        heroPct.hidden = false;
      } else {
        heroPct.hidden = true;
      }

      // Scale against whichever is larger, so passing the record fills the bar
      // and the old record slides back to where it was overtaken.
      const ceiling = Math.max(current ?? 0, record?.score ?? 0);
      const fill = ceiling > 0 ? Math.min(1, (current ?? 0) / ceiling) : current != null ? 1 : 0;
      meterFill.style.transform = `scaleX(${fill.toFixed(4)})`;
      // Below the record the track's own end *is* the record, so a tick there
      // would only be a second mark on the same spot.
      tick.hidden = !ahead;
      if (ahead) tick.style.left = `${((record.score / ceiling) * 100).toFixed(2)}%`;

      if (current == null) {
        setText(gapNum, "");
        gapNum.hidden = true;
        setText(gapText, "waiting for this run's first scene");
      } else if (!record) {
        gapNum.hidden = true;
        setText(gapNum, "");
        // No cohort record is a much narrower claim than the old panel's "first
        // ever". There may be dozens of runs on file; none of them played this
        // game, which is worth saying rather than hiding behind a milestone.
        setText(gapText, "no comparable run on file — this one sets the mark");
      } else if (ahead) {
        gapNum.hidden = false;
        setText(gapNum, `+${fmt(current - record.score)}`);
        setText(gapText, ` clear of ${fmt(record.score)}, set ${ago(record.startedAt, now)}`);
      } else if (current === record.score) {
        gapNum.hidden = true;
        setText(gapNum, "");
        setText(gapText, `level with the cohort record of ${fmt(record.score)}`);
      } else {
        gapNum.hidden = false;
        setText(gapNum, fmt(record.score - current));
        setText(gapText, ` behind the cohort record of ${fmt(record.score)}`);
      }
      flag.hidden = !ahead;
    }

    // --- the cohort, named -------------------------------------------------
    // Shown whatever else is on the panel. "Which runs is this being compared
    // with" must never be a thing the viewer has to assume.
    setText(cohortLabel, fingerprint ? cohort.label : "this run's configuration is not on file yet");
    // The seed is said even when there is nobody to compare against. It is part
    // of the configuration disclosure, not part of the comparison, and a run
    // with no cohort is exactly when a viewer wants to know which world it drew.
    const mySeed = isNum(fingerprint?.seed) ? `seed ${fingerprint.seed}` : "";
    const memberLine = haveCohort
      ? [plural(cohort.members.length, "comparable run"), worldsLine(cohort)].filter(Boolean).join(" · ")
      : [runs.length ? "no comparable run on file" : "no past runs on file", mySeed].filter(Boolean).join(" · ");
    setText(cohortSub, memberLine);
    const asideText = setAsideLine(cohort);
    setText(cohortAside, asideText);
    cohortAside.hidden = !asideText;

    // --- baselines --------------------------------------------------------
    // Written before the empty-cohort exit below, because a run with no
    // comparable *agent* run may still have a comparable rehearsal — and a run
    // that is the first of its configuration is precisely when the only thing
    // it can be placed against is the baseline ladder.
    const ladder = cohort.baselines;
    if (ladder.length) {
      const beaten = current == null ? 0 : ladder.filter((b) => current > b.score).length;
      setText(
        baseLine,
        `baselines: ${ladder.map((b) => `${policyName(b)} ${fmt(b.score)}`).join(" · ")} — this run is above ${beaten} of ${ladder.length}`,
      );
      baseLine.hidden = false;
    } else if (baselines.length) {
      // Usually this, and saying it is the honest answer: a bot's score from a
      // different configuration is exactly the false comparison the rest of
      // this panel exists to prevent.
      setText(baseLine, `${plural(baselines.length, "rehearsal")} on file, none of them played this configuration`);
      baseLine.hidden = false;
    } else {
      baseLine.hidden = true;
    }

    // --- the degenerate case ----------------------------------------------
    // A cohort of nobody. Real and common: the first run after a configuration
    // change has dozens of runs on file and no comparable one among them.
    vs.hidden = !haveCohort;
    read.hidden = !haveCohort;
    ghost.hidden = !haveCohort;
    stats.hidden = !haveCohort;
    board.hidden = !haveCohort;
    none.hidden = haveCohort;
    if (!haveCohort) {
      if (!history) setText(none, "reading the archive…");
      else if (!runs.length) setText(none, "no past runs yet — this one is the whole record book.");
      else setText(none, "nothing on file played this configuration, so there is nothing to compare against yet.");
      return;
    }

    // --- the comparison, all at one round ---------------------------------
    // The round every column is read at. The track is up to twenty seconds
    // stale, so the run's own most recent published round is used rather than
    // the live counter: sampling the ghosts at a round this run has not yet
    // published would show it behind on every axis for the first few seconds of
    // every round.
    const myTrack: RunPoint[] = mine?.track ?? [];
    const atRound = lastPoint(myTrack)?.round ?? state?.round ?? 0;
    // Numbered exactly as the trace numbers rounds, which is how the page
    // header numbers them too. A panel that helpfully added one would put this
    // run's round and the header's round a step apart on the same screen.
    setText(vsRound, `at round ${atRound}`);

    const ghosts: Array<[key: keyof VsRow, run: CohortRun | null]> = [
      ["median", cohort.median],
      ["best", cohort.best],
      ["previous", cohort.previous],
    ];
    const myPoint = sampleAt(myTrack, atRound);
    const medianDeltas = deltasAt(myTrack, cohort.median?.track, atRound, AXES);

    for (const a of AXES) {
      const row = vsRows.get(a);
      if (!row) continue;
      // The live scene beats the polled track for the two figures it carries,
      // so the "now" column keeps up with the stage between history polls.
      const live = a === "xp" ? liveScore : a === "floor" ? (state?.scene?.floor ?? null) : null;
      const value = live ?? (myPoint ? myPoint[a] : null);
      setText(row.mine, value == null ? "—" : fmt(value));
      for (const [slot, run] of ghosts) {
        const point = sampleAt(run?.track, atRound);
        setText(row[slot], point ? fmt(point[a]) : "—");
      }
      // Colour only against the median: three coloured comparisons on one row
      // is a row nobody can read at a glance, and the median is the one that
      // means "the typical run".
      const delta = medianDeltas.find((d) => d.axis === a)?.delta ?? null;
      setClass(row.mine, `rec-vs-n is-mine${delta == null || delta === 0 ? "" : delta > 0 ? " is-up" : " is-down"}`);
    }

    // --- the same thing in words ------------------------------------------
    const lead = leadSource(medianDeltas);
    const xpDelta = medianDeltas.find((d) => d.axis === "xp")?.delta ?? null;
    setText(
      readLead,
      lead
        ? `${lead.ahead ? "Ahead of" : "Behind"} the typical run on ${AXIS_MEANS[lead.axis]} — ${phrase(lead.axis, lead.delta)}.`
        : xpDelta == null
          ? "Nothing to compare at this round yet."
          : "Level with the typical run on every axis.",
    );
    // The pace claim, and only when both runs actually got there: "four rounds
    // earlier" against a run that never killed a boss is an infinite lead
    // written as a number.
    // The deepest floor *both* runs actually stood on. Asking about this run's
    // own current floor would answer "" almost every time, because the ghost
    // has usually not got there — and the one case where it has is the case
    // where this run is behind, so the line would only ever appear as bad news.
    const myFloor = myPoint?.floor ?? 0;
    const shared = Math.min(myFloor, sampleAt(cohort.median?.track, atRound)?.floor ?? 0);
    const paceWords =
      pacePhrase(myTrack, cohort.median?.track, "bosses", 1, "first boss") ||
      (shared > 0 ? pacePhrase(myTrack, cohort.median?.track, "floor", shared, `reached floor ${shared}`) : "") ||
      "";
    setText(readPace, paceWords ? `${paceWords[0].toUpperCase()}${paceWords.slice(1)}.` : "");
    readPace.hidden = !paceWords;
    // Every axis, spelled out, so a viewer can see which of the four a lead is
    // actually made of instead of inferring it from the one line above.
    setText(
      readSpread,
      medianDeltas
        .filter((d) => d.axis !== "xp" && d.delta != null)
        .map((d) => phrase(d.axis, d.delta))
        .join(" · "),
    );

    // --- the ghost line ---------------------------------------------------
    const horizon = Math.max(1, fingerprint?.horizon ?? state?.rounds ?? 40);
    const series: Array<[SVGPathElement, RunPoint[] | undefined]> = [
      [medianLine, cohort.median?.track],
      [bestLine, cohort.best?.track],
      [mineLine, myTrack],
    ];
    let top = 1;
    for (const [, track] of series) {
      for (const point of track ?? []) top = Math.max(top, point.xp);
    }
    if (current != null) top = Math.max(top, current);

    const px = (round: number) => (Math.min(round, horizon) / horizon) * GHOST_W;
    const py = (value: number) => GHOST_H - GHOST_PAD - (value / top) * (GHOST_H - GHOST_PAD * 2);

    for (const [node, track] of series) {
      const points = track ?? [];
      if (!points.length) {
        setAttr(node, "d", "");
        node.style.display = "none";
        continue;
      }
      node.style.display = "";
      const isMine = node === mineLine;
      let d = "";
      for (const point of points) {
        d += `${d ? "L" : "M"}${px(point.round).toFixed(1)} ${py(point.xp).toFixed(1)}`;
      }
      // The live figure extends this run's line past its last published round,
      // so the flame keeps moving between twenty-second history polls.
      if (isMine && current != null) d += `L${px(state?.round ?? atRound).toFixed(1)} ${py(current).toFixed(1)}`;
      setAttr(node, "d", d);
    }

    // The newest markers, not the first: a long run earns more dots than fit,
    // and the ones a viewer is watching for are the recent ones.
    const myMarkers: RunMarker[] = mine ? markersFor(mine).slice(-MARKS) : [];
    for (let i = 0; i < marks.length; i += 1) {
      const dot = marks[i];
      const marker = myMarkers[i];
      if (!marker) {
        dot.style.display = "none";
        continue;
      }
      const point = sampleAt(myTrack, marker.round);
      dot.style.display = "";
      setAttr(dot, "x", (px(marker.round) - 1.5).toFixed(1));
      setAttr(dot, "y", (py(point?.xp ?? 0) - 1.5).toFixed(1));
      setClass(dot, `rec-g-mark is-${marker.kind}`);
    }
    // The caption is the most recent thing that happened to *this* run, which
    // is what the newest dot on the flame line is; the ghosts carry no dots.
    setText(ghostNote, myMarkers.length ? myMarkers[myMarkers.length - 1].label : "ghosts");

    // --- honours ----------------------------------------------------------
    // Final figures, unlike the table above, which is deliberately mid-run:
    // "where did the typical run end up" and "where was it at round twelve" are
    // different questions and the panel answers both rather than blurring them.
    const cell = (slot: StatCell, run: CohortRun | null, fallback: string) => {
      if (run && isScored(run)) {
        setText(slot.value, fmt(run.score));
        const floor = isNum(run.floor) ? ` · floor ${run.floor}` : "";
        const wiped = run.survivors === 0 ? " · wiped" : "";
        setText(slot.sub, `${ago(run.startedAt, now)}${floor}${wiped}`);
      } else {
        setText(slot.value, "—");
        setText(slot.sub, fallback);
      }
    };
    cell(cells[0], cohort.best, "unclaimed");
    cell(cells[1], cohort.median, "no scored run");
    cell(cells[2], cohort.previous, "none finished");

    const today = history?.today ?? { runs: 0, best: null };
    setText(cells[3].value, String(today.runs ?? 0));
    // Explicitly across every configuration, because it is the one figure on
    // this panel that is not cohort-scoped and an unlabelled count would be
    // read as one that is.
    setText(cells[3].sub, "runs today, all configurations");

    // --- ranked list ------------------------------------------------------
    // The current run is put back in here — this is the "where do I rank"
    // question, not the "what am I up against" one.
    const field: CohortRun[] = [...cohort.members];
    if (mine) field.push({ ...mine, score: current ?? mine.score });
    const ranked: ScoredRun[] = field.filter(isScored).sort((a, b) => b.score - a.score);
    // Counted separately from the cohort line above, and said so: this list
    // puts the run on screen back in, and two different run counts on one panel
    // with no explanation reads as one of them being wrong.
    setText(boardCount, `${ranked.length} incl. this one`);

    for (let i = 0; i < rows.length; i += 1) {
      const slot = rows[i];
      const run = ranked[i];
      slot.row.hidden = !run;
      if (!run) continue;
      const own = isCurrent(run);
      slot.row.classList.toggle("is-now", own);
      setText(slot.score, fmt(run.score));
      setText(slot.floor, isNum(run.floor) ? `f${run.floor}` : "");
      // One tag per row, most newsworthy first: that it is happening now beats
      // how it ended, and how it ended beats that it never did.
      let tagText = "";
      let tagClass = "rec-tag";
      if (own) {
        tagText = state?.ended ? "final" : "live";
        tagClass += " is-now";
      } else if (run.survivors === 0) {
        tagText = "wipe";
        tagClass += " is-wipe";
      } else if (!run.finished) {
        tagText = "cut";
      }
      setText(slot.tag, tagText);
      slot.tag.hidden = !tagText;
      setClass(slot.tag, tagClass);
    }

    const myRank = ranked.findIndex(isCurrent) + 1;
    const offList = myRank > TOP_ROWS;
    you.hidden = !offList;
    if (offList) setText(youText, `this run sits #${myRank} of ${ranked.length} in the cohort`);
  };
}

/**
 * "rule-based" out of "rule-based (rehearsal)".
 *
 * A rehearsal records its policy in the model field, which is the honest place
 * for it — the policy is what produced the turns — but the parenthetical is
 * noise on a line that has to fit in 246 pixels.
 */
function policyName(run: CohortRun): string {
  return String(run.model ?? "baseline").replace(/\s*\(rehearsal\)\s*$/i, "");
}
