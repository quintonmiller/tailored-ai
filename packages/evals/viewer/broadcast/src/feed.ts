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

import type {
  BroadcastState,
  ClassId,
  FeedCall,
  FeedItem,
  FeedRound,
  FeedSay,
  NarrationLine,
  Renderer,
  Said,
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

/**
 * One sentence per instrument, in the present tense a commentator would use.
 *
 * Placeholders are filled from the call's own arguments; `{target}` and
 * `{item}` go through the name lexicon below, so `attack target=husk-1` reads
 * "attacks Ash Husk" rather than making a viewer learn the simulation's ref
 * scheme. A tool missing from this table still renders — see `describeCall` —
 * because the bestiary and the ability list are still being balanced and a new
 * ability should degrade to a dull line, not to a blank one.
 *
 * Typed open (`string` keys, a possibly-absent value) for that reason: the tool
 * name arrives from the trace, and a table that claimed to hold every one of
 * them would make the fallback below look like dead code.
 */
const PHRASES: Record<string, string | undefined> = {
  // Shared instruments.
  attack: "attacks {target}",
  defend: "raises a guard",
  inspect_enemy: "sizes up {target}",
  use_item: "uses {item} on {target}",
  equip_item: "puts on {item}",
  trade_item: "hands {item} to {to}",
  give_gold: "gives {amount} gold to {to}",
  buy: "buys {item}",
  sell: "sells {item}",
  choose_path: "picks the {path} way",
  descend: "calls for the descent",
  revive: "brings {ally} back",
  rest: "calls a halt to rest",
  choose_name: "chooses the name {name}",
  reveal_goal: "reveals a private motive",

  // Guardian.
  taunt: "roars for their attention",
  shield: "shields {target}",
  shield_slam: "slams {target}",

  // Mage.
  firebolt: "hurls a firebolt at {target}",
  frostbite: "freezes {target}",
  lightning: "calls lightning down on {target}",
  fireball: "throws a fireball into all of them",

  // Rogue.
  backstab: "backstabs {target}",
  interrupt: "interrupts {target}",
  sleep_powder: "puts {target} to sleep",
  vanish: "slips out of sight",
  scout: "scouts the ways ahead",

  // Cleric.
  heal: "heals {target}",
  cleanse: "cleanses {target}",
  bless: "blesses {target}",
  sanctuary: "raises a sanctuary over the party",

  // Ranger.
  shoot: "shoots {target}",
  mark: "marks {target}",
  volley: "looses a volley",
  read_beast: "reads {target}'s habits",
};

/** Which argument names name a *thing* and so want the lexicon. */
const NAMED_ARGS = new Set(["target", "item", "ally"]);

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
.bcf-msg { padding: 7px 2px 8px; border-top: 1px solid transparent; }
.bcf-msg + .bcf-msg { border-top-color: color-mix(in srgb, var(--line) 55%, transparent); }
.bcf-head { display: flex; align-items: baseline; gap: 7px; margin-bottom: 3px; }
.bcf-who { font: 600 13px/1.2 var(--sans); letter-spacing: 0.01em; }
.bcf-tag {
  font: 9px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--faint); border: 1px solid var(--line); border-radius: 3px; padding: 2px 4px;
}
.bcf-at { margin-left: auto; font: 10px/1 var(--mono); color: var(--faint); font-variant-numeric: tabular-nums; }

/*
 * Clamped by height and faded out, rather than cut with an ellipsis. Agents
 * write four-sentence paragraphs and a character-count truncation lands in the
 * middle of a word about half the time; a fade ends the block at a line
 * boundary and reads as "there is more" instead of as a typo.
 */
.bcf-body {
  font: 13.5px/1.5 var(--sans); color: var(--ink);
  overflow-wrap: anywhere; white-space: pre-wrap;
  max-height: calc(1.5em * 4); overflow: hidden;
}
.bcf-body.more {
  -webkit-mask-image: linear-gradient(180deg, #000 62%, transparent 98%);
  mask-image: linear-gradient(180deg, #000 62%, transparent 98%);
}
.bcf-msg.external .bcf-who { color: var(--dim); }
.bcf-msg.external .bcf-body { color: var(--dim); font-size: 12.5px; }

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
  font: 600 10px/1 var(--sans); letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--flame);
}
.bcf-rule .where { font: 11px/1.3 var(--mono); color: var(--dim); }
.bcf-over { margin: 12px 0 4px; padding-top: 8px; border-top: 1px solid var(--flame-dim);
  font: 600 11px/1.4 var(--sans); letter-spacing: 0.08em; color: var(--flame); }

/* The simulation's own combat prose: the most readable thing in the run. */
.bcf-prose { font: 13px/1.45 var(--sans); color: var(--dim); padding: 2px 0 2px 2px; }
/* Whoever is named, wherever they are named. Colour is carried inline so the
   party's five colours stay in one table rather than in two. */
.bcf .name { font-weight: 600; }
.bcf .n { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }

/* A collapsed tool call. Secondary to the prose on purpose. */
.bcf-act {
  display: flex; align-items: baseline; gap: 6px;
  font: 12px/1.4 var(--sans); color: var(--faint); padding: 2px 0 2px 2px;
}
.bcf-act .who { font-weight: 600; }
.bcf-act .verb { color: var(--dim); }
.bcf-act .said { color: var(--dim); font-style: italic; }
.bcf-act .x { color: var(--bad); font: 11px/1 var(--mono); }
.bcf-act.no .verb { color: color-mix(in srgb, var(--bad) 55%, var(--faint)); }
.bcf-act .why { color: color-mix(in srgb, var(--bad) 40%, var(--faint)); font-size: 11px; }
.bcf-act .times {
  font: 10px/1 var(--mono); color: var(--faint);
  border: 1px solid var(--line); border-radius: 999px; padding: 2px 5px; margin-left: 2px;
}

/* ---- narration ---- */

.bcf-quote { font: 15px/1.45 var(--sans); color: var(--ink); }
.bcf-quote .r {
  display: block; font: 10px/1 var(--mono); letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--faint); margin-bottom: 6px;
}
.bcf-prev { font: 12px/1.4 var(--sans); color: var(--faint); margin-bottom: 8px; }
.bcf-off { font: 12px/1.5 var(--sans); color: var(--faint); }
.bcf-off code {
  display: inline-block; margin-top: 6px; padding: 4px 7px;
  font: 11px/1 var(--mono); color: var(--dim);
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
  style.textContent = CSS;
  document.head.append(style);
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
    },
    of(id) {
      const key = String(id ?? "").trim();
      if (!key) return "";
      return names.get(key) ?? titleise(key);
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

/**
 * One row of the chat panel, from either of the two things that produce them.
 *
 * The store's `Said` satisfies this and so does a normalised external message.
 * Everything is optional because the two disagree about which fields exist — an
 * external line has a `source` and no `room`, a party line the reverse — and the
 * renderer below already treats every one of them as possibly absent.
 */
interface ChatMessage {
  agent?: string;
  room?: string;
  source?: string;
  body?: string;
  at?: number;
}

/** The chat renderer, plus the seam an external source pushes into. */
interface ChatRenderer {
  (state: PanelState): void;
  external: (msg: ExternalChatRow) => void;
}

/**
 * What the five of them say to each other, and nothing else.
 *
 * The layout is deliberately closer to a messaging app than to a log: name on
 * its own line in the speaker's colour, body underneath at the largest type on
 * the page. Agents write in paragraphs and the panel is 320px wide, so a log's
 * "name: text" prefix would leave a two-word measure and make every message a
 * ragged staircase.
 */
function chatPanel(host: HTMLElement): ChatRenderer {
  ensureStyles();
  host.classList.add("bcf", "bcf-scroll");
  host.style.overflowY = "auto";
  host.style.display = "block";

  const take = tailer<Said>();
  let primed = false;
  let rooms = new Set<string>();
  let displayNames = new Map<string, string>();

  /** Shared by store-driven messages and by anything `attachExternalChat` sends. */
  function append(msg: ChatMessage, external: boolean): HTMLDivElement {
    const row = el("div", `bcf-msg${external ? " external" : ""}${primed ? " bcf-new" : ""}`);

    const head = el("div", "bcf-head");
    const shown = displayNames.get(msg.agent ?? "") ?? msg.agent ?? "?";
    const who = el("span", "bcf-who", shown);
    who.style.color = external ? "var(--dim)" : (classColour(msg.agent ?? "") ?? "var(--dim)");
    head.append(who);

    // The room only earns space once there is more than one of them; a tag
    // reading "party" on every line of a single-room run is pure decoration.
    if (external) head.append(el("span", "bcf-tag", msg.source || "chat"));
    else if (msg.room && rooms.size > 1) head.append(el("span", "bcf-tag", msg.room));

    const at = clock(msg.at);
    if (at) head.append(el("span", "bcf-at", at));
    row.append(head);

    row.append(el("div", "bcf-body", String(msg.body ?? "").trim()));
    host.append(row);
    return row;
  }

  /**
   * Mark the bodies that overflow their four lines, so only those get a fade.
   *
   * Measured after the whole batch is in the DOM: one forced layout for a poll
   * rather than one per message.
   */
  function markClamped(rows: readonly HTMLElement[]): void {
    for (const row of rows) {
      const body = row.lastElementChild;
      if (body && body.scrollHeight > body.clientHeight + 1) body.classList.add("more");
    }
  }

  function render(state: PanelState): void {
    displayNames = new Map(
      (state.scene?.party ?? []).map((member) => [member.id, member.identity?.displayName ?? member.id]),
    );
    const { fresh, reset } = take(state?.said);
    if (reset) {
      host.replaceChildren();
      primed = false;
      rooms = new Set();
    }
    if (!fresh.length) {
      if (!host.childElementCount && !host.querySelector(".bcf-off")) {
        host.append(el("div", "bcf-off", "Nothing said yet. The party talks between rounds."));
      }
      return;
    }
    host.querySelector(".bcf-off")?.remove();

    for (const msg of fresh) if (msg.room) rooms.add(msg.room);

    // The first batch is a backlog, not news: it arrives all at once when the
    // page is opened part-way through a run, so it neither animates in nor
    // scrolls smoothly past forty messages to reach the bottom.
    const backlog = !primed;
    const bottom = atBottom(host);
    const rows = fresh.map((msg) => append(msg, false));
    markClamped(rows);
    trim(host, 140);
    primed = true;
    if (bottom) stick(host, !backlog);
  }

  /** The seam `attachExternalChat` pushes into. See the export at the bottom. */
  const external = (msg: ExternalChatRow): void => {
    const bottom = atBottom(host);
    host.querySelector(".bcf-off")?.remove();
    markClamped([append({ ...msg, agent: msg.from ?? msg.agent }, true)]);
    trim(host, 140);
    if (bottom) stick(host, true);
  };
  // Hung on the renderer itself rather than returned beside it, so the shell can
  // keep treating every panel as one function.
  return Object.assign(render, { external });
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
function logPanel(host: HTMLElement): PanelRenderer {
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

    // `announce` is a heading line — "Floor 32 — combat." — and then the
    // round's combat log. The heading belongs on the rule; the log is the good
    // part and gets the space under it.
    const lines = String(entry.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
    const [head, ...rest] = lines;
    if (head) rule.append(el("span", "where", head.replace(/\.$/, "")));
    push(rule, null);
    for (const line of rest) push(prose(line), null);
  }

  function addSay(entry: FeedSay): void {
    // Speech lives in the chat panel; here it is a one-line marker that keeps
    // the log's timeline honest about when the party stopped to talk.
    const row = el("div", "bcf-act");
    row.append(actor(entry.agent));
    row.append(el("span", "said", `“${toWord(entry.text, 96)}”`));
    push(row, null);
  }

  function addCall(entry: FeedCall): void {
    const phrase = describeCall(entry, names);
    if (!phrase) return;
    const row = el("div", `bcf-act${entry.refused ? " no" : ""}`);
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

  function render(state: PanelState): void {
    names.learn(state?.scene);
    const { fresh, reset } = take(state?.feed);
    if (reset) {
      host.replaceChildren();
      last = null;
      primed = false;
    }
    if (!fresh.length) {
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
    trim(host, 320);
    primed = true;
    if (bottom) stick(host, !backlog);
  }
  return render;
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
  chat: HTMLElement;
  log: HTMLElement;
  narration: HTMLElement;
}): Renderer {
  const { chat, log, narration } = hosts;
  const panels: Array<[string, PanelRenderer]> = [];
  // The chat panel is kept by name as well as in the list: it is the only one
  // with a seam hanging off it, and a panel picked back out of the list is just
  // "some renderer" again.
  let chatRender: ChatRenderer | null = null;
  if (chat) {
    chatRender = chatPanel(chat);
    panels.push(["chat", chatRender]);
  }
  if (log) panels.push(["log", logPanel(log)]);
  if (narration) panels.push(["narration", narrationPanel(narration)]);

  if (chatRender) {
    const sink = chatRender.external;
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
