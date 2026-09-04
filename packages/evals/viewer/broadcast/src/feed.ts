/**
 * The three text panels: what the party said, what happened, and what the
 * commentary made of it.
 *
 * These are the panels a person with no context actually reads. The stage shows
 * a fight and the HUD shows five bars, but the reason anybody watches a party of
 * agents rather than a party of scripts is that the agents argue about what to
 * do — so the chat column gets the typographic care usually spent on a headline,
 * and the log column is deliberately *smaller* than the developer viewer's
 * stream rather than larger.
 *
 * ## Less, not more
 *
 * `/` already shows every event with filters over it, and it is the right tool
 * for finding out why a party died. Repeating it here at a larger font would
 * just be the same wall further away. So the log drops `look` (five agents check
 * the sheet every round; nobody watching learns anything from it) and
 * `room action=pass` (126 of 332 calls in a sample run were exactly that), turns
 * the survivors into one plain English sentence each, and gives the space to the
 * combat prose the simulation already writes — "rogue drives a blade into Elite
 * Greater Crystal Warden for 171" needs no help from a renderer.
 *
 * ## Nothing here invents an audience
 *
 * Twitch-shaped layouts invite a fake chat, and a fabricated crowd next to real
 * telemetry makes the real half look invented too. The chat panel carries agent
 * traffic and nothing else. `attachExternalChat()` is the seam a genuine IRC
 * feed can push into, and it is inert unless somebody wires a real channel to
 * it — see the "Chat" section of docs/broadcast-viewer.md.
 *
 * ## Append, never rebuild
 *
 * The store polls every 700ms. Re-rendering a list on that cadence throws away
 * scroll position, restarts every animation, and makes text impossible to read
 * on a stream because it flickers four times a paragraph. Every panel here
 * diffs against what it already put in the DOM and appends the difference, and
 * auto-scroll only fires for a reader who was already at the bottom.
 *
 * ## Everything inserted is text
 *
 * Agent output is model output: untrusted, occasionally full of angle brackets,
 * and never HTML. There is no `innerHTML` in this file outside the stylesheet it
 * owns — every string reaches the page through `textContent`, which cannot be
 * escaped wrongly because it is not parsed at all.
 */

import { type Happening, happenings } from "./happenings.js";
import { type MarkName, mark } from "./marks.js";
import { expandInto, NAMES_CSS } from "./names.js";
import { isPhrased, PHRASES, type Stripe, stripeFor as toolStripe } from "./vocabulary.js";
import type {
  BroadcastState,
  ClassId,
  FeedCall,
  FeedItem,
  FeedRound,
  FeedSay,
  NarrationLine,
  Renderer,
  Scene,
} from "./types.js";

// ---------------------------------------------------------------------------
// What a panel is
// ---------------------------------------------------------------------------

/**
 * The state a panel draws from.
 *
 * `Partial`, because a panel is mounted before the first poll answers and is
 * handed whatever the store has by then — including nothing. Every read below
 * is written for that, and saying so here keeps those checks from reading as
 * superstition.
 */
type PanelState = Partial<BroadcastState>;

/** A mounted panel: hand it state, it appends the difference. */
type PanelRenderer = (state: PanelState) => void;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The five classes, and the tokens the rest of the page uses for them.
 *
 * Agent names in this scenario *are* the class ids, so a speaker maps straight
 * to a colour. Anyone else who appears (a harness clock, a stranger in an
 * external chat) gets neutral ink rather than a borrowed class colour — two
 * things sharing the rogue's purple is worse than one of them being grey.
 */
const CLASS_COLOUR: Record<ClassId, string> = {
  guardian: "var(--guardian, #d8b45a)",
  mage: "var(--mage, #7b8ff5)",
  rogue: "var(--rogue, #b06fd6)",
  cleric: "var(--cleric, #5fb98a)",
  ranger: "var(--ranger, #4fb3c4)",
};

/**
 * Is this arbitrary word one of the five?
 *
 * Every lookup into the table starts as untyped text — a speaker's name, a word
 * split out of the simulation's prose, the target of a call — so membership is
 * the question actually being asked, and the answer is what keeps a stranger
 * out of the party's colours.
 */
function isClassId(name: string): name is ClassId {
  // `hasOwn`, for the same reason the phrase table uses it: `"constructor" in
  // CLASS_COLOUR` is true, and an agent called `toString` would come out tinted
  // like a party member. Milder than the log's version of this bug — a
  // mis-coloured word rather than a thrown frame — and the same one-word fix.
  return Object.hasOwn(CLASS_COLOUR, name);
}

/** The colour for a name, or `undefined` for anybody who is not one of the five. */
function classColour(name: string): string | undefined {
  return isClassId(name) ? CLASS_COLOUR[name] : undefined;
}

/** Tool calls that say nothing to a viewer. See the file header. */
const SILENT_TOOLS = new Set(["look"]);

/**
 * Room actions worth dropping.
 *
 * `post` is dropped because the store already turned it into a `say` — showing
 * both would double every sentence. `pass` is dropped because "said nothing"
 * five times a round is the loudest thing in an unfiltered log and the least
 * informative.
 */
const SILENT_ROOM_ACTIONS = new Set([
  "pass",
  "post",
  "read",
  "list",
  "members",
  "react",
  "subscribe",
  "unsubscribe",
  "purpose",
]);


/** Which argument names name a *thing* and so want the lexicon. */
const NAMED_ARGS = new Set(["target", "item", "ally"]);

// ---------------------------------------------------------------------------
// What kind of thing just happened
// ---------------------------------------------------------------------------

/**
 * The stripes a viewer learns in the first thirty seconds.
 *
 * Every row in this panel used to be the same faint grey sentence, which meant
 * the only way to find out whether the party had just moved, bought something,
 * fallen back, or levelled up was to read all of it. That is the one thing a
 * broadcast cannot ask for. So each row carries a shape and an edge colour, and
 * the two together are learnable without a legend: gold is a thing you own,
 * amber is going backwards, verdigris is the dungeon itself.
 *
 * Kept coarse on purpose. Ten stripes is already at the limit of what somebody
 * can hold after a minute of watching, and a taxonomy nobody has internalised
 * is decoration.
 *
 * The table itself lives in `vocabulary.ts`; see that file for why.
 */

/** The shape each stripe is drawn with. Shape carries the meaning; colour repeats it. */
const STRIPE_MARK: Record<Stripe, MarkName> = {
  combat: "combat",
  support: "heal",
  consumable: "consumable",
  gear: "equip",
  trade: "trade",
  move: "move",
  retreat: "retreat",
  growth: "levelup",
  scout: "scout",
  speech: "speak",
  quiet: "nodamage",
};

/**
 * Which stripe a tool belongs to.
 *
 * Typed open for the same reason `PHRASES` is: the tool name arrives from the
 * trace, and an ability added to the bestiary since this was written should get
 * the dull default rather than crash the row.
 */


/** The stripe a derived event wears. The kinds are closed, so this table is total. */
const HAPPENING_STRIPE: Record<Happening["kind"], Stripe> = {
  move: "move",
  descend: "move",
  retreat: "retreat",
  opportunity: "combat",
  kill: "combat",
  loot: "gear",
  equip: "gear",
  levelup: "growth",
  talent: "growth",
  nodamage: "quiet",
  wasted: "quiet",
};

/** …and the shape, where it is more specific than the stripe's own. */
const HAPPENING_MARK: Record<Happening["kind"], MarkName> = {
  move: "move",
  descend: "descend",
  retreat: "retreat",
  opportunity: "opportunity",
  kill: "enemy",
  loot: "give",
  equip: "equip",
  levelup: "levelup",
  talent: "talent",
  nodamage: "nodamage",
  wasted: "nodamage",
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * The module ships its own stylesheet.
 *
 * `style.css` holds the page's tokens and layout and is owned by the shell;
 * three panels' worth of typography does not belong in it, and a rule that only
 * this file's markup can match is easier to read next to the markup. Tokens
 * still come from `:root`, so a palette change in `style.css` moves these
 * panels with it.
 */
const CSS = `
.bcf { display: flex; flex-direction: column; gap: 2px; }
.bcf-scroll { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.bcf-scroll::-webkit-scrollbar { width: 8px; }
.bcf-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

/* ---- chat ---- */

/*
 * A measure, not a column width. The panel is 320px of a 16:9 stage and the
 * body is the one place on the page carrying whole paragraphs, so it gets the
 * largest body type here and the tightest line length the box allows.
 */
/* A thought, which is not speech and must not be mistakable for it. Same column
   and same clock as everything else, but set in the dim ink the page uses for
   things nobody in the run can hear, indented behind a bubble, and italic. The
   dashed left edge is the tell: a viewer should be able to tell at a glance
   that the party did not hear this. */
.bcf-think {
  margin: 5px 2px 7px 10px; padding: 6px 9px;
  border-left: 2px dashed color-mix(in srgb, var(--arcane) 55%, transparent);
  background: color-mix(in srgb, var(--arcane) 6%, transparent);
  border-radius: 0 4px 4px 0;
}
/* Only the body is italic and dimmed. The head keeps the same weight and the
   same class colour as a spoken line, so the eye finds the name in the same
   place whether the character said it or only thought it. */
.bcf-think .bcf-body, .bcf-think .det {
  font: italic 13px/1.45 var(--sans); color: var(--dim); overflow-wrap: anywhere;
}
.bcf-think .mark { color: var(--arcane); }
.bcf-think .bcf-tag { color: var(--arcane); border-color: color-mix(in srgb, var(--arcane) 45%, transparent); }

.bcf-msg { padding: 7px 2px 8px; border-top: 1px solid transparent; }
.bcf-msg + .bcf-msg { border-top-color: color-mix(in srgb, var(--line) 55%, transparent); }
.bcf-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 3px; }
.bcf-who { font: 600 15px/1.2 var(--sans); letter-spacing: 0.01em; }
.bcf-tag {
  font: 12px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--faint); border: 1px solid var(--line); border-radius: 3px; padding: 2px 4px;
}
.bcf-at { margin-left: auto; font: 12px/1 var(--mono); color: var(--faint); font-variant-numeric: tabular-nums; }

/*
 * Never clamped. This was four lines with a fade, which is a kinder truncation
 * than an ellipsis and still a truncation: agents routinely write five and six
 * sentences, and the sentence that says *why* is usually the last one. The
 * panel scrolls, so the cost of a long message is scrolling — which a viewer
 * can undo — rather than deletion, which they cannot.
 */
.bcf-body {
  font: 15px/1.5 var(--sans); color: var(--ink);
  overflow-wrap: anywhere; white-space: pre-wrap;
}
.bcf-msg.external .bcf-who { color: var(--dim); }
.bcf-msg.external .bcf-body { color: var(--dim); font-size: 14px; }

/* ---- log ---- */

/*
 * The round rule is the spine. Everything under it happened in that round, and
 * a flat list with rules appends in one operation where a container per round
 * would need one built, filled and closed across three separate polls.
 */
.bcf-rule {
  display: flex; align-items: baseline; gap: 8px;
  margin: 12px 0 5px; padding-top: 7px; border-top: 1px solid var(--line);
}
.bcf-rule:first-child { margin-top: 0; border-top: none; padding-top: 0; }
.bcf-rule .n {
  font: 600 12px/1 var(--sans); letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--flame);
}
.bcf-rule .where { font: 13px/1.3 var(--mono); color: var(--dim); }
.bcf-over { margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--flame-dim);
  font: 600 13px/1.4 var(--sans); letter-spacing: 0.08em; color: var(--flame); }

/* The simulation's own combat prose: the most readable thing in the run. */
.bcf-prose { font: 15px/1.45 var(--sans); color: var(--dim); padding: 2px 0 2px 2px; }
/* Whoever is named, wherever they are named. Colour is carried inline so the
   party's five colours stay in one table rather than in two. */
.bcf .name { font-weight: 600; }
.bcf .n { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }

/* A collapsed tool call. Secondary to the prose on purpose. */
.bcf-act {
  display: flex; align-items: baseline; gap: 6px;
  font: 14px/1.4 var(--sans); color: var(--faint); padding: 2px 0 2px 7px;
  border-left: 2px solid transparent;
}
.bcf-act .who { font-weight: 600; }
.bcf-act .verb { color: var(--dim); }
.bcf-act .said { color: var(--dim); font-style: italic; }
.bcf-act .x { color: var(--bad); font: 13px/1 var(--mono); }
.bcf-act.no .verb { color: color-mix(in srgb, var(--bad) 55%, var(--faint)); }
.bcf-act .why { color: color-mix(in srgb, var(--bad) 40%, var(--faint)); font-size: 13px; }
.bcf-act .times {
  font: 12px/1 var(--mono); color: var(--faint);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 5px; margin-left: 2px;
}

/* ---- what kind of thing a row is ---- */

/*
 * One stripe per kind, carried by the edge and by the shape at the head of the
 * row. Both, not either: the edge is what the eye finds when it scans the
 * column, and the shape is what survives a viewer who cannot separate the
 * colours. Neither is asked to work alone.
 */
.bcf-act .mark, .bcf-ev .mark {
  color: var(--stripe, var(--faint));
  /* Pinned to the first line rather than centred: these rows wrap to two or
     three lines and a centred icon drifts into the middle of a paragraph. */
  align-self: flex-start; margin-top: 3px;
}
.bcf-act[data-stripe], .bcf-ev { border-left-color: color-mix(in srgb, var(--stripe) 55%, transparent); }

[data-stripe="combat"] { --stripe: var(--cat-enemy); }
[data-stripe="support"] { --stripe: var(--good); }
[data-stripe="consumable"] { --stripe: var(--cat-consumable); }
[data-stripe="gear"] { --stripe: var(--cat-loot); }
[data-stripe="trade"] { --stripe: var(--gold); }
[data-stripe="move"] { --stripe: var(--cat-feature); }
[data-stripe="retreat"] { --stripe: var(--warn); }
[data-stripe="growth"] { --stripe: var(--arcane); }
[data-stripe="scout"] { --stripe: var(--rogue); }
[data-stripe="speech"] { --stripe: var(--dim); }
[data-stripe="quiet"] { --stripe: var(--faint); }

/*
 * A thing that actually happened, as opposed to a thing somebody asked for.
 *
 * A tool call is an intention — choosing a path says a party member would like
 * to go somewhere, and the round may close without it — so the two are drawn
 * differently on purpose. These rows are diffed out of the scenes themselves and
 * are therefore the only lines in the panel that are guaranteed true, which is
 * why they get the ink and the solid edge and the calls stay grey.
 */
/* A grid rather than a row: the panel is 270px wide and a detail pinned to the
   right of the sentence squeezed every line into three. The shape stays put and
   the qualifier drops underneath, which is the same reading order and half the
   height. */
.bcf-ev {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 6px;
  margin: 3px 0; padding: 4px 6px 5px 7px;
  font: 14px/1.35 var(--sans); color: var(--ink);
  border-left: 2px solid var(--stripe);
  background: color-mix(in srgb, var(--stripe) 8%, transparent);
}
.bcf-ev b { font-weight: 600; grid-column: 2; }
.bcf-ev .det {
  grid-column: 2;
  font: 12px/1.35 var(--mono); color: var(--dim);
  /* Wraps rather than ellipsising. This is the line that says which item, which
     affix, how much gold — the specific half of the event — and a detail cut at
     the column edge is the half a viewer wanted. */
  overflow-wrap: anywhere;
}
/* Nothing landed is a quiet fact, not an alarm: it gets the shape and the word
   and none of the wash the other events carry. */
.bcf-ev[data-stripe="quiet"] { background: none; color: var(--dim); }
.bcf-ev[data-stripe="quiet"] b { font-weight: 400; }

/* ---- narration ---- */

.bcf-quote { font: 16.5px/1.45 var(--sans); color: var(--ink); }
.bcf-quote .r {
  display: block; font: 12px/1 var(--mono); letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--faint); margin-bottom: 6px;
}
.bcf-prev { font: 14px/1.4 var(--sans); color: var(--faint); margin-bottom: 8px; }
.bcf-off { font: 14px/1.5 var(--sans); color: var(--faint); }
.bcf-off code {
  display: inline-block; margin-top: 6px; padding: 4px 7px;
  font: 13px/1 var(--mono); color: var(--dim);
  background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px;
}

/* ---- motion ---- */

@keyframes bcf-in { from { opacity: 0; transform: translateY(5px); } }
.bcf-new { animation: bcf-in 0.32s ease-out both; }
@media (prefers-reduced-motion: reduce) {
  .bcf-new { animation: none; }
}
`;

/** Inject once, however many times the module is mounted. */
function ensureStyles() {
  if (document.getElementById("bcf-css")) return;
  const style = document.createElement("style");
  style.id = "bcf-css";
  style.textContent = `${CSS}\n${NAMES_CSS}`;
  document.head.append(style);
}

/**
 * A message body with its identifiers expanded.
 *
 * The only place text an agent wrote reaches the page, so it is built from DOM
 * nodes end to end — see the note on `expandInto`.
 */
function speak(text: string, names: Lexicon): HTMLDivElement {
  const body = document.createElement("div");
  body.className = "bcf-body";
  expandInto(body, text, (id) => names.of(id), (id) => names.has(id));
  return body;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * `el("div", "bcf-act", "guardian attacks")` — text goes in as text, always.
 *
 * Generic over the tag so the caller gets the real element back: `el("span", …)`
 * is a `HTMLSpanElement` and so has the `.style` the colouring below sets, which
 * a bare `HTMLElement` return would have hidden.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  text?: string | number | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

const REDUCED = window.matchMedia?.("(prefers-reduced-motion: reduce)");

/** Wall-clock, seconds included: a stream viewer reads pace off the seconds. */
function clock(at: number | undefined): string {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toTimeString().slice(0, 8);
}

/** Trim to a whole word. Used where a hard clamp would land mid-word. */
function toWord(text: string | null | undefined, limit: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}…`;
}

/** `husk-1` with nothing better known about it. Not pretty; still readable. */
function titleise(id: unknown): string {
  return String(id ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Was the reader at the bottom *before* this batch was appended?
 *
 * The whole point of asking first: a viewer who has scrolled up to re-read an
 * argument must not be yanked back down every 700ms, and a viewer watching live
 * must never have to chase the newest line. The 48px slack is there because a
 * fractional scroll height means an exact comparison is false on most frames.
 */
function atBottom(host: HTMLElement): boolean {
  return host.scrollHeight - host.scrollTop - host.clientHeight < 48;
}

function stick(host: HTMLElement, smooth: boolean): void {
  const top = host.scrollHeight;
  if (smooth && !REDUCED?.matches) host.scrollTo({ top, behavior: "smooth" });
  else host.scrollTop = top;
}

/** Keep the DOM bounded. Oldest goes; a broadcast has no history to protect. */
function trim(host: HTMLElement, max: number): void {
  // The count guarantees a first child, but only to a reader — asking for it and
  // stopping if it is missing costs a line and cannot spin.
  while (host.childElementCount > max) {
    const oldest = host.firstElementChild;
    if (!oldest) break;
    oldest.remove();
  }
}

/** What one turn of the cursor below found. */
interface Tail<T> {
  /** Everything that arrived since the last call. */
  fresh: T[];
  /** The array was replaced or lost its anchor: throw the panel away and rebuild. */
  reset: boolean;
}

/**
 * An incremental cursor over one of the store's append-only arrays.
 *
 * The store caps `feed` and `said` by splicing off the front, so a plain
 * "render everything past index N" desynchronises the moment the cap is hit —
 * indices shift under it and new messages stop appearing. Anchoring on the last
 * item *object* instead survives the splice: the anchor sits at the end of the
 * array, so it can only be lost if a full cap's worth of items arrived inside
 * one poll, and a rebuild is the honest answer when that happens.
 *
 * A replaced array (the store does `state.said = []` when a new run starts under
 * the same name) is caught by identity, which is why the reset is exact rather
 * than guessed at from a length going backwards.
 */
function tailer<T>(): (list: T[] | undefined) => Tail<T> {
  let source: T[] | null = null;
  let anchor: T | null = null;
  return (list) => {
    const items = Array.isArray(list) ? list : [];
    if (items === source && anchor !== null) {
      const i = items.indexOf(anchor);
      if (i >= 0) {
        anchor = items.length ? items[items.length - 1] : null;
        return { fresh: items.slice(i + 1), reset: false };
      }
    }
    const reset = items !== source;
    source = items;
    anchor = items.length ? items[items.length - 1] : null;
    return { fresh: items.slice(), reset };
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The two halves of a name store: take names in, hand names out. */
interface Lexicon {
  /** Take in everything the current scene knows. Safe to call every poll. */
  learn(scene: Scene | null | undefined): void;
  /** The best name known for a ref, falling back to a readable version of it. */
  of(id: unknown): string;
  /**
   * Whether this ref has a *real* name, as opposed to a titleised id.
   *
   * `of` can never say no — it always returns something printable, which is
   * right for a log line and wrong for the identifier expander, where the whole
   * decision is "do we know what this is". Without this, an unknown id would be
   * dressed up as a name and a viewer would have no way to tell an invented
   * label from a real one.
   */
  has(id: unknown): boolean;
}

/**
 * Everything the scene has ever told us a ref is called.
 *
 * Kept across rounds rather than read from the current scene, because a call is
 * described after the fact and the thing it names is regularly dead by then —
 * "guardian attacks husk-1" is exactly the line where the reader most wants the
 * word "husk-1" to say Ash Husk instead. Item ids get the same treatment from
 * the merchant's stock and the party's packs.
 */
function lexicon(): Lexicon {
  const names = new Map<string, string>();
  /**
   * Learn one list's worth of `id → name`.
   *
   * The id sits under a different key per list (`ref` on enemies, `id` on
   * everything else), and the reader is passed in rather than the key's name
   * because each list has its own declared shape: a string key would have to be
   * indexed into those shapes blindly, where a reader is checked against them.
   */
  const learnList = <T extends { name: string }>(
    list: readonly (T | null | undefined)[] | undefined,
    idOf: (row: T) => string | undefined,
  ): void => {
    for (const row of list ?? []) {
      if (!row) continue;
      const id = idOf(row);
      if (id && row.name) names.set(String(id), String(row.name));
    }
  };
  return {
    learn(scene) {
      if (!scene) return;
      for (const member of scene.party ?? []) {
        if (member.identity?.displayName) names.set(member.id, member.identity.displayName);
      }
      learnList(scene.enemies, (enemy) => enemy.ref);
      learnList(scene.stock, (item) => item.id);
      learnList(scene.loot, (item) => item.id);
      for (const member of scene.party ?? []) {
        learnList(member?.pack, (item) => item.id);
        learnList(member?.worn, (item) => item.id);
      }
      // Rooms carry `label` rather than `name`, and they are the ref the party
      // says most often — every `choose_path` argument is one.
      for (const room of scene.floorMap?.rooms ?? []) {
        if (room?.id && room.label) names.set(String(room.id), String(room.label));
      }
      for (const path of scene.paths ?? []) {
        if (path?.id && path.label) names.set(String(path.id), String(path.label));
      }
    },
    of(id) {
      const key = String(id ?? "").trim();
      if (!key) return "";
      return names.get(key) ?? titleise(key);
    },
    has(id) {
      const key = String(id ?? "").trim();
      return key.length > 0 && names.has(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Turning a call into a sentence
// ---------------------------------------------------------------------------

/** Fill `{target}`-style holes from the call's arguments. */
function fill(template: string, args: Record<string, unknown>, names: Lexicon): string {
  return template
    .replace(/\{(\w+)\}/g, (_: string, key: string) => {
      const raw = args?.[key];
      if (raw == null || raw === "") return "";
      return NAMED_ARGS.has(key) ? names.of(raw) : String(raw);
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * One line of plain English, or `null` for something not worth a line.
 *
 * Returning `null` rather than a muted row matters: the panel's job is to be
 * shorter than the transcript, and a noise event rendered faintly is still a
 * row of pixels a viewer's eye has to reject.
 */
function describeCall(entry: FeedCall, names: Lexicon): string | null {
  const tool = String(entry.tool ?? "");
  if (SILENT_TOOLS.has(tool)) return null;

  const args = entry.args ?? {};
  if (tool === "room") {
    const action = String(args.action ?? "").toLowerCase();
    if (SILENT_ROOM_ACTIONS.has(action)) return null;
    return `uses the room (${action || "?"})`;
  }

  // `Object.hasOwn`, not a bare lookup. A tool named after something on
  // `Object.prototype` — `constructor`, `toString` — would otherwise find the
  // inherited member instead of missing the table, and `fill` would call
  // `.replace` on a function and throw. The panel's try/catch would swallow it,
  // so it would show as the log silently stalling for a frame. Tool names come
  // from the bestiary rather than from an agent, so this is a latent trap rather
  // than a live one; it was found by typing the table, not by hitting it.
  const template = Object.hasOwn(PHRASES, tool) ? PHRASES[tool] : undefined;
  if (template) return fill(template, args, names) || tool.replace(/_/g, " ");

  // An ability added to the bestiary since this table was written. The tool
  // name with its underscores taken out is a worse sentence than a handwritten
  // one and a much better one than nothing.
  const tail = Object.entries(args)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k} ${NAMED_ARGS.has(k) ? names.of(v) : v}`)
    .join(", ");
  return `${tool.replace(/_/g, " ")}${tail ? ` — ${tail}` : ""}`;
}

/** Why the machinery said no, short enough to sit at the end of a line. */
function refusalReason(result: string | null | undefined): string {
  const text = String(result ?? "").replace(/^refused:\s*/i, "");
  const sentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return toWord(sentence.replace(/\.$/, ""), 78);
}

// ---------------------------------------------------------------------------
// Panel: the party channel
// ---------------------------------------------------------------------------

/**
 * What an external source pushes in. See `attachExternalChat` at the bottom.
 *
 * `agent` is accepted alongside `from` so a source written against the store's
 * own vocabulary works without a translation layer; `body` is the only thing
 * required, because a message with nothing in it is dropped rather than drawn.
 */
export interface ExternalMessage {
  from?: string;
  agent?: string;
  body: string;
  source?: string;
  at?: number;
}

/** The same message once `attachExternalChat` has settled every field. */
interface ExternalChatRow extends ExternalMessage {
  from: string;
  body: string;
  source: string;
  at: number;
}

/** The activity renderer, plus the seam an external source pushes into. */
interface ActivityRenderer {
  (state: PanelState): void;
  external: (msg: ExternalChatRow) => void;
}

// ---------------------------------------------------------------------------
// Panel: what happened
// ---------------------------------------------------------------------------

/**
 * A simplified account: round rules, the simulation's combat prose, and one
 * sentence per decision.
 *
 * Consecutive identical lines collapse into a `×n` badge instead of stacking.
 * A guardian whose taunt is on cooldown will call it every round it is up and
 * some rounds it is not, and three identical refusals in a row are one fact
 * about the party's grasp of its own cooldowns — printed three times they read
 * as three separate mistakes.
 */
function logPanel(host: HTMLElement): ActivityRenderer {
  ensureStyles();
  host.classList.add("bcf", "bcf-scroll");
  host.style.overflowY = "auto";
  host.style.display = "block";

  /** The line a repeat would collapse into, and how many it has swallowed. */
  interface Collapsible {
    key: string;
    node: HTMLElement;
    count: number;
  }

  const take = tailer<FeedItem>();
  const names = lexicon();
  let last: Collapsible | null = null; // The collapse candidate.
  let primed = false;
  /** The scene this panel last diffed against. */
  let seen: Scene | null = null;
  /** Which derived events have already been said. See the note in `render`. */
  const announced = new Set<string>();

  /** Append, or bump the badge on the previous line if this repeats it. */
  function push(node: HTMLElement, key: string | null): void {
    if (key && last && last.key === key) {
      last.count += 1;
      let badge: Element | null = last.node.querySelector(".times");
      if (!badge) {
        badge = el("span", "times");
        last.node.append(badge);
      }
      badge.textContent = `×${last.count}`;
      return;
    }
    host.append(node);
    last = key ? { key, node, count: 1 } : null;
  }

  /**
   * Colour the words a viewer scans for: who acted, and how much it cost.
   *
   * Tokenised rather than pattern-matched on the whole sentence. The prose is
   * written by the simulation and reworded whenever a verb reads badly; a
   * renderer that matched `"(\w+) hits (\w+) for (\d+)"` would silently stop
   * highlighting the day somebody wrote "lands a blow on". Splitting on word
   * boundaries instead only ever fails to find a name, never mangles the line.
   *
   * Numbers are lit in the combat prose and left alone in the action lines:
   * damage is the thing a viewer tracks round to round, and a gold price is not.
   */
  function tint(parent: HTMLElement, text: string, numbers: boolean): void {
    for (const token of String(text).split(/([A-Za-z_]+|\d+)/)) {
      if (!token) continue;
      const colour = classColour(token.toLowerCase());
      if (colour) {
        const span = el("span", "name", names.of(token.toLowerCase()));
        span.style.color = colour;
        parent.append(span);
      } else if (numbers && /^\d+$/.test(token)) {
        parent.append(el("span", "n", token));
      } else {
        parent.append(document.createTextNode(token));
      }
    }
  }

  function prose(line: string): HTMLDivElement {
    const node = el("div", "bcf-prose");
    tint(node, line, true);
    return node;
  }

  function actor(name: string): HTMLSpanElement {
    const span = el("span", "who", names.of(name) || "?");
    span.style.color = classColour(name) ?? "var(--dim)";
    return span;
  }

  function addRound(entry: FeedRound): void {
    // The round number is printed exactly as the store holds it, so this panel
    // and the header above it never disagree by one about which round it is.
    const rule = el("div", "bcf-rule");
    rule.append(el("span", "n", `Round ${entry.round ?? 0}`));

    // Only the heading — "Floor 32 — combat." — and nothing under it.
    //
    // `announce` is the message the *agents* read at the top of a round: a
    // heading, the `<state>` block, and then a replay of the last round's
    // combat log and everything that was said in it. All three were being
    // printed here, and every one of them is a duplicate on this page. The
    // state block is forty lines of numbers the HUD and the map already show
    // permanently. The combat log is the same beats the feed renders
    // individually, one screen further down, with better typography — so a
    // viewer read every blow twice, once as a wall of text under a round rule
    // and once as the events they belong to. And the said-lines repeat speech
    // the feed already interleaves in the column where the decisions are.
    //
    // The round rule exists to say *where we are and which round it is*. That
    // is the heading, and it is all that survives.
    const head = String(entry.text ?? "")
      .replace(/<state>[\s\S]*?<\/state>/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
    if (head) rule.append(el("span", "where", head.replace(/\.$/, "")));
    push(rule, null);
  }

  /**
   * What somebody said, in full, in the same column as what they did.
   *
   * This was a one-line marker quoting the first ninety-six characters, because
   * speech had a panel of its own. It no longer does. Two streams on one clock
   * meant the argument about who takes the second thing out of a cache was in
   * one box and somebody taking it was in another, and a viewer had to hold the
   * join in their head. Interleaved, a decision and its consequence are
   * adjacent — which is the only reading of a run that explains anything.
   */
  function addSay(entry: FeedSay, external?: { source: string }): void {
    const row = el("div", `bcf-msg${external ? " external" : ""}`);
    row.dataset.stripe = "speech";

    const head = el("div", "bcf-head");
    const who = el("span", "bcf-who", external ? entry.agent : names.of(entry.agent));
    who.style.color = external ? "var(--dim)" : (classColour(entry.agent) ?? "var(--dim)");
    head.append(mark("speak", "mark sm"), who);
    if (external) head.append(el("span", "bcf-tag", external.source || "chat"));
    const at = clock(entry.at);
    if (at) head.append(el("span", "bcf-at", at));
    row.append(head);

    // Identifiers the party types — `@mage`, an item id, a room id — become the
    // names an audience knows. See `speak()` in names.ts.
    row.append(speak(String(entry.text ?? "").trim(), names));
    push(row, null);
  }

  /**
   * A batched turn, unpacked into the things it actually was.
   *
   * `execute_actions` carries a whole turn — what the character said, what it
   * was thinking, and every deed it committed to — and rendering it as one row
   * is the worst of both worlds. As a single phrase ("commits to a plan") the
   * message and the deeds vanish entirely; through the generic argument
   * renderer it reads as `thinking …, message …, actions [object Object]`.
   *
   * It also cannot be left to arrive as individual calls, which is what an
   * earlier note in the vocabulary claimed. The batch dispatches its actions by
   * invoking each tool directly, so the harness records exactly one call event
   * and the deeds exist only inside these arguments. Unpacking here is the only
   * place they can be seen at all.
   */
  function addBatch(entry: FeedCall): void {
    const args = (entry.args ?? {}) as { message?: unknown; thinking?: unknown; actions?: unknown };

    const thinking = typeof args.thinking === "string" ? args.thinking.trim() : "";
    if (thinking) addThought(entry.agent, thinking, entry.at);

    const message = typeof args.message === "string" ? args.message.trim() : "";
    if (message) addSay({ ...entry, text: message } as unknown as FeedSay);

    const actions = Array.isArray(args.actions) ? args.actions : [];
    for (const step of actions) {
      const one = (step ?? {}) as { actionType?: unknown; payload?: unknown };
      const name = String(one.actionType ?? "");
      if (!name) continue;
      // Rendered through exactly the same path a standalone call takes, so a
      // deed reads identically whether it was batched or not — which is the
      // point: a viewer should not be able to tell how the party spent its
      // round trips.
      addCall({
        ...entry,
        tool: name,
        args: (one.payload ?? {}) as Record<string, unknown>,
      } as FeedCall);
    }
  }

  /**
   * What somebody was thinking, which nobody in the run can read.
   *
   * The private half of a batched turn. It is the only place a viewer learns
   * *why* — that the guardian bought the bow to finish a secret motive rather
   * than because the party needed a bow — and that gap between the stated
   * reason and the real one is the most watchable thing the run produces.
   */
  function addThought(who: string | undefined, text: string, at?: number): void {
    // Built like `addSay`, on purpose: a head row carrying the glyph and the
    // name, then the body underneath at full width. Laid out as one flex row
    // instead — which is how this first shipped — the name becomes a narrow
    // column squeezed against a paragraph, and a thought stops scanning like
    // the speech it sits next to. The difference between the two should be the
    // dashes and the italics, never the shape.
    const row = el("div", "bcf-think");
    row.dataset.stripe = "speech";

    const head = el("div", "bcf-head");
    const name = el("span", "bcf-who", names.of(who ?? ""));
    name.style.color = classColour(who ?? "") ?? "var(--dim)";
    head.append(mark("think", "mark sm"), name);
    head.append(el("span", "bcf-tag", "thinking"));
    const stamp = clock(at);
    if (stamp) head.append(el("span", "bcf-at", stamp));
    row.append(head);

    row.append(speak(text, names));
    push(row, `t${who}|${text.slice(0, 40)}`);
  }

  function addCall(entry: FeedCall): void {
    if (String(entry.tool ?? "") === "execute_actions") return addBatch(entry);
    const phrase = describeCall(entry, names);
    if (!phrase) return;
    const tool = String(entry.tool ?? "");
    const stripe = toolStripe(tool);
    const row = el("div", `bcf-act${entry.refused ? " no" : ""}`);
    row.dataset.stripe = stripe;
    row.append(mark(STRIPE_MARK[stripe], "mark sm"));
    if (entry.refused) row.append(el("span", "x", "✗"));
    row.append(actor(entry.agent));
    const verb = el("span", "verb");
    tint(verb, phrase, false);
    row.append(verb);
    if (entry.refused) {
      const why = refusalReason(entry.result);
      if (why) row.append(el("span", "why", `— ${why}`));
    }
    push(row, `${entry.refused ? "x" : "-"}${entry.agent}|${phrase}`);
  }

  /**
   * A row for something the scenes say actually happened.
   *
   * Never collapsed into a `×n` badge, unlike the calls: two identical refusals
   * in a row are one fact about the party's grasp of its cooldowns, but two
   * descents are two floors.
   */
  function addHappening(event: Happening): void {
    const row = el("div", "bcf-ev");
    row.dataset.stripe = HAPPENING_STRIPE[event.kind];
    row.append(mark(HAPPENING_MARK[event.kind], "mark"));
    const body = el("b");
    // A kill line names something that is already gone from the scene, so the
    // ref is all `happenings` could write. The lexicon remembers what it was
    // called while it was alive.
    const text = event.subject ? event.text.replace(event.subject, names.of(event.subject)) : event.text;
    tint(body, text, true);
    row.append(body);
    if (event.detail) {
      const detail = el("span", "det", event.detail);
      detail.title = event.detail;
      row.append(detail);
    }
    push(row, null);
  }

  function render(state: PanelState): void {
    names.learn(state?.scene);
    const { fresh, reset } = take(state?.feed);
    if (reset) {
      host.replaceChildren();
      last = null;
      primed = false;
      seen = null;
      announced.clear();
    }

    // The scenes are the authoritative half of this panel. `state.previous` is
    // the store's own idea of "the scene before", which is only a usable diff at
    // the instant the scene changes — so the panel keeps its own, which is the
    // last scene it actually drew from.
    const scene = state?.scene ?? null;
    const events = scene === seen ? [] : happenings(seen, scene);
    seen = scene;

    if (!fresh.length && !events.length) {
      if (!host.childElementCount && !host.querySelector(".bcf-off")) {
        host.append(el("div", "bcf-off", "Waiting for the first round."));
      }
      return;
    }
    host.querySelector(".bcf-off")?.remove();

    const backlog = !primed;
    const bottom = atBottom(host);
    for (const entry of fresh) {
      switch (entry?.type) {
        case "round":
          addRound(entry);
          break;
        case "say":
          addSay(entry);
          break;
        case "call":
          addCall(entry);
          break;
        case "end":
          push(el("div", "bcf-over", `The run ended — ${entry.text ?? "no reason given"}`), null);
          break;
      }
    }
    // A round of five agents publishes five scenes carrying identical beats, so
    // anything derived from them can be produced up to five times. The keys are
    // built from what changed rather than from a counter, which makes them the
    // same key whichever turn first noticed — and this set is what turns that
    // into one line. Cleared rather than grown without bound; a repeat after a
    // few hundred events is a cosmetic cost, a leak over fifty minutes is not.
    for (const event of events) {
      if (announced.has(event.key)) continue;
      if (announced.size > 900) announced.clear();
      announced.add(event.key);
      addHappening(event);
    }
    trim(host, 320);
    primed = true;
    if (bottom) stick(host, !backlog);
  }

  /**
   * The seam `attachExternalChat` pushes into — a real viewer, not an agent.
   *
   * It lands in the same column as everything else because a stream's chat and
   * a run's chat are the same kind of object to a watcher; the `external` class
   * and the source tag are what keep a stranger from being mistaken for one of
   * the five.
   */
  const external = (msg: ExternalChatRow): void => {
    const bottom = atBottom(host);
    host.querySelector(".bcf-off")?.remove();
    addSay({ type: "say", agent: msg.from, text: msg.body, at: msg.at }, { source: msg.source });
    trim(host, 320);
    if (bottom) stick(host, true);
  };
  // Hung on the renderer itself rather than returned beside it, so the shell can
  // keep treating every panel as one function.
  return Object.assign(render, { external });
}

// ---------------------------------------------------------------------------
// Panel: commentary
// ---------------------------------------------------------------------------

/**
 * The narrator's most recent line or two, or an honest note that there isn't one.
 *
 * Empty is the *normal* state. The narrator is a model watching the trace from
 * its own process, deliberately opt-in so that forgetting to turn it off cannot
 * put tokens on a benchmark run — so the placeholder explains that rather than
 * looking like a panel that failed to load, and says how to start one.
 *
 * Two lines, not a history. A scrolling commentary competes with the log for the
 * same attention and loses; one quotable sentence is what a commentary box is
 * for.
 */
function narrationPanel(host: HTMLElement): PanelRenderer {
  ensureStyles();
  host.style.display = "block";
  let shown: NarrationLine | null = null;

  function idle(): void {
    host.replaceChildren();
    const box = el("div", "bcf-off");
    box.append(document.createTextNode("No commentary running. The narrator watches from its own process, so a run costs the same either way."));
    box.append(document.createElement("br"));
    box.append(el("code", null, "pnpm run eval -- narrate"));
    host.append(box);
  }

  function render(state: PanelState): void {
    const lines: NarrationLine[] = Array.isArray(state?.narration) ? state.narration : [];
    const newest = lines.length ? lines[lines.length - 1] : null;
    if (!newest) {
      if (shown !== null) {
        shown = null;
        idle();
      } else if (!host.childElementCount) {
        idle();
      }
      return;
    }
    if (newest === shown) return;
    shown = newest;

    host.replaceChildren();
    const previous = lines.length > 1 ? lines[lines.length - 2] : null;
    if (previous) host.append(el("div", "bcf-prev", toWord(previous.text, 120)));

    const quote = el("div", "bcf-quote bcf-new");
    if (newest.round != null) quote.append(el("span", "r", `Round ${newest.round}`));
    quote.append(document.createTextNode(String(newest.text ?? "").trim()));
    host.append(quote);
  }
  return render;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/** Set by `mountFeed`, read by `attachExternalChat`. One feed per page. */
let externalSink: ((msg: ExternalChatRow) => void) | null = null;
/** Anything pushed before the page mounted, so a source can attach early. */
const externalWaiting: ExternalChatRow[] = [];

/**
 * Mount the three panels and return the renderer the shell drives.
 *
 * Each panel is built independently and wrapped, so a panel that throws on one
 * frame does not stop the other two updating for the rest of the run — the same
 * reason the shell wraps the modules.
 */
export function mountFeed(hosts: {
  activity: HTMLElement;
  narration: HTMLElement;
}): Renderer {
  const { activity, narration } = hosts;
  const panels: Array<[string, PanelRenderer]> = [];
  // Activity is kept by name as well as in the list: it is the only one with a
  // seam hanging off it, and a panel picked back out of the list is just "some
  // renderer" again.
  let activityRender: ActivityRenderer | null = null;
  if (activity) {
    activityRender = logPanel(activity);
    panels.push(["activity", activityRender]);
  }
  if (narration) panels.push(["narration", narrationPanel(narration)]);

  if (activityRender) {
    const sink = activityRender.external;
    externalSink = sink;
    while (externalWaiting.length) {
      const queued = externalWaiting.shift();
      if (queued) sink(queued);
    }
  }

  return function render(state) {
    for (const [name, panel] of panels) {
      try {
        panel(state ?? {});
      } catch (err) {
        console.error(`feed:${name} failed`, err);
      }
    }
  };
}

/**
 * Where the messages come from: a function handed the `push`, or an object with
 * a `subscribe` that is handed it instead. Either may return a detach function.
 */
export type ExternalChatSource =
  | ((push: (msg: ExternalMessage) => void) => (() => void) | void)
  | { subscribe(push: (msg: ExternalMessage) => void): (() => void) | void };

/**
 * The seam a real chat feed pushes into. Nothing in this repo calls it.
 *
 * The panel's default content is agent traffic, and that is a deliberate
 * position rather than a missing feature: a broadcast that filled its chat with
 * invented viewers would be showing a fabricated crowd beside real telemetry,
 * and a reader with no way to tell which half was which would be right to
 * distrust both. Nothing in this file generates a message.
 *
 * If somebody wires a genuine channel — Twitch IRC, a Discord bridge, anything
 * with real people in it — this is where it arrives:
 *
 * ```js
 * import { attachExternalChat } from "/broadcast/feed.js";
 *
 * const detach = attachExternalChat((push) => {
 *   const socket = new WebSocket("wss://…");       // a real IRC bridge
 *   socket.onmessage = (e) => push({ from: "…", body: "…", source: "twitch" });
 *   return () => socket.close();
 * });
 * ```
 *
 * `source` accepts a function `(push) => unsubscribe` or an object with a
 * `subscribe(push)` method. Pushed messages are marked with the source's name
 * and rendered in neutral ink, so a stranger is never mistaken for a party
 * member. Returns a detach function — one of its own if the source hands none
 * back, so a caller can always call what it is given.
 */
export function attachExternalChat(source: ExternalChatSource): () => void {
  const push = (message: ExternalMessage): void => {
    if (!message || !message.body) return;
    const row = {
      from: String(message.from ?? message.agent ?? "guest"),
      body: String(message.body),
      source: String(message.source ?? "chat"),
      at: message.at ?? Date.now(),
    };
    if (externalSink) externalSink(row);
    else if (externalWaiting.length < 50) externalWaiting.push(row);
  };

  const detach = typeof source === "function" ? source(push) : source?.subscribe?.(push);
  return typeof detach === "function" ? detach : () => {};
}
