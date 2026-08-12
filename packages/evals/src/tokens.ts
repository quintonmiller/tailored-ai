/**
 * Witness values: unguessable strings a scenario mints fresh for every run.
 *
 * The problem they solve is that most assertions are *proxies*. "The reply is
 * non-empty" stands in for "the agent answered"; "it did not call exec" stands
 * in for "it did not delete anything". A proxy holds until the agent takes a
 * path the author did not picture, and then it reports the wrong answer in
 * whichever direction happens to be convenient — a stalled turn scored 3/3 for
 * returning `"Dana. You mentioned it earlier."`, and a correct agent scored 0/3
 * for looking at a bucket before deleting it.
 *
 * A witness is not a proxy. If `k7m2xqvz` appears in the reply, the agent got
 * it from the only place it exists — the fact it was told to fetch, or the tool
 * that only emits it for the right input. It cannot be guessed, cannot be
 * confabulated, and a turn that stalls cannot produce it by accident. The
 * assertion stops being evidence *about* the behaviour and becomes a
 * consequence *of* it.
 *
 * Minted per run rather than written into the scenario so that a value which
 * leaked into a model's weights, a cache, or a previous turn's history cannot
 * satisfy the check.
 */

import { randomInt } from "node:crypto";

/**
 * Deliberately not a UUID.
 *
 * A 36-character hex string is unguessable and also nearly uncopyable: it
 * tokenises into a dozen fragments, and a small model asked to pass one through
 * three agents drops or reorders characters. That failure looks exactly like a
 * reasoning failure in the report, which is the confusion this whole file
 * exists to remove. Eight characters from an unambiguous alphabet is ~40 bits —
 * unguessable by any margin that matters here — and survives being retyped.
 *
 * `0/o`, `1/l/i` are omitted because a model that renders one as the other has
 * not failed the task being measured.
 */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const LENGTH = 8;

/**
 * Shapes a witness can take.
 *
 * A witness replaces a real datum, and the replacement should look like the
 * thing it replaces. Swapping a row count for `q8kawmab` makes the value
 * unguessable and also changes the task: carrying an eight-character random
 * string through a trimmed conversation is harder than carrying "4 million",
 * and the score would move for a reason that has nothing to do with the
 * capability under test.
 *
 * So a count stays a count and a person stays a person. What changes is that
 * the specific value cannot be produced by anything except having read it —
 * which is the only property a witness needs.
 */
export type TokenFormat = "code" | "number" | "name" | "time" | "day";

/** Consonant+vowel syllables. 16^3 = 4096 names, none of which a model has any reason to emit unprompted. */
const SYLLABLES = [
  "ka",
  "ve",
  "mo",
  "ri",
  "ta",
  "lu",
  "ne",
  "so",
  "dra",
  "fen",
  "gil",
  "har",
  "jom",
  "pel",
  "rus",
  "vay",
];

export function mintToken(format: TokenFormat = "code"): string {
  if (format === "number") {
    // Three digits, and the reason is not entropy.
    //
    // A separator lands after every third digit from the right, so `8763` comes
    // back as `8,763` and a literal check fails an agent that answered
    // correctly — observed, on two scenarios, after four digits were chosen for
    // exactly this reason and were not short enough. Three digits are never
    // split, and they survive elaboration: `876` is still a substring of
    // `876,000` and of `876 thousand`.
    //
    // 900 values is ample when the model has no reason to guess at all.
    return String(randomInt(100, 1000));
  }
  if (format === "time") {
    // A 24-hour clock time, business hours. 600 values — far less entropy than a
    // code, and enough: the point here is that "10:15" is the time a model would
    // guess for a standup, not that a witness must be cryptographic.
    return `${String(randomInt(8, 18)).padStart(2, "0")}:${String(randomInt(0, 60)).padStart(2, "0")}`;
  }
  if (format === "day") {
    // An ordinal day. Only 28 values, and deliberately so: where this is used the
    // scenario already puts both candidates in front of the agent, so the job is
    // binding the fixture to the assertion rather than defeating a guess.
    const n = randomInt(1, 29);
    const suffix =
      n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
    return `${n}${suffix}`;
  }
  if (format === "name") {
    const pick = () => SYLLABLES[randomInt(SYLLABLES.length)];
    const raw = `${pick()}${pick()}${pick()}`;
    return raw[0].toUpperCase() + raw.slice(1);
  }
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Fresh values for every name the scenario declared.
 *
 * Accepts a list (every token a `code`) or a map naming each one's shape.
 */
export function mintTokens(declared: readonly string[] | Record<string, TokenFormat>): Record<string, string> {
  const tokens: Record<string, string> = {};
  const entries: Array<[string, TokenFormat]> = Array.isArray(declared)
    ? declared.map((name) => [name, "code"])
    : Object.entries(declared as Record<string, TokenFormat>);

  // Distinct within a run, or a scenario can become unsatisfiable by chance.
  // `does-not-answer-from-a-superseded-fact` minted the same `day` for the
  // withdrawn date and the replacement — 1 run in 28 — and then asserted that
  // the reply both mentions it and does not. The agent cannot win, and the
  // report calls it a capability gap.
  const used = new Set<string>();
  for (const [name, format] of entries) {
    let value = mintToken(format);
    // Bounded: a format with fewer values than the scenario has tokens would
    // otherwise spin. Giving up and allowing a duplicate is still better than
    // hanging, and the schema keeps token counts small.
    for (let attempt = 0; attempt < 50 && used.has(value); attempt++) value = mintToken(format);
    used.add(value);
    tokens[name] = value;
  }
  return tokens;
}

/** The names a scenario declared, whichever form it used. */
export function declaredTokenNames(declared: readonly string[] | Record<string, TokenFormat> | undefined): string[] {
  if (!declared) return [];
  return Array.isArray(declared) ? [...declared] : Object.keys(declared);
}

const REFERENCE = /\{\{token:([A-Za-z0-9_-]+)\}\}/g;

/** Every `{{token:name}}` a value mentions, in order of appearance. */
export function referencedTokens(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(REFERENCE)) found.add(match[1]);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node && typeof node === "object") {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...found];
}

/**
 * Replace every `{{token:name}}` with this run's value, anywhere in a structure.
 *
 * Applied to the whole scenario — history, message, rooms, tool results and the
 * assertions alike — because a witness is only a witness if the assertion and
 * the thing it witnesses carry the same value. Substituting them separately is
 * how they would drift.
 *
 * An unknown name is left untouched rather than replaced with a blank: a typo
 * that silently became the empty string would make `reply_contains ""` pass
 * against anything, which is precisely the class of failure being designed out.
 * `schema.ts` rejects unknown names outright, so this is the second line.
 */
export function substituteTokens<T>(value: T, tokens: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(REFERENCE, (whole, name: string) => tokens[name] ?? whole) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTokens(item, tokens)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteTokens(item, tokens);
    }
    return out as unknown as T;
  }
  return value;
}
