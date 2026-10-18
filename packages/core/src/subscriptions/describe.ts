/**
 * One line per event, for an agent to read.
 *
 * Written when the event arrives rather than when it is delivered, so a digest
 * that fires hours later still says what changed at the time, not what the
 * record looks like now.
 */
import { formatLocal } from "../schedules/when.js";
import type { StateChange } from "../state/types.js";
import type { EventWakeContext } from "./types.js";

const MAX_FIELDS = 5;
const MAX_VALUE_CHARS = 40;
const MAX_LINE_CHARS = 240;

export function describeEvent(event: string, payload: unknown): string {
  if (event === "state.changed" && isStateChange(payload)) return describeStateChange(payload);
  return clip(`${event}: ${compact(payload)}`, MAX_LINE_CHARS);
}

function describeStateChange(c: StateChange): string {
  const who =
    c.actor.kind === "agent" ? c.actor.name : c.actor.kind === "user" ? "a person" : `${c.actor.kind} ${c.actor.name}`;
  const via = c.source?.surface ? ` (${c.source.surface})` : "";
  const ref = `${c.type}/${c.id}`;
  if (c.op === "delete") return `${ref} deleted by ${who}${via}`;
  if (c.op === "create") return clip(`${ref} created by ${who}${via}: ${compact(c.after ?? {})}`, MAX_LINE_CHARS);

  const before = c.before ?? {};
  const after = c.after ?? {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (keys.length === 0) return `${ref} saved by ${who}${via}, unchanged`;

  // Fields are added only while they fit, so the count of what was left out
  // always survives: an agent told "+3 more" knows to look, one whose line was
  // simply cut off does not.
  const prefix = `${ref} updated by ${who}${via}: `;
  const reserve = keys.length > 1 ? "; +99 more".length : 0;
  const parts: string[] = [];
  let used = prefix.length;
  for (const k of keys) {
    const part = !(k in after)
      ? `${k} removed`
      : !(k in before)
        ? `${k} set to ${value(after[k])}`
        : `${k}: ${value(before[k])} → ${value(after[k])}`;
    const sep = parts.length ? 2 : 0;
    if (parts.length >= MAX_FIELDS || (parts.length > 0 && used + sep + part.length + reserve > MAX_LINE_CHARS)) break;
    parts.push(parts.length === 0 ? clip(part, MAX_LINE_CHARS - prefix.length - reserve) : part);
    used += sep + part.length;
  }
  const hidden = keys.length - parts.length;
  return `${prefix}${parts.join("; ")}${hidden ? `; +${hidden} more` : ""}`;
}

function isStateChange(p: unknown): p is StateChange {
  if (typeof p !== "object" || p === null) return false;
  const c = p as Record<string, unknown>;
  return (
    typeof c.type === "string" && typeof c.id === "string" && typeof c.op === "string" && typeof c.actor === "object"
  );
}

function value(v: unknown): string {
  return clip(typeof v === "string" ? v : compact(v), MAX_VALUE_CHARS);
}

function compact(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The part of a woken turn's prompt that says why it was woken. Shared by room
 * and session delivery so both read the same way.
 */
export function renderEventLines(ctx: EventWakeContext, timeZone?: string): string[] {
  const n = ctx.events.length;
  return [
    n === 1 ? "What happened:" : `What happened (${n}, oldest first):`,
    ...ctx.events.map((e) => `- ${formatLocal(new Date(e.at), timeZone)}: ${e.summary}`),
    ...(ctx.instructions ? ["", `Your instructions for this subscription: ${ctx.instructions}`] : []),
  ];
}
