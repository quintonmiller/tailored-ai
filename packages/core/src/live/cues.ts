/**
 * Cues: what a spoken reply does besides speaking.
 *
 * A surface that shows the agent with a body (the web UI's avatar) declares
 * what that body can do when it starts a live session: its gestures, and the
 * moves aimed at something — walking to a place, looking or pointing at a
 * thing — with the targets it knows. Voice mode tells the agent, and the
 * agent writes cues inline, right where they should happen:
 *
 *     <wave/> Hi! Good to see you.        <go to="the couch"/> Heading over.
 *
 * The turn takes them out before anything is spoken or shown and hands each
 * to the transport with the sentence it comes before, so the wave lands on
 * "Hi". A cue is never read aloud: one the body cannot do is dropped.
 *
 * Measured on a 27B local model (40 single turns and a 10-turn conversation
 * per format): self-closing tags beat stage directions in asterisks. Movement
 * asked for was done 9/10 against 8/10, replies left with nothing to say were
 * 4 against 11, invented moves 0 against 1, and neither format came out
 * malformed. So tags are what the agent is taught, and `*waves*` is still
 * understood when a model writes one anyway.
 *
 * Core knows no gesture or place by name: they are the surface's, as strings.
 */

/** What a surface's body can do. Every name is the surface's own. */
export interface Body {
  /** What the person sees, in a few words: "a small robot in a cozy room". */
  looks?: string;
  /** Moves that need no target: "wave", "nod". */
  gestures: string[];
  /** Moves aimed at something: `<go to="the couch"/>`. */
  aimed?: AimedMove[];
}

export interface AimedMove {
  /** The cue's name: "go". */
  verb: string;
  /** The word before the target, and the attribute that carries it: "to". */
  prep: string;
  /** What it does, for the instructions: "walk somewhere". */
  does: string;
  /** What it can be aimed at, as a person would say them: "the couch". */
  targets: string[];
}

/** One cue out of a reply. `target` is a declared target when one matched, otherwise what the agent wrote. */
export interface Cue {
  name: string;
  target?: string;
}

/** Limits on what a surface may declare: the body goes into the prompt. */
const MAX_NAMES = 40;
const MAX_NAME_CHARS = 48;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} '’-]*$/u;

/**
 * A body as a client sent it, checked: names must be short words and phrases,
 * since they go into the agent's instructions. Returns the problem as a
 * sentence when there is one.
 */
export function parseBody(input: unknown): { body: Body } | { error: string } {
  if (typeof input !== "object" || input === null) return { error: "body must be an object." };
  const raw = input as Record<string, unknown>;
  const names = (value: unknown, what: string): string[] | string => {
    if (!Array.isArray(value)) return `${what} must be a list of names.`;
    if (value.length > MAX_NAMES) return `${what} can list at most ${MAX_NAMES}.`;
    const out: string[] = [];
    for (const v of value) {
      if (typeof v !== "string" || !v.trim() || v.length > MAX_NAME_CHARS || !NAME.test(v.trim()))
        return `${what} must be short names of letters, digits, spaces, hyphens and apostrophes.`;
      out.push(v.trim());
    }
    return out;
  };
  const gestures = names(raw.gestures ?? [], "body.gestures");
  if (typeof gestures === "string") return { error: gestures };
  const aimed: AimedMove[] = [];
  if (raw.aimed !== undefined) {
    if (!Array.isArray(raw.aimed) || raw.aimed.length > 8)
      return { error: "body.aimed must be a list of at most 8 moves." };
    for (const move of raw.aimed) {
      const m = (move ?? {}) as Record<string, unknown>;
      const [verb, prep, does] = [m.verb, m.prep, m.does].map((v) => (typeof v === "string" ? v.trim() : ""));
      if (!/^[a-z][a-z-]{0,23}$/.test(verb) || !/^[a-z]{1,12}$/.test(prep))
        return { error: "Each body.aimed move needs a lowercase verb and prep." };
      if (!does || does.length > 60 || !NAME.test(does)) return { error: `body.aimed "${verb}" needs a short does.` };
      const targets = names(m.targets, `body.aimed "${verb}" targets`);
      if (typeof targets === "string") return { error: targets };
      aimed.push({ verb, prep, does, targets });
    }
  }
  let looks: string | undefined;
  if (raw.looks !== undefined) {
    if (typeof raw.looks !== "string" || raw.looks.length > 80 || !NAME.test(raw.looks.trim()))
      return { error: "body.looks must be a few plain words." };
    looks = raw.looks.trim();
  }
  return { body: { ...(looks ? { looks } : {}), gestures, ...(aimed.length ? { aimed } : {}) } };
}

/** The instructions that teach the agent its body. The same text for the whole session, so the prompt stays cached. */
export function bodyInstructions(body: Body): string {
  const moves = body.gestures.map((g) => `<${g}/>`).join(" ");
  const targets = [...new Set((body.aimed ?? []).flatMap((m) => m.targets))];
  return [
    `You have a body the person can see${body.looks ? `: ${body.looks}` : ""}.`,
    "It moves when you write a cue in your reply, placed exactly where the move should happen.",
    "Cues are silent; the words around them are spoken.",
    moves ? `Gestures: ${moves}.` : "",
    ...(body.aimed ?? []).map((m) => `To ${m.does}: <${m.verb} ${m.prep}="${m.targets[0] ?? "something"}"/>.`),
    targets.length ? `Places and things you can use: ${targets.join(", ")}.` : "",
    "Use a cue only when it fits; most replies need none or one.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Text with an article or capitals still names the same target: "Couch" is "the couch". */
function bare(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(the|a|an|your|my)\s+/, "")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

/** The declared target the agent meant: exact, then one name containing the other. */
function matchTarget(written: string, targets: string[]): string | undefined {
  const w = bare(written);
  if (!w) return undefined;
  return targets.find((t) => bare(t) === w) ?? targets.find((t) => bare(t).includes(w) || w.includes(bare(t)));
}

/** "waves", "waved", "waving" all mean "wave". */
function stem(word: string): string[] {
  const w = word.toLowerCase();
  return [w, w.replace(/(ing|ed|es|s)$/, ""), w.replace(/(ing|ed|s)$/, ""), `${w.replace(/(ing|ed)$/, "")}e`];
}

/** The cue a tag or stage direction stands for in this body, or undefined when the body can't do it. */
function interpret(body: Body, name: string, target: string | undefined): Cue | undefined {
  const names = stem(name);
  const gesture = body.gestures.find((g) => names.includes(g.toLowerCase()));
  const aimed = body.aimed ?? [];
  const move = aimed.find((m) => names.includes(m.verb));
  if (move) {
    if (target === undefined) return undefined;
    const matched = matchTarget(target, move.targets);
    return { name: move.verb, target: matched ?? target.trim() };
  }
  if (gesture) return { name: gesture };
  return undefined;
}

/** A stage direction, `*walks to the couch*`, read against the body: its verb, or its preposition and target. */
function readDirection(body: Body, text: string): Cue | undefined {
  const words = text.trim().split(/\s+/);
  const direct = interpret(body, words[0] ?? "", undefined);
  if (direct) return direct;
  // "walks to the couch": the preposition names the move when the verb is not one of the body's.
  for (const move of body.aimed ?? []) {
    const at = words.findIndex((w, i) => i > 0 && w.toLowerCase() === move.prep);
    if (at < 0) continue;
    const target = words.slice(at + 1).join(" ");
    const verbMatches = stem(words[0] ?? "").includes(move.verb);
    const matched = matchTarget(target, move.targets);
    if (verbMatches || matched) return { name: move.verb, target: matched ?? target };
  }
  return undefined;
}

/** Common words ending in "s" that start emphasis, not an action: "*this* matters". */
const NOT_ACTIONS = new Set([
  "this",
  "these",
  "those",
  "always",
  "perhaps",
  "sometimes",
  "yes",
  "is",
  "was",
  "has",
  "his",
  "its",
  "us",
  "does",
  "less",
  "unless",
  "across",
  "plus",
  "thus",
]);

/**
 * `*smiles warmly*` is a stage direction the body can't do: dropped, never
 * read aloud. `*really*` is emphasis: its word is kept. The tell is a verb in
 * the third person ("smiles", "hops") leading a short span.
 */
function looksLikeAction(inner: string): boolean {
  const words = inner.trim().split(/\s+/);
  const first = (words[0] ?? "").toLowerCase();
  return words.length <= 6 && first.length >= 4 && /^[a-z]+s$/.test(first) && !NOT_ACTIONS.has(first);
}

const TAG = /^<\s*(\/?)\s*([a-z][a-z-]*)((?:\s+[a-z]+\s*=\s*"[^"<>]*")*)\s*\/?\s*>/i;
/** Longest a cue can run before it is taken for ordinary text. */
const MAX_CUE_CHARS = 160;
const MAX_DIRECTION_CHARS = 60;

/** A reply in order: words to speak, and cues between them. */
export type CuePiece = { text: string } | { cue: Cue };

/**
 * Takes cues out of a reply as it streams. Holds back a `<` or `*` until it
 * knows whether a cue starts there, so a tag split across two deltas is
 * still caught, and "less than 5" still reaches the voice.
 */
export class CueReader {
  private pending = "";

  constructor(private readonly body: Body) {}

  /** Add streamed text; returns what it can already tell apart, in order. */
  push(delta: string): CuePiece[] {
    this.pending += delta;
    return this.drain(false);
  }

  /** The reply is complete: whatever is held back is text after all. */
  flush(): CuePiece[] {
    return this.drain(true);
  }

  private drain(final: boolean): CuePiece[] {
    const out: CuePiece[] = [];
    let text = "";
    const emitText = () => {
      if (text) out.push({ text });
      text = "";
    };
    let s = this.pending;
    while (s.length) {
      const i = s.search(/[<*]/);
      if (i < 0) {
        text += s;
        s = "";
        break;
      }
      text += s.slice(0, i);
      s = s.slice(i);
      if (s[0] === "<") {
        const m = TAG.exec(s);
        if (m) {
          // Any tag is markup, never speech: a closing one, or one the body
          // can't do, is dropped.
          const attrs = [...m[3].matchAll(/([a-z]+)\s*=\s*"([^"]*)"/gi)];
          const name = m[2];
          const move = (this.body.aimed ?? []).find((a) => a.verb === name.toLowerCase());
          const target = (move && attrs.find((a) => a[1].toLowerCase() === move.prep)?.[2]) ?? attrs[0]?.[2];
          const cue = m[1] ? undefined : interpret(this.body, name, target);
          emitText();
          if (cue) out.push({ cue });
          s = s.slice(m[0].length);
          continue;
        }
        // Could still become a tag: wait for more, unless it never can.
        if (!final && s.length < MAX_CUE_CHARS && !/>/.test(s) && /^<\s*\/?\s*[a-z]?[a-z-]*(\s+[^<]*)?$/i.test(s))
          break;
        text += "<";
        s = s.slice(1);
        continue;
      }
      // An asterisk: a stage direction if it closes soon on the same line.
      const close = s.indexOf("*", 1);
      const line = s.indexOf("\n");
      if (close > 1 && close <= MAX_DIRECTION_CHARS && (line < 0 || close < line)) {
        const inner = s.slice(1, close);
        if (/^\p{L}/u.test(inner)) {
          const cue = readDirection(this.body, inner);
          if (cue || looksLikeAction(inner)) {
            emitText();
            if (cue) out.push({ cue });
          } else {
            // Emphasis, not a stage direction: keep the words, lose the marks.
            text += inner;
          }
          s = s.slice(close + 1);
          continue;
        }
      } else if (!final && close < 0 && s.length <= MAX_DIRECTION_CHARS && line < 0) {
        break;
      }
      text += "*";
      s = s.slice(1);
    }
    emitText();
    this.pending = s;
    return out;
  }
}

/** A finished reply without its cues: what is shown and stored for the person. */
export function withoutCues(body: Body, reply: string): string {
  const reader = new CueReader(body);
  return [...reader.push(reply), ...reader.flush()]
    .map((p) => ("text" in p ? p.text : ""))
    .join("")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
