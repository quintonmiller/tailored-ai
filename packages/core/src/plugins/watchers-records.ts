/**
 * The `watch` record: one use of a watcher kind, owned by an agent. See
 * `docs/watchers.md`.
 *
 * A watch lives in its owner's private scope, `agent:<owner>`, so no other
 * agent sees it. Agents can't write the type through `state` (`access.write`
 * is people only): an owner changes its watches with the `watch` tool, and
 * the runner records each check, both writing as the plugin with the owner
 * named in `onBehalfOf`. A person edits any of them on the State page, and
 * the runner reads what they left on its next look.
 */
import { createHash } from "node:crypto";
import type { StateCaller } from "../state/service.js";
import type { JsonSchema, StateRecord, StateTypeDef } from "../state/types.js";

export const WATCH_TYPE = "watch";

export const STATUSES = ["active", "paused", "broken"] as const;
export type WatchStatus = (typeof STATUSES)[number];

/** Failures in a row that stop a watch. */
export const MAX_FAILURES = 3;

/** Watches one agent may keep, archived ones aside. Each costs a fetch on every interval. */
export const MAX_WATCHES = 25;

/** The longest label, note and error a watch keeps. */
export const LABEL_CHARS = 120;
export const NOTE_CHARS = 300;
export const ERROR_CHARS = 300;

/** An ISO time, as the runner writes it: what makes `checkAt <= now` a string comparison that holds. */
const ISO_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}";

export const WATCH_SCHEMA: JsonSchema = {
  type: "object",
  required: ["owner", "kind", "config", "status"],
  properties: {
    owner: { type: "string", minLength: 1, description: "The agent the watch wakes." },
    kind: { type: "string", minLength: 1, description: "Which kind of check: page, price, or one a plugin brings." },
    config: { type: "object", description: "The kind's settings, such as the page's address." },
    label: { type: "string", maxLength: LABEL_CHARS, description: "What it watches, in a few words." },
    every: { type: "string", maxLength: 40, description: 'How often it is checked, like "1h" or "1 day".' },
    note: {
      type: "string",
      maxLength: NOTE_CHARS,
      description: "What the owner wants done when it changes. Shown to the owner with the change.",
    },
    status: {
      type: "string",
      enum: [...STATUSES],
      description: `active, paused, or broken after ${MAX_FAILURES} failed checks in a row.`,
    },
    checkAt: {
      type: "string",
      pattern: ISO_TIME,
      description: "When it is next checked, as an ISO time. Set it to now to check it on the next look.",
    },
    checkedAt: { type: "string", description: "When it was last checked." },
    lastValue: { type: ["string", "number"], description: "What the last check read: a price, a title." },
    lastChange: {
      type: "object",
      required: ["at", "text"],
      properties: { at: { type: "string" }, text: { type: "string" } },
      description: "The last change it saw, and when.",
    },
    failures: { type: "integer", minimum: 0, description: "Checks in a row that failed." },
    lastError: { type: "string", maxLength: ERROR_CHARS, description: "Why the last check failed." },
    tellAt: {
      type: "string",
      pattern: ISO_TIME,
      description: "When to try again to tell the owner about the last change, while the wake is owed.",
    },
    snapshot: {
      type: "object",
      description: "What the next check compares against, and the settings it was taken with. Kept by the runner.",
    },
    commitment: { type: "string", description: "The commitment this watch serves, by id." },
  },
};

/** People edit every field on the State page; agents change their own watches only through the `watch` tool. */
export const WATCH_TYPE_DEF: StateTypeDef = {
  name: WATCH_TYPE,
  description:
    "Something an agent keeps an eye on without a model call, such as a page or a price, checked on an interval; the agent is woken when it changes. Private to its owner, who changes it with the watch tool.",
  scope: "agent",
  title: "label",
  schema: WATCH_SCHEMA,
  access: { write: ["user"] },
};

/** The plugin's own reads: every scope, without a person's access rules. */
export const READER: StateCaller = { actor: { kind: "plugin", name: "watchers" }, source: { surface: "watchers" } };

/**
 * A write made for an agent: the plugin is the actor, since agents can't write
 * watches themselves, and the source names the owner, so a subscription
 * doesn't wake an agent for its own watch's bookkeeping. `tool` is set for
 * writes the `watch` tool makes; the runner's say `watchers` as their surface.
 */
export function writerFor(owner: string, tool?: string): StateCaller {
  return {
    actor: { kind: "plugin", name: "watchers" },
    source: tool ? { tool, onBehalfOf: owner } : { surface: "watchers", onBehalfOf: owner },
  };
}

/** A watch's owner, when the record names one. */
export function ownerOf(record: StateRecord): string | undefined {
  const owner = record.data.owner;
  return typeof owner === "string" && owner ? owner : undefined;
}

/** A watch's status, read safely: anything unknown reads as paused, so nothing runs that wasn't meant to. */
export function statusOf(record: StateRecord): WatchStatus {
  const status = record.data.status;
  return (STATUSES as readonly string[]).includes(status as string) ? (status as WatchStatus) : "paused";
}

/** A watch's config, or an empty one when a person's edit left something else there. */
export function configOf(record: StateRecord): Record<string, unknown> {
  const config = record.data.config;
  return typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

/**
 * What a snapshot was taken against: the kind and its settings, hashed. A
 * person who changes the address on the State page changes this, and the
 * runner then takes a new baseline instead of reporting the new page as a
 * change to the old one.
 */
export function basisOf(kind: string, config: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${kind}\u0000${stableJson(config)}`)
    .digest("hex")
    .slice(0, 16);
}

/** JSON with object keys sorted, so the same settings always hash the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The snapshot a kind is handed as `previous`: the one kept, when it was
 * taken against the watch's settings as they are now. Undefined otherwise,
 * which makes the check a baseline, as the contract promises a first check.
 */
export function previousOf(record: StateRecord, basis: string): unknown {
  const kept = record.data.snapshot as { basis?: unknown; data?: unknown } | undefined;
  if (!kept || typeof kept !== "object" || kept.basis !== basis) return undefined;
  return kept.data === null ? undefined : kept.data;
}

/** One line of text, cut at `max` with an ellipsis that says it was. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Where a watch looks, for a list line: its `url` setting's host and path, when it has one. */
export function whereOf(config: Record<string, unknown>): string | undefined {
  if (typeof config.url !== "string") return undefined;
  try {
    const url = new URL(config.url);
    return clip(`${url.host}${url.pathname === "/" ? "" : url.pathname}`, 60);
  } catch {
    return clip(config.url, 60);
  }
}
