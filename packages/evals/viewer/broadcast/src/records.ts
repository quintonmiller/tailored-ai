/**
 * The scoreboard: what this run is chasing, and what it is chasing it against.
 *
 * A single run of a fifty-round dungeon is only interesting to a person with no
 * context if it is visibly *part of something* — a number that means "better
 * than yesterday" rather than a number that just gets larger. Every other panel
 * on this page shows the present tense; this one is the only place the viewer
 * finds out whether what they are watching is a good run or a bad one.
 *
 * So the shape here is a sports record board rather than a table of past runs:
 * one enormous figure (the earned XP of the run on screen), one bar showing how
 * much of the record it has eaten, and a short honours list underneath. The
 * ranked table is the *supporting* material, not the headline, because a table
 * is something you read and this page is something you glance at.
 *
 * ## Two rules this module keeps
 *
 * 1. **It never fetches.** `state.js` polls `/history` every twenty seconds and
 *    hands the result over as `state.history`. A renderer that fetched would be
 *    a second thing that can fail, and it would fail on the page rather than in
 *    the store where the retry logic lives.
 * 2. **It builds its DOM once.** `render` is called on every poll that carried
 *    an event — a few times a second during a busy round — and rebuilding the
 *    panel each time would restart every CSS transition, so the whole panel
 *    would sit frozen mid-fade forever. Mount creates the nodes; render only
 *    writes text, classes and transforms into them.
 *
 * ## The run on screen is also a file on disk
 *
 * `/history` reads every `.ndjson` in the trace directory, and the run being
 * broadcast is one of them, half-written. That means `history.best` can be the
 * current run, which would make the panel say "the record is 8,400" while the
 * hero says "you have 8,400" and the gap says "0 to go" — the board would stop
 * being a comparison at exactly the moment it got exciting. Everything that
 * asks "what am I up against" therefore filters the current trace out by
 * filename first; everything that asks "where does this run rank" leaves it in
 * and marks it.
 */

import type { BroadcastState, History, Renderer, RunRecord } from "./types.js";

/** Rows in the honours list. More than this and the type has to shrink below broadcast size. */
const TOP_ROWS = 8;

/** How many past runs the trend chart carries. Fifteen bars is about the most that stays countable. */
const SPARK_RUNS = 15;

/**
 * The chart's internal coordinate space. It is stretched horizontally to
 * whatever width the column has (`preserveAspectRatio="none"`), which is safe
 * only because everything in it is an axis-aligned rectangle or a horizontal
 * line — nothing whose stroke would go visibly oval when squashed.
 */
const SPARK_W = 240;
const SPARK_H = 54;
const SPARK_GAP = 2;

/** Height a full-value bar gets, leaving the top few units as air under the record line. */
const SPARK_PLOT = SPARK_H - 5;

/** Count-up duration for the headline figure. Long enough to read as motion, short enough to finish between polls. */
const TWEEN_MS = 520;

/**
 * Styles live in the module rather than in `style.css` because that file is
 * shared by every panel and this one needs a dozen selectors nobody else wants.
 * The `<style>` goes inside the host element and every rule is prefixed `.rec`,
 * so the panel cannot reach out and restyle the stage even by accident.
 *
 * Colours are all tokens from `style.css`. A panel that invented its own orange
 * would drift away from the rest of the page the first time the palette moved.
 */
const CSS = `
.rec { display: flex; flex-direction: column; gap: 13px; height: 100%; min-height: 0; font-family: var(--sans); }
.rec [hidden] { display: none !important; }

/* ---- hero: this run against the record --------------------------------- */

.rec-hero {
  position: relative;
  padding: 10px 11px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #0d121c;
  transition: background .45s ease, border-color .45s ease, box-shadow .45s ease;
}
.rec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.rec-xp {
  margin: 7px 0 9px;
  font: 700 38px/1 var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
  color: var(--ink);
  transition: color .45s ease;
}
.rec-unit { margin-left: 7px; font: 600 11px/1 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--faint); }
.rec-bar { position: relative; margin-bottom: 8px; }
/* Taller than the shared .meter default: this is the one bar on the page a
   viewer is meant to read from across a room. */
.rec .meter { height: 10px; border-radius: 5px; }
.rec-tick {
  position: absolute; top: -3px; bottom: -3px; width: 2px;
  background: var(--gold); border-radius: 1px;
  transition: left .45s ease;
}
.rec-gap { font: 12px/1.35 var(--sans); color: var(--dim); }
.rec-gap b { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.rec-flag {
  position: absolute; top: -9px; right: 9px;
  padding: 3px 8px; border-radius: 999px;
  font: 700 9px/1 var(--sans); letter-spacing: .18em; text-transform: uppercase;
  color: #20140a; background: var(--flame);
  box-shadow: 0 0 18px -2px rgba(240, 160, 75, .55);
  animation: rec-glow 2.4s ease-in-out infinite;
}
/* Beating the record is the one thing on this panel worth interrupting a viewer
   for, so it is the only state that changes more than a number: the card warms
   up, the figure turns to torchlight, the bar stops being a progress bar. */
.rec.is-record .rec-hero {
  border-color: var(--flame-dim);
  background: linear-gradient(180deg, #1d1409, #0f1219);
  box-shadow: 0 0 0 1px rgba(240, 160, 75, .18), 0 8px 26px -14px rgba(240, 160, 75, .6);
}
.rec.is-record .rec-xp { color: var(--flame); }
.rec.is-record .meter i { background: linear-gradient(90deg, var(--flame-dim), var(--flame)); }
.rec.is-record .rec-gap b { color: var(--flame); }
@keyframes rec-glow { 50% { box-shadow: 0 0 4px 0 rgba(240, 160, 75, .25); } }

/* ---- honours: best, week, today, last ---------------------------------- */

/* A one-pixel gap over the line colour makes the hairline grid of a results
   board without four separate borders that never quite meet at the corners. */
.rec-stats {
  display: grid; grid-template-columns: 1fr 1fr; gap: 1px;
  border: 1px solid var(--line); border-radius: 8px;
  background: var(--line); overflow: hidden;
}
.rec-cell { padding: 7px 9px 8px; background: var(--panel-2); }
.rec-cell .k { display: block; margin-bottom: 6px; }
.rec-cell-v { font: 600 19px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.rec-cell-s { display: block; margin-top: 5px; font: 11px/1.2 var(--sans); color: var(--faint); }
.rec-cell.is-gold .rec-cell-v { color: var(--gold); }

/* ---- the ranked list --------------------------------------------------- */

.rec-board { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.rec-board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
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
.rec-rank { font: 600 11px/1 var(--mono); color: var(--faint); }
.rec-row.is-now .rec-rank { color: var(--flame); }
.rec-score { text-align: right; font: 600 14px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.rec-floor { font: 11px/1 var(--mono); font-variant-numeric: tabular-nums; color: var(--dim); }
.rec-tag {
  padding: 2px 5px; border: 1px solid var(--line); border-radius: 3px;
  font: 9px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--faint);
}
.rec-tag.is-wipe { color: var(--bad); border-color: #4a2725; }
.rec-tag.is-now { color: var(--flame); border-color: var(--flame-dim); }
.rec-you { margin-top: 7px; font: 11px/1.3 var(--sans); color: var(--dim); font-variant-numeric: tabular-nums; }

/* ---- trend ------------------------------------------------------------- */

.rec-spark { flex: 0 0 auto; }
.rec-spark svg { display: block; width: 100%; height: ${SPARK_H}px; margin-top: 7px; }
/* Bars are full-height rectangles scaled from their own bottom edge rather than
   rectangles whose height changes: scaling composites, and SVG geometry
   attributes do not transition consistently across browsers anyway. */
.rec-b {
  fill: var(--faint); opacity: .55;
  transform-box: fill-box; transform-origin: bottom;
  transition: transform .45s ease, opacity .3s ease;
}
.rec-b.is-best { fill: var(--gold); opacity: .9; }
.rec-b.is-now { fill: var(--flame); opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .rec-hero, .rec-xp, .rec-tick, .rec-row, .rec-b, .rec .meter i { transition: none; }
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

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

/** A trace path from `/events` and a filename from `/history` have to be comparable. */
function base(path: string | null | undefined) {
  return String(path ?? "").split(/[\\/]/).pop() ?? "";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * A run that reported a headline figure.
 *
 * `RunRecord.score` is nullable and legitimately so: a scenario whose
 * simulation publishes no score, and a run that ended before it earned
 * anything, are both real rows with no number in them. Everything on this panel
 * that subtracts, sorts or scales filters down to this type first, which is why
 * none of the arithmetic below has to ask again.
 */
type ScoredRun = RunRecord & { score: number };

const isScored = (run: RunRecord): run is ScoredRun => isNum(run.score);

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

/** Highest score in a list, as the whole record so the caller can also ask when it happened. */
function bestOf(rows: readonly RunRecord[]): ScoredRun | null {
  let best: ScoredRun | null = null;
  for (const row of rows) {
    if (!isScored(row)) continue;
    if (!best || row.score > best.score) best = row;
  }
  return best;
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

/**
 * One column of the trend chart.
 *
 * A bar is its rectangle and nothing else — there is no per-bar label or hit
 * area to keep alongside it — so the handle is the element. It is named anyway
 * because `SVGRectElement[]` at the point of use says what the array holds and
 * not what it is *for*.
 */
type SparkBar = SVGRectElement;

/** A plotted run: the figure it scored, and whether it is the one on screen. */
interface SparkPoint {
  value: number;
  now: boolean;
}

/**
 * Build the panel once and hand back the renderer.
 *
 * Everything below is created here — including every leaderboard row and every
 * chart bar, at their maximum count — so that `render` never calls
 * `createElement`. Rows and bars that have no data are hidden rather than
 * removed, which keeps their CSS transitions alive across a run where the
 * ranking shuffles.
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

  // --- honours ------------------------------------------------------------
  const stats = el("section", "rec-stats");
  const cells: StatCell[] = ["record to beat", "this week", "today", "last run"].map((label) => {
    const cell = el("div", "rec-cell");
    const value = el("span", "rec-cell-v", "—");
    const sub = el("span", "rec-cell-s");
    cell.append(el("span", "k", label), value, sub);
    stats.append(cell);
    return { cell, value, sub };
  });
  cells[0].cell.classList.add("is-gold");

  // --- ranked list --------------------------------------------------------
  const board = el("section", "rec-board");
  const boardHead = el("div", "rec-board-head");
  const boardCount = el("span", "k");
  boardHead.append(el("span", "k", "all time"), boardCount);
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

  // --- trend --------------------------------------------------------------
  const spark = el("section", "rec-spark");
  const sparkHead = el("div", "rec-board-head");
  const sparkLabel = el("span", "k", "recent runs");
  sparkHead.append(sparkLabel, el("span", "k", "oldest → now"));
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");

  // The record, drawn across the chart, so the bars visibly reach for a line
  // rather than for the top of an arbitrary box.
  const recordLine = svgEl("path");
  recordLine.setAttribute("stroke", "var(--gold)");
  recordLine.setAttribute("stroke-width", "1");
  recordLine.setAttribute("opacity", "0.5");
  recordLine.setAttribute("fill", "none");
  recordLine.setAttribute("d", `M0 1 H${SPARK_W}`);

  const baseline = svgEl("path");
  baseline.setAttribute("stroke", "var(--line)");
  baseline.setAttribute("stroke-width", "1");
  baseline.setAttribute("fill", "none");
  baseline.setAttribute("d", `M0 ${SPARK_H - 0.5} H${SPARK_W}`);

  // Every bar is the same full-height rectangle, sitting on the baseline. Only
  // its horizontal position and its vertical scale ever change, so the vertical
  // half of the chart animates on the compositor and the geometry attributes
  // are written once, here.
  const bars: SparkBar[] = [];
  for (let i = 0; i < SPARK_RUNS; i += 1) {
    const rect = svgEl("rect");
    rect.setAttribute("class", "rec-b");
    rect.setAttribute("y", String(SPARK_H - SPARK_PLOT));
    rect.setAttribute("height", String(SPARK_PLOT));
    rect.style.transform = "scaleY(0)";
    rect.style.display = "none";
    svg.append(rect);
    bars.push(rect);
  }
  svg.append(baseline, recordLine);
  spark.append(sparkHead, svg);

  // --- the nothing-to-show case ------------------------------------------
  const none = el("div", "empty");
  none.hidden = true;

  root.append(hero, stats, board, spark, none);
  host.replaceChildren(root);

  /* ---------------------------------------------------------------------- */
  /* render                                                                  */
  /* ---------------------------------------------------------------------- */

  return function render(state: BroadcastState) {
    const now = Date.now();
    const history: History | null = state?.history ?? null;
    const runs = Array.isArray(history?.runs) ? history.runs : [];

    // The run on screen, as a row in its own history. See the header comment:
    // it is on disk like every other run and has to be excluded from anything
    // that is meant to be a rival.
    const currentFile = base(state?.file);
    const isCurrent = (r: RunRecord) => !!currentFile && r.file === currentFile;
    const mine = runs.find(isCurrent) ?? null;

    const scored = runs.filter(isScored);
    const record = bestOf(scored.filter((r) => !isCurrent(r)));

    // The live scene is fresher than the trace summary — `/history` is polled
    // every twenty seconds, the scene every round — so it wins when both exist.
    const liveScore = isNum(state?.scene?.earnedXp) ? state.scene.earnedXp : null;
    const current = liveScore ?? (isNum(mine?.score) ? mine.score : null);

    const ahead = current != null && record != null && current > record.score;
    const haveAny = scored.length > 0;

    root.classList.toggle("is-record", !!ahead);

    // --- hero -------------------------------------------------------------
    // Worth showing only if there is either a run in progress or a record; with
    // neither, the empty line below carries the whole panel.
    hero.hidden = current == null && record == null;
    if (!hero.hidden) {
      setText(heroLabel, ahead ? "record broken" : record ? "chasing the record" : "first on the board");

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
        // No record and a live figure means every scored run on file is this
        // one, whether that is because it is the first ever or because it is
        // the first to score.
        setText(gapText, "nothing to beat — this run sets the record");
      } else if (ahead) {
        gapNum.hidden = false;
        setText(gapNum, `+${fmt(current - record.score)}`);
        setText(gapText, ` clear of ${fmt(record.score)}, set ${ago(record.startedAt, now)}`);
      } else if (current === record.score) {
        gapNum.hidden = true;
        setText(gapNum, "");
        setText(gapText, `level with the record of ${fmt(record.score)}`);
      } else {
        gapNum.hidden = false;
        setText(gapNum, fmt(record.score - current));
        setText(gapText, ` behind the record of ${fmt(record.score)}`);
      }
      flag.hidden = !ahead;
    }

    // --- the degenerate cases --------------------------------------------
    // Runs on file but none of them scored, or no file at all. Both are real:
    // the first run of a new scenario hits the second, and a scenario whose
    // simulation reports no headline figure hits the first forever.
    stats.hidden = !haveAny;
    board.hidden = !haveAny;
    spark.hidden = !haveAny;
    none.hidden = haveAny;
    if (!haveAny) {
      if (!history) {
        setText(none, "reading the archive…");
      } else if (!runs.length) {
        setText(none, "no past runs yet — this one is the whole record book.");
      } else {
        const floors = runs.map((r) => r.floor).filter(isNum);
        const deepest = floors.length ? `, deepest floor ${Math.max(...floors)}` : "";
        setText(none, `${runs.length} run${runs.length === 1 ? "" : "s"} on file, none scored${deepest}.`);
      }
      return;
    }

    // --- honours ----------------------------------------------------------
    if (record) {
      setText(cells[0].value, fmt(record.score));
      const floor = isNum(record.floor) ? ` · floor ${record.floor}` : "";
      setText(cells[0].sub, `${ago(record.startedAt, now)}${floor}`);
    } else {
      setText(cells[0].value, "—");
      setText(cells[0].sub, "unclaimed");
    }

    const week = history?.week ?? { runs: 0, best: null };
    setText(cells[1].value, isNum(week.best) ? fmt(week.best) : "—");
    setText(cells[1].sub, `${week.runs ?? 0} run${week.runs === 1 ? "" : "s"}`);

    const today = history?.today ?? { runs: 0, best: null };
    setText(cells[2].value, isNum(today.best) ? fmt(today.best) : "—");
    setText(cells[2].sub, `${today.runs ?? 0} run${today.runs === 1 ? "" : "s"}`);

    // "Last run" means the last one that is not the one playing — otherwise the
    // moment this run ends the cell starts comparing it against itself.
    const prev = runs.find((r) => r.finished && !isCurrent(r)) ?? null;
    if (prev) {
      setText(cells[3].value, isNum(prev.score) ? fmt(prev.score) : "—");
      const wiped = prev.survivors === 0 ? " · wiped" : "";
      setText(cells[3].sub, `${ago(prev.startedAt, now)}${wiped}`);
    } else {
      setText(cells[3].value, "—");
      setText(cells[3].sub, "none finished");
    }

    // --- ranked list ------------------------------------------------------
    const ranked = scored.slice().sort((a, b) => b.score - a.score);
    setText(boardCount, `${runs.length} run${runs.length === 1 ? "" : "s"}`);

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
      if (slot.tag.className !== tagClass) slot.tag.className = tagClass;
    }

    // Searched by identity rather than `indexOf`, because the current run need
    // not be a `ScoredRun` at all: an unscored run is simply not in `ranked`,
    // the search misses, and rank 0 keeps the line below hidden — which is the
    // right answer for a run with no figure to place.
    const myRank = mine ? ranked.findIndex((r) => r === mine) + 1 : 0;
    const offList = myRank > TOP_ROWS;
    you.hidden = !offList;
    if (offList) setText(youText, `this run sits #${myRank} of ${ranked.length}`);

    // --- trend ------------------------------------------------------------
    // `runs` arrives newest first; a chart that reads left to right in time is
    // the only orientation in which "it is getting better" is a shape rather
    // than a thing you have to work out.
    const series: SparkPoint[] = scored
      .slice(0, SPARK_RUNS)
      .reverse()
      .map((r) => ({ value: isCurrent(r) && liveScore != null ? liveScore : r.score, now: isCurrent(r) }));
    // A run whose trace has not been picked up by the twenty-second history
    // poll yet still deserves its bar, or the newest column is missing for the
    // first few seconds of every broadcast.
    //
    // Two ways the current run can be absent from `scored`, and the guard has to
    // cover both: its trace has not been read at all, *or* it has been read and
    // carries no figure yet. The second only became visible when `score` was
    // typed nullable — with `!mine` alone, a run polled between its first event
    // and its first scene had no bar at all.
    if (current != null && (!mine || !isScored(mine))) series.push({ value: current, now: true });
    if (series.length > SPARK_RUNS) series.splice(0, series.length - SPARK_RUNS);

    setText(sparkLabel, `last ${series.length} run${series.length === 1 ? "" : "s"}`);

    const top = Math.max(1, record?.score ?? 0, ...series.map((s) => s.value));
    const peak = Math.max(...series.map((s) => s.value));
    // Capped and right-aligned rather than stretched to fill: with three runs on
    // file, bars eighty units wide read as a filled block instead of a chart,
    // and the newest run has to stay under the "now" end of the axis whatever
    // the count.
    const width = Math.min(18, (SPARK_W - SPARK_GAP * (series.length - 1)) / Math.max(1, series.length));
    const startX = SPARK_W - (series.length * width + SPARK_GAP * (series.length - 1));
    /** A run that scored almost nothing still happened; an invisible bar reads as missing data. */
    const floorScale = 2 / SPARK_PLOT;

    for (let i = 0; i < bars.length; i += 1) {
      const rect = bars[i];
      const point = series[i];
      if (!point) {
        rect.style.display = "none";
        continue;
      }
      rect.style.display = "";
      rect.setAttribute("x", (startX + i * (width + SPARK_GAP)).toFixed(2));
      rect.setAttribute("width", width.toFixed(2));
      rect.style.transform = `scaleY(${Math.max(floorScale, point.value / top).toFixed(4)})`;
      const cls = point.now ? "rec-b is-now" : point.value === peak ? "rec-b is-best" : "rec-b";
      if (rect.getAttribute("class") !== cls) rect.setAttribute("class", cls);
    }

    const y = record ? Math.max(0.5, SPARK_H - (record.score / top) * SPARK_PLOT) : 0;
    recordLine.setAttribute("d", `M0 ${y.toFixed(2)} H${SPARK_W}`);
    recordLine.style.display = record ? "" : "none";
  };
}
