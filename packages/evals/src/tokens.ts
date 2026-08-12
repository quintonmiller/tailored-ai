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

export function mintToken(): string {
  let out = "";
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Fresh values for every name the scenario declared. */
export function mintTokens(names: readonly string[]): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const name of names) tokens[name] = mintToken();
  return tokens;
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
