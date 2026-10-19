/**
 * What an agent did last, and when it wakes next, in the few words a tag
 * over its head or its card has room for: "searched the web, 40 min ago",
 * "next: 07:00". The words come from the agent's `activity` record, which
 * keeps the status line it showed ("searching the web"); this says it as
 * done. Pure, so it is tested without a page.
 */
import type { AgentActivity } from "../avatar/doing";
import { ago } from "./tasks";

/** "-ing" words that don't end in "-ed" once done. */
const IRREGULAR: Record<string, string> = {
  being: "was",
  bringing: "brought",
  building: "built",
  buying: "bought",
  choosing: "chose",
  doing: "did",
  drawing: "drew",
  finding: "found",
  getting: "got",
  giving: "gave",
  going: "went",
  having: "had",
  hearing: "heard",
  keeping: "kept",
  leaving: "left",
  making: "made",
  meeting: "met",
  paying: "paid",
  putting: "put",
  reading: "read",
  running: "ran",
  saying: "said",
  seeing: "saw",
  sending: "sent",
  setting: "set",
  sitting: "sat",
  sleeping: "slept",
  speaking: "spoke",
  standing: "stood",
  taking: "took",
  telling: "told",
  thinking: "thought",
  writing: "wrote",
};

/**
 * A status line said as done: "searching the web" is "searched the web",
 * "taking a photo" is "took a photo", "replying" is "replied". Only the first
 * word changes, and one that isn't an "-ing" word is left as it is.
 */
export function pastTense(what: string): string {
  const [first, ...rest] = what.trim().split(/\s+/);
  if (!first) return what.trim();
  const word = first.toLowerCase();
  let done = IRREGULAR[word];
  if (!done) {
    const stem = word.endsWith("ing") ? word.slice(0, -3) : "";
    // "string", "thing" and "bring" have no vowel left without their "-ing": not a doing word.
    if (stem.length < 2 || !/[aeiouy]/.test(stem)) return what.trim();
    done = /[^aeiou]y$/.test(stem) ? `${stem.slice(0, -1)}ied` : `${stem}ed`;
  }
  return [done, ...rest].join(" ");
}

/** What it did last and how long ago: "searched the web, 40 min ago". */
export function lastDid(last: AgentActivity["last"], now = Date.now()): string | undefined {
  if (!last?.what) return undefined;
  const when = ago(last.at, now);
  return `${pastTense(last.what)}${when ? `, ${when}` : ""}`;
}

/** A time of day, the way the person's clock shows it. */
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** When it next wakes: "any minute now", a time today ("07:00"), or a day and a time further off ("Tue 07:00"). */
export function wakeWords(next: string | undefined, now = Date.now(), clock = clockTime): string | undefined {
  const at = next ? Date.parse(next) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  if (at - now < 60_000) return "any minute now";
  if (at - now < 20 * 3_600_000) return clock(at);
  return `${new Date(at).toLocaleDateString([], { weekday: "short" })} ${clock(at)}`;
}

/** Why it is asleep, and until when if that is known: "paused until 09:30". */
export function asleepWords(a: AgentActivity, clock = clockTime): string {
  const until = a.until ? Date.parse(a.until) : Number.NaN;
  const why = a.detail ?? "asleep";
  return Number.isFinite(until) ? `${why} until ${clock(until)}` : why;
}

/** The lines an idle or sleeping agent's tag shows when you come close: what it did last, and when it wakes. */
export function aboutLines(a: AgentActivity | undefined, now = Date.now(), clock = clockTime): string[] {
  if (!a || (a.doing !== "idle" && a.doing !== "asleep")) return [];
  const last = lastDid(a.last, now);
  const next = wakeWords(a.next, now, clock);
  return [...(last ? [`last: ${last}`] : []), ...(next ? [`next: ${next}`] : [])];
}
