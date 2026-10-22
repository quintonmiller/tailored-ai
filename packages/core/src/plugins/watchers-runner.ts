/**
 * The runner: checks every active watch when its `checkAt` comes due, keeps
 * what it found on the record, and wakes the owner when something changed.
 * See `docs/watchers.md`.
 *
 * The schedule is the records themselves. Each look asks world state for
 * active watches with `checkAt <= now`, so a restart or a reload picks up
 * exactly where the last process left off, and a person who sets `checkAt` to
 * now on the State page gets a check on the next look.
 *
 * Its limits:
 *
 * - **Two checks at a time**, counted across every runner a reload has built,
 *   and never the same watch twice at once.
 * - **One record write per check**, carrying everything the check produced.
 * - **A change wakes the owner** through `runtime.wakeAgent`, so the wake
 *   stops for the pause switch and counts toward the owner's hourly ceiling
 *   like every turn nobody asked for. A wake turned away is owed (`tellAt`)
 *   and tried again every few minutes for a day.
 * - **The first check sets a baseline** and wakes nobody, as does the first
 *   check after a person changes a watch's settings.
 * - **Three failures in a row** mark a watch `broken`, and its owner is told
 *   once.
 */
import type { Wake, WakeAgentOptions, WakeOutcome } from "../agent/wake.js";
import type { StateService } from "../state/service.js";
import type { StateRecord } from "../state/types.js";
import type { WatcherKind, WatcherKindRegistryView, WatcherResult } from "../watchers/registry.js";
import {
  basisOf,
  clip,
  configOf,
  ERROR_CHARS,
  MAX_FAILURES,
  ownerOf,
  previousOf,
  READER,
  statusOf,
  WATCH_TYPE,
  whereOf,
  writerFor,
} from "./watchers-records.js";

/** Checks running at once, across every load of the plugin. */
export const MAX_RUNNING = 2;
/** How often the runner looks for due watches when nothing else prompts it. */
export const TICK_MS = 30_000;
/** How long one check may take before it is given up as failed. */
export const CHECK_TIMEOUT_MS = 45_000;
/** How long after a wake is turned away it is tried again. */
export const TELL_RETRY_MS = 5 * 60_000;
/** How long a wake stays owed before the runner stops trying. The change stays on the record either way. */
export const OWED_FOR_MS = 24 * 3_600_000;
/** How long until a watch whose kind no plugin brings is looked at again. */
const NO_KIND_RETRY_MS = 3_600_000;
/** Due watches read per look. */
const DUE_READ = 20;

/**
 * Watches being checked now, by id, and owners being told about one. Kept at
 * module level so a reload, which disposes this runner and builds another,
 * can't start a check or a wake the old one is still in the middle of.
 */
const running = new Map<string, Promise<void>>();
const telling = new Map<string, Promise<void>>();

/** What the runner needs of the registry: the kind a watch names, its interval, and a check's result made safe. */
export type KindsView = Pick<WatcherKindRegistryView, "get" | "interval" | "result">;

export interface WatchRunnerOptions {
  service: () => StateService;
  kinds: KindsView;
  /** `runtime.wakeAgent`. */
  wake: (agent: string, opts: WakeAgentOptions) => Promise<WakeOutcome>;
  /** The `fetch` a check is handed (`watchFetch`). */
  fetch: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  tickMs?: number;
  checkTimeoutMs?: number;
}

/** What a first look at a watch found: its result, or why it couldn't be read. */
export type FirstLook = { ok: true; result: WatcherResult; at: string } | { ok: false; error: string };

export class WatchRunner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private looking: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  /** Kind names already warned about for having no plugin to bring them. */
  private readonly warnedKinds = new Set<string>();

  constructor(private readonly opts: WatchRunnerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line) => console.log(`[watchers] ${line}`));
    this.warn = opts.warn ?? ((line) => console.warn(`[watchers] ${line}`));
  }

  start(): void {
    this.stop();
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
  }

  /** No more looks from this runner. Checks and wakes already going finish, and the next runner won't repeat them. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves once every check and wake going now has finished: what a test waits for. */
  async idle(): Promise<void> {
    while (this.looking || running.size || telling.size) {
      await Promise.allSettled([this.looking, ...running.values(), ...telling.values()]);
    }
  }

  /**
   * One look: start checks for due watches while there's room, and try again
   * to tell owners whose wake is owed. Only one look at a time per runner; a
   * look asked for while one is going is folded into it.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (!this.looking) {
      this.looking = this.look()
        .catch((err: unknown) => this.warn(`couldn't look for due watches: ${(err as Error).message}`))
        .finally(() => {
          this.looking = undefined;
        });
    }
    return this.looking;
  }

  private async look(): Promise<void> {
    const iso = new Date(this.now()).toISOString();
    const service = this.opts.service();
    if (running.size < MAX_RUNNING) {
      const due = await service.query(READER, {
        type: WATCH_TYPE,
        where: { status: "active", checkAt: { lte: iso } },
        orderBy: { field: "checkAt", direction: "asc" },
        limit: DUE_READ,
      });
      // One a person made on the State page may have no checkAt at all: due now.
      const unscheduled = await service.query(READER, {
        type: WATCH_TYPE,
        where: { status: "active", checkAt: null },
        limit: DUE_READ,
      });
      for (const record of [...unscheduled, ...due]) {
        if (this.stopped || running.size >= MAX_RUNNING) break;
        if (running.has(record.id)) continue;
        const job = this.check(record)
          .catch((err: unknown) => this.warn(`watch ${record.id} wasn't recorded: ${(err as Error).message}`))
          .finally(() => {
            running.delete(record.id);
            // A slot just came free: look again rather than leave it empty until the next tick.
            if (!this.stopped) void this.tick();
          });
        running.set(record.id, job);
      }
    }
    const owed = await service.query(READER, { type: WATCH_TYPE, where: { tellAt: { lte: iso } }, limit: DUE_READ });
    for (const record of owed) {
      if (this.stopped) break;
      this.tellChange(record);
    }
  }

  /**
   * Check a watch that has no record yet, for the `watch` tool's `add`: the
   * baseline it will start from, or why it can't be read, so the agent hears
   * at once rather than when the watch breaks hours later.
   */
  async firstLook(kind: WatcherKind, config: Record<string, unknown>): Promise<FirstLook> {
    const at = new Date(this.now()).toISOString();
    try {
      return { ok: true, result: await this.run(kind, config, undefined), at };
    } catch (err) {
      return { ok: false, error: failureText(err, this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS) };
    }
  }

  /** Run one kind's check under the runner's timeout, and make its result safe to keep. */
  private async run(kind: WatcherKind, config: Record<string, unknown>, previous: unknown): Promise<WatcherResult> {
    const timeoutMs = this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Raced as well as handed over, so a kind that ignores its signal still can't hold a slot past the timeout.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`the check took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s`);
        err.name = "TimeoutError";
        controller.abort(err);
        reject(err);
      }, timeoutMs);
    });
    try {
      const raw = await Promise.race([
        Promise.resolve().then(() =>
          kind.check(config, previous, {
            now: new Date(this.now()),
            signal: controller.signal,
            fetch: this.opts.fetch,
          }),
        ),
        timedOut,
      ]);
      return this.opts.kinds.result(raw, previous);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check one due watch and write down what it found. */
  private async check(record: StateRecord): Promise<void> {
    const started = this.now();
    const at = new Date(started).toISOString();
    const owner = ownerOf(record);
    const writer = writerFor(owner ?? "");
    const service = this.opts.service();
    const ref = { type: WATCH_TYPE, id: record.id };
    const name = String(record.data.kind ?? "");

    const kind = this.opts.kinds.get(name);
    if (!kind) {
      if (!this.warnedKinds.has(name)) {
        this.warnedKinds.add(name);
        this.warn(`no loaded plugin brings the "${name}" kind, so watches of it wait`);
      }
      await service.patch(writer, ref, {
        checkAt: new Date(started + NO_KIND_RETRY_MS).toISOString(),
        lastError: `No loaded plugin brings the "${name}" kind, so it can't be checked.`,
      });
      return;
    }

    const config = configOf(record);
    const basis = basisOf(kind.kind, config);
    const previous = previousOf(record, basis);
    const interval = this.opts.kinds.interval(kind, record.data.every);
    const fallback = this.opts.kinds.interval(kind);
    const everyMs =
      typeof interval === "string" ? (typeof fallback === "string" ? NO_KIND_RETRY_MS : fallback.ms) : interval.ms;
    const checkAt = new Date(started + everyMs).toISOString();

    let result: WatcherResult | undefined;
    let error: string | undefined;
    try {
      result = await this.run(kind, config, previous);
    } catch (err) {
      error = failureText(err, this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
    }

    // What a person or the owner did while it ran wins: paused, removed, or its settings changed.
    const now = await service.get(READER, ref);
    if (!now || now.archivedAt || statusOf(now) !== "active") return;
    if (now.data.kind !== record.data.kind || basisOf(kind.kind, configOf(now)) !== basis) return;

    if (error !== undefined) {
      const failures = (typeof now.data.failures === "number" ? now.data.failures : 0) + 1;
      const broken = failures >= MAX_FAILURES;
      const saved = await service.patch(writer, ref, {
        checkAt,
        failures,
        lastError: clip(error, ERROR_CHARS),
        ...(broken ? { status: "broken" } : {}),
      });
      this.log(`watch ${record.id} failed (${failures} in a row): ${error}`);
      if (broken) this.tellBroken(saved);
      return;
    }

    const found = result as WatcherResult;
    // A change found while the owner is still in a turn about the last one is owed now, and told when that turn ends.
    const busy = found.change !== undefined && telling.has(record.id);
    const saved = await service.patch(writer, ref, {
      checkAt,
      checkedAt: at,
      snapshot: { basis, data: found.snapshot },
      lastValue: found.value ?? null,
      failures: 0,
      lastError: null,
      ...(found.change ? { lastChange: { at, text: found.change }, tellAt: busy ? at : null } : {}),
    });
    if (found.change) {
      this.log(`watch ${record.id} changed: ${found.change}`);
      this.tellChange(saved);
    }
  }

  /** Wake the owner about the watch's last change, once at a time per watch. */
  private tellChange(record: StateRecord): void {
    if (telling.has(record.id)) return;
    const job = this.tell(record).finally(() => telling.delete(record.id));
    telling.set(record.id, job);
  }

  private async tell(record: StateRecord): Promise<void> {
    const owner = ownerOf(record);
    const change = record.data.lastChange as { at?: unknown; text?: unknown } | undefined;
    if (!owner || typeof change?.text !== "string") return this.settle(record, { tellAt: null });
    const outcome = await this.wakeOwner(owner, record, changePrompt(record, this.now()));
    if (outcome === "paused" || outcome === "at-ceiling") {
      const since = typeof change.at === "string" ? Date.parse(change.at) : Number.NaN;
      if (Number.isFinite(since) && this.now() - since > OWED_FOR_MS) {
        this.log(
          `gave up telling ${owner} about watch ${record.id}: it has been a day; the change stays on the record`,
        );
        return this.settle(record, { tellAt: null });
      }
      this.log(`${owner} wasn't woken for watch ${record.id} (${outcome}); trying again in a few minutes`);
      return this.settle(record, { tellAt: new Date(this.now() + TELL_RETRY_MS).toISOString() });
    }
    if (outcome === "gone") return this.ownerGone(owner, record);
    // Told. A newer change found while the turn ran is still owed, so its tellAt stays.
    const current = await this.opts
      .service()
      .get(READER, { type: WATCH_TYPE, id: record.id })
      .catch(() => null);
    const latest = current?.data.lastChange as { at?: unknown } | undefined;
    if (current && current.data.tellAt !== undefined && latest?.at === change.at) {
      await this.settle(record, { tellAt: null });
    }
  }

  /** Tell the owner, once, that its watch stopped. The record says so too, and stays broken until resumed. */
  private tellBroken(record: StateRecord): void {
    const owner = ownerOf(record);
    if (!owner || telling.has(record.id)) return;
    const job = this.wakeOwner(owner, record, brokenPrompt(record))
      .then((outcome) => {
        if (outcome === "gone") return this.ownerGone(owner, record);
        if (outcome !== "ran")
          this.log(`${owner} wasn't told watch ${record.id} broke (${outcome}); the record says so`);
      })
      .finally(() => telling.delete(record.id));
    telling.set(record.id, job);
  }

  private async wakeOwner(owner: string, record: StateRecord, prompt: string): Promise<WakeOutcome | "failed"> {
    const wake: Wake = { kind: "watch", ref: record.id };
    try {
      return await this.opts.wake(owner, { prompt, sessionKey: `watch:${record.id}`, wake });
    } catch (err) {
      // The owner was woken and its turn failed: told, as far as the runner can do anything about it.
      this.warn(`${owner}'s turn for watch ${record.id} failed: ${(err as Error).message}`);
      return "failed";
    }
  }

  /** An owner that isn't an agent any more: the watch is paused, saying why, rather than fetched for nobody. */
  private async ownerGone(owner: string, record: StateRecord): Promise<void> {
    this.warn(`watch ${record.id} belongs to ${owner}, who isn't an agent any more; it is paused`);
    await this.settle(record, {
      status: "paused",
      tellAt: null,
      lastError: `Its owner ${owner} isn't an agent any more.`,
    });
  }

  /** A bookkeeping write after a wake, which may find the watch removed in the turn it started. */
  private async settle(record: StateRecord, changes: Record<string, unknown>): Promise<void> {
    try {
      await this.opts.service().patch(writerFor(ownerOf(record) ?? ""), { type: WATCH_TYPE, id: record.id }, changes);
    } catch (err) {
      this.log(`watch ${record.id} wasn't updated after its wake: ${(err as Error).message}`);
    }
  }
}

/** Why a check failed, in a sentence for the record and the owner. */
export function failureText(err: unknown, timeoutMs: number): string {
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `The check took longer than ${Math.max(1, Math.round(timeoutMs / 1000))}s.`;
  }
  const text = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : String(err);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The label a watch goes by in a prompt: its own, or what it looks at. */
function labelOf(record: StateRecord): string {
  const label = typeof record.data.label === "string" ? record.data.label.trim() : "";
  return label || whereOf(configOf(record)) || record.id;
}

/** `price on hotels.example/lisbon, every 2 hours`: what the watch is, for the line that names it. */
function aboutOf(record: StateRecord): string {
  const where = whereOf(configOf(record));
  const every =
    typeof record.data.every === "string" && record.data.every
      ? `, every ${record.data.every.replace(/^every\s+/i, "")}`
      : "";
  return `${String(record.data.kind ?? "watch")}${where ? ` on ${where}` : ""}${every}`;
}

/** "40 minutes ago", "3 hours ago": how long ago a change a wake was owed for was seen. */
function agoWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  return minutes < 90 ? count(minutes, "minute") : count(Math.round(minutes / 60), "hour");
}

const NOBODY_READS =
  "Nobody is reading this session. If something here needs to reach a person, send it; a reply here goes nowhere on its own.";

/** The turn a change starts: the watch's label, the change, what the owner asked for, and how to act. */
export function changePrompt(record: StateRecord, now: number): string {
  const change = record.data.lastChange as { at?: string; text?: string };
  const note = typeof record.data.note === "string" && record.data.note.trim() ? record.data.note.trim() : undefined;
  const value = record.data.lastValue;
  const since = typeof change.at === "string" ? now - Date.parse(change.at) : 0;
  const late = since > TELL_RETRY_MS ? ` ${agoWords(since)}` : "";
  return [
    `Your watch "${labelOf(record)}" saw a change${late}. Nobody has asked you anything.`,
    "",
    String(change.text),
    ...(value !== undefined && value !== null && value !== "" ? [`It reads ${String(value)} now.`] : []),
    ...(note ? [`When you set it up, you asked: ${note}`] : []),
    `(watch ${record.id}: ${aboutOf(record)})`,
    "",
    "Act on it if it needs anything. If it doesn't, say so in one line and stop.",
    NOBODY_READS,
  ].join("\n");
}

/** The turn that tells an owner its watch stopped. */
export function brokenPrompt(record: StateRecord): string {
  const error = typeof record.data.lastError === "string" ? record.data.lastError : "no reason given";
  return [
    `Your watch "${labelOf(record)}" stopped: its last ${MAX_FAILURES} checks failed. The last one said: ${error}`,
    `(watch ${record.id}: ${aboutOf(record)})`,
    "",
    "It won't be checked again until it is resumed. With the watch tool, resume tries it again as it is; remove it and add it again to change its settings.",
    NOBODY_READS,
  ].join("\n");
}
