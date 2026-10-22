/**
 * Kinds of watcher: cheap checks, with no model call, that something changed.
 *
 * A watcher asks one narrow question on an interval (is there anything new on
 * this page, has this price moved, has mail from this sender arrived),
 * compares the answer with what it saw last time, and reports one line when
 * something changed. A kind is the code for one such question. A watch is one
 * use of it, with its own config: which page, which price, which sender.
 *
 * Core keeps the registry, the contract a kind is written to, and the checks a
 * runner needs before it trusts a watch or a result. It ships no kinds and runs
 * no watches. A runner plugin schedules watches, keeps each one's snapshot,
 * counts failures and decides what a change does, usually waking the agent
 * that owns the watch. Until one is loaded this registry is a catalog: a kind
 * registered here is listed and nothing calls it. See `docs/watchers.md`.
 */
import { type Disposer, Registry } from "../registry.js";
import type { JsonSchema } from "../state/types.js";
import { unsupportedKeywords, validateAgainstSchema } from "../state/validate.js";
import { parseWindow } from "../subscriptions/keys.js";

/**
 * The largest snapshot a check may return, in bytes of JSON. A snapshot is
 * what the next check compares against, so it holds a hash, a few ids or the
 * values being compared, never the page. The runner keeps one per watch and
 * hands it back on every check, which is why it stays small.
 */
export const MAX_WATCH_SNAPSHOT_BYTES = 4096;

/** The longest `change` line. A longer one is cut, with an ellipsis to say so. */
export const MAX_WATCH_CHANGE_CHARS = 300;

/** The longest `value` text. A longer one is cut the same way. */
export const MAX_WATCH_VALUE_CHARS = 120;

/** What a check is handed besides the watch's config and last snapshot. */
export interface WatcherCheckContext {
  /** The runner's clock. Use it rather than `new Date()`, so a check agrees with the runner and with tests. */
  now: Date;
  /** Aborted when the runner gives up on the check. Pass it to anything slow, `fetch` included. */
  signal: AbortSignal;
  /**
   * The runner's `fetch`, when it offers one. Use it rather than the global so
   * the runner's limits (timeouts, which hosts may be reached) hold for this
   * check. A kind that needs the network falls back to the global only when it
   * is absent.
   */
  fetch?: typeof fetch;
}

/** What one check found. */
export interface WatcherResult<S = unknown> {
  /**
   * What the next check is handed as `previous`: JSON, at most
   * {@link MAX_WATCH_SNAPSHOT_BYTES} bytes once serialized. A bigger one is refused
   * and the check counts as failed.
   */
  snapshot: S;
  /** The reading now, to show beside the watch: a price, a count, a title. */
  value?: string | number;
  /**
   * One plain line saying what changed since `previous`, the way a person
   * would read it in a notification: "The price fell from €212 to €182."
   * Absent when nothing changed.
   */
  change?: string;
}

/**
 * The contract a kind of watcher is written to.
 *
 * `C` is the shape of a watch's config (what `schema` describes) and `S` the
 * shape of the snapshot the kind keeps. Both are the kind's own business: core
 * only checks the config against `schema` and the snapshot against its cap.
 */
export interface WatcherKind<C = Record<string, unknown>, S = unknown> {
  /**
   * What a watch names to use this kind: lowercase, starting with a letter,
   * e.g. `page`, `price`, `mail`. Agents and config type it, so keep it plain.
   */
  kind: string;
  /** One line on what it checks, for an agent or a person choosing a kind. */
  description: string;
  /**
   * The JSON schema of a watch's config, in the subset world state checks
   * (types, enums, required and nested fields, bounds, patterns). A watch
   * whose config fails it is refused before it is kept.
   */
  schema: JsonSchema;
  /** How often a watch runs when it names no interval, in the words `tend` and schedules use: "1h", "30 minutes", "1 day". */
  defaultEvery: string;
  /**
   * The shortest interval a watch of this kind may ask for, in the same
   * words. A shorter one is raised to it. It protects the site or account
   * being checked as much as the machine doing the checking.
   */
  minEvery: string;
  /**
   * Check once.
   *
   * - `previous` is the snapshot the last successful check returned, or
   *   undefined when this is the watch's first check.
   * - **The first check sets a baseline.** With no `previous` there is nothing
   *   to compare with, so return a snapshot and no `change`. A watch created
   *   today must not report everything already on the page as new.
   * - Return a `change` only when something changed, and leave it out
   *   otherwise.
   * - **Throw when the check can't be done**: the page is down, the account
   *   refused, the answer wasn't what the kind expected. The runner counts the
   *   failure and keeps the previous snapshot. A throw is never a change.
   * - Honour `ctx.signal`: the runner aborts a check that runs too long.
   */
  check(config: C, previous: S | undefined, ctx: WatcherCheckContext): WatcherResult<S> | Promise<WatcherResult<S>>;
}

/** Something about a kind or a check that breaks the contract above, worded to say how to fix it. */
export class WatcherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatcherError";
  }
}

/**
 * The plugin view of the registry: `ctx.watcherKinds`. `register` is how a
 * plugin brings a kind; `get` and `list` are how a runner plugin finds them,
 * through the context, with no runtime import of core.
 */
export interface WatcherKindRegistryView {
  register(kind: WatcherKind<any, any>): Disposer;
  /** The kind a watch names, or undefined when no loaded plugin brings it. */
  get(kind: string): WatcherKind | undefined;
  /** Every kind registered now, in the order they came. */
  list(): WatcherKind[];
}

export const watcherKindRegistry = new Registry<WatcherKind<any, any>>("watcher-kind");

/** Lowercase, starting with a letter; digits, `_`, `-` and `.` after. */
const KIND_NAME = /^[a-z][a-z0-9_.-]*$/;

/**
 * Add a kind, and hand back its inverse. Throws a {@link WatcherError} for a
 * kind no runner could use (a bad name, a missing `check`, an interval that
 * isn't a length of time, a default under its own floor), so the plugin author
 * hears about it at load rather than when the first watch fails.
 */
export function registerWatcherKind(kind: WatcherKind<any, any>): Disposer {
  const name = typeof kind?.kind === "string" ? kind.kind : "";
  if (!KIND_NAME.test(name)) {
    throw new WatcherError(
      `A watcher kind's name is lowercase and starts with a letter, like "page" or "price", not ${JSON.stringify(kind?.kind)}.`,
    );
  }
  if (typeof kind.description !== "string" || !kind.description.trim()) {
    throw new WatcherError(`Watcher kind "${name}" needs a description: one line on what it checks.`);
  }
  if (typeof kind.schema !== "object" || kind.schema === null || Array.isArray(kind.schema)) {
    throw new WatcherError(`Watcher kind "${name}" needs a schema: the JSON schema of a watch's config.`);
  }
  if (typeof kind.check !== "function") {
    throw new WatcherError(`Watcher kind "${name}" needs a check function.`);
  }
  kindIntervals(kind);
  // Reported rather than refused, as config validation does: a keyword core
  // doesn't check would otherwise look enforced and enforce nothing.
  const unchecked = unsupportedKeywords(kind.schema);
  if (unchecked.length) {
    console.warn(
      `[watcher-kind] "${name}": its schema uses keywords core does not check, so configs pass them unchecked: ${unchecked.join(", ")}.`,
    );
  }
  return watcherKindRegistry.register(name, kind);
}

export function getWatcherKind(kind: string): WatcherKind | undefined {
  return watcherKindRegistry.get(kind);
}

export function listWatcherKinds(): WatcherKind[] {
  return watcherKindRegistry.entriesList().map(([, kind]) => kind);
}

/**
 * Every way `config` fails `kind`'s schema, as sentences a model or a person
 * can act on. Empty when it passes. A watch with no settings passes `{}`.
 */
export function validateWatchConfig(kind: WatcherKind<any, any>, config: unknown): string[] {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return [
      `A ${kind.kind} watch's config is an object of its settings, not ${JSON.stringify(config) ?? String(config)}.`,
    ];
  }
  return validateAgainstSchema(kind.schema, config);
}

/** How often a watch runs, once `kind`'s floor is applied. */
export interface WatchInterval {
  /** Milliseconds between checks. */
  ms: number;
  /**
   * What the watch asked for, in milliseconds, when it was under the kind's
   * `minEvery` and was raised to it. Set so whoever chose it can be told,
   * rather than finding out from how rarely it runs.
   */
  raisedFrom?: number;
}

/**
 * The interval a watch runs on: `every` when given, else the kind's
 * `defaultEvery`, and never under its `minEvery`. Returns a correction, as a
 * string, when `every` isn't a length of time.
 */
export function watchInterval(kind: WatcherKind<any, any>, every?: unknown): WatchInterval | string {
  const { minMs, defaultMs } = kindIntervals(kind);
  if (every === undefined || every === null || every === "") return { ms: defaultMs };
  const ms = typeof every === "string" ? parseWindow(every) : undefined;
  if (!ms) return `every is a length of time like "15m", "2 hours" or "1 day", not ${JSON.stringify(every)}.`;
  return ms < minMs ? { ms: minMs, raisedFrom: ms } : { ms };
}

/** A kind's two intervals in milliseconds, or a {@link WatcherError} naming the one that won't read. */
function kindIntervals(kind: WatcherKind<any, any>): { minMs: number; defaultMs: number } {
  const read = (field: "minEvery" | "defaultEvery") => {
    const raw = kind[field];
    const ms = typeof raw === "string" ? parseWindow(raw) : undefined;
    if (!ms) {
      throw new WatcherError(
        `Watcher kind "${kind.kind}": ${field} is a length of time like "15m", "2 hours" or "1 day", not ${JSON.stringify(raw)}.`,
      );
    }
    return ms;
  };
  const minMs = read("minEvery");
  const defaultMs = read("defaultEvery");
  if (defaultMs < minMs) {
    throw new WatcherError(
      `Watcher kind "${kind.kind}": defaultEvery (${kind.defaultEvery}) is shorter than its own minEvery (${kind.minEvery}).`,
    );
  }
  return { minMs, defaultMs };
}

/**
 * What a check returned, made safe to keep and show.
 *
 * The runner calls this on every result before it stores anything. It throws
 * a {@link WatcherError}, which the runner counts as a failed check, when the
 * result has no snapshot or a snapshot that isn't JSON or is over
 * {@link MAX_WATCH_SNAPSHOT_BYTES}. The snapshot comes back as a plain JSON copy, so
 * what is stored is exactly what the next check will be handed. `change` and
 * `value` come back as one trimmed line, cut with an ellipsis past their caps.
 *
 * Pass the `previous` snapshot the check was given: with none (`undefined`,
 * or a `null` a store handed back for one), this was the first check, and any
 * `change` is dropped. That is the baseline rule in the contract, held here as
 * well so that a kind which forgets it doesn't report everything it found on
 * its first run. A snapshot is never `null`, so the two can't be confused.
 */
export function watcherResult(raw: unknown, previous: unknown): WatcherResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WatcherError("A check returns { snapshot, value?, change? }.");
  }
  const { snapshot, value, change } = raw as Record<string, unknown>;
  if (snapshot === undefined || snapshot === null) {
    throw new WatcherError("A check returns a snapshot: what the next check compares against.");
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(snapshot);
  } catch (err) {
    throw new WatcherError(`The snapshot is not JSON: ${(err as Error).message}`);
  }
  if (json === undefined) throw new WatcherError("The snapshot is not JSON.");
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > MAX_WATCH_SNAPSHOT_BYTES) {
    throw new WatcherError(
      `The snapshot is ${bytes} bytes as JSON, over the ${MAX_WATCH_SNAPSHOT_BYTES}-byte cap. Keep a hash, ids or the values you compare, not the content.`,
    );
  }
  const out: WatcherResult = { snapshot: JSON.parse(json) };

  if (typeof value === "number" && Number.isFinite(value)) out.value = value;
  else if (typeof value === "string") {
    const line = oneLine(value, MAX_WATCH_VALUE_CHARS);
    if (line) out.value = line;
  } else if (value !== undefined && value !== null) {
    const got = typeof value === "number" ? String(value) : typeof value;
    throw new WatcherError(`A check's value is a string or a finite number, not ${got}.`);
  }

  if (typeof change === "string") {
    const line = oneLine(change, MAX_WATCH_CHANGE_CHARS);
    if (line && previous !== undefined && previous !== null) out.change = line;
  } else if (change !== undefined && change !== null) {
    throw new WatcherError(`A check's change is one line of text, not ${typeof change}.`);
  }
  return out;
}

/** Whitespace runs folded to one space, trimmed, and cut at `max` with an ellipsis that says it was. */
function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
