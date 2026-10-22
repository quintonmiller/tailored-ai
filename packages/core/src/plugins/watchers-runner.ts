/**
 * The runner: checks every active watch when it comes due, keeps what it
 * found on the record, and wakes the owner when something changed. See
 * `docs/watchers.md`.
 *
 * The schedule starts from the records. Each look asks world state for active
 * watches whose `checkAt` has passed, so a person who sets `checkAt` to now on
 * the State page gets a check on the next look, and a restart checks every
 * watch it finds due.
 *
 * Its limits:
 *
 * - **Two checks at a time**, counted across every runner a reload has built,
 *   and never the same watch twice at once.
 * - **A check is written down only when it found something**: a change, a new
 *   reading, a failure, a new baseline. Every write is a full row in the
 *   record's history and a `state.changed`, so a check that found nothing new
 *   keeps its next due time in memory instead ({@link schedule}). The stored
 *   `checkAt` then lags until the next write, and a restart, with that memory
 *   gone, checks each such watch once at once.
 * - **A change wakes the owner** through `runtime.wakeAgent`, so the wake
 *   stops for the pause switch and counts toward the owner's hourly ceiling
 *   like every turn nobody asked for. Until the owner is told, the watch keeps
 *   `tellAt`, and a wake turned away is tried again every few minutes for a
 *   day. An owner is woken about one watch at a time.
 * - **The first check sets a baseline** and wakes nobody, as does the first
 *   check after a person changes a watch's settings.
 * - **Three failures in a row** mark a watch `broken`, and its owner is told,
 *   owed the same way as a change.
 */
import type { Wake, WakeAgentOptions, WakeOutcome } from "../agent/wake.js";
import type { StateQueryInput, StateService } from "../state/service.js";
import type { StateRecord } from "../state/types.js";
import type { WatcherKind, WatcherKindRegistryView, WatcherResult } from "../watchers/registry.js";
import {
  basisOf,
  clip,
  configOf,
  ERROR_CHARS,
  MAX_FAILURES,
  ownerOf,
  ownerProblem,
  previousOf,
  READER,
  sameJson,
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
/** How long until a watch whose check couldn't be written down is tried again. */
const STUCK_RETRY_MS = 15 * 60_000;
/** Records read per page while looking, and the most read in one look. */
const READ_PAGE = 100;
const READ_MOST = 2_000;

/**
 * Kept at module level so a reload, which disposes this runner and builds
 * another, carries them over:
 *
 * - `running`: watches being checked now, by id, so the new runner can't
 *   start a check the old one is in the middle of;
 * - `telling`: owners being woken about a watch now, by name, so an owner is
 *   woken about one watch at a time, its own sessions or not;
 * - `schedule`: a watch's next due time when its last check found nothing to
 *   write, with the stored `checkAt` it was worked out against. A `checkAt`
 *   that differs from that one was written since, by a person or the `watch`
 *   tool, and wins;
 * - `retries`: when a watch's owed wake may next be tried.
 */
const running = new Map<string, Promise<void>>();
const telling = new Map<string, Promise<void>>();
const schedule = new Map<string, { at: number; checkAt: unknown }>();
const retries = new Map<string, number>();

/** For tests: forget the next due times and retries kept in memory, as a restart does. */
export function resetWatchSchedule(): void {
  schedule.clear();
  retries.clear();
}

/** When a watch is next due, in milliseconds: the time kept in memory when it still holds, else its stored `checkAt`. Zero when it has none. */
function dueAt(record: StateRecord): number {
  const kept = schedule.get(record.id);
  if (kept && kept.checkAt === record.data.checkAt) return kept.at;
  const stored = typeof record.data.checkAt === "string" ? Date.parse(record.data.checkAt) : Number.NaN;
  return Number.isFinite(stored) ? stored : 0;
}

/** When a watch is next checked, as an ISO time, for a list line: the runner's own schedule, which the record lags. */
export function nextCheckAt(record: StateRecord): string | undefined {
  const at = dueAt(record);
  return at > 0 ? new Date(at).toISOString() : undefined;
}

/** What the runner needs of the registry: the kind a watch names, its settings checked, its interval, and a check's result made safe. */
export type KindsView = Pick<WatcherKindRegistryView, "get" | "validate" | "interval" | "result">;

export interface WatchRunnerOptions {
  service: () => StateService;
  kinds: KindsView;
  /** `runtime.wakeAgent`. */
  wake: (agent: string, opts: WakeAgentOptions) => Promise<WakeOutcome>;
  /** The `fetch` one check is handed (`watchFetch`), built anew for each check. */
  fetchFor: () => typeof fetch;
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
  /** Whether another look was asked for while one was going. */
  private again = false;
  /** A look asked for after a check or a wake ended, waiting for the event loop's next turn. */
  private soon: Promise<void> | undefined;
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
    while (this.looking || this.soon || running.size || telling.size) {
      await Promise.allSettled([this.looking, this.soon, ...running.values(), ...telling.values()]);
    }
  }

  /**
   * Look again once the event loop has had a turn: after a check or a wake
   * ends, which may have freed a slot or an owner. Deferred rather than
   * chained, so that a look that keeps finding work never runs as one unbroken
   * chain of promises, which would starve every timer and socket in the process.
   */
  private lookSoon(): void {
    if (this.stopped || this.soon) return;
    this.soon = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      this.soon = undefined;
      return this.tick();
    });
  }

  /**
   * One look: start checks for due watches while there's room, and try again
   * to tell owners whose wake is owed. Only one look at a time per runner. A
   * look asked for while one is going runs once that one ends, since the one
   * going may already have read past what the asker freed: a check slot, or
   * an owner's turn.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.looking) {
      this.again = true;
      return this.looking;
    }
    this.looking = this.look()
      .catch((err: unknown) => this.warn(`couldn't look for due watches: ${(err as Error).message}`))
      .finally(() => {
        this.looking = undefined;
        if (this.again) {
          this.again = false;
          void this.tick();
        }
      });
    return this.looking;
  }

  private async look(): Promise<void> {
    const now = this.now();
    const iso = new Date(now).toISOString();
    const service = this.opts.service();
    if (running.size < MAX_RUNNING) {
      // Due by the record, and among those, due by the schedule kept in memory too. One a
      // person made on the State page may have no checkAt at all: due now.
      const stored = await this.readAll(service, {
        type: WATCH_TYPE,
        where: { status: "active", checkAt: { lte: iso } },
      });
      const unscheduled = await this.readAll(service, { type: WATCH_TYPE, where: { status: "active", checkAt: null } });
      const due = [...unscheduled, ...stored]
        .filter((record) => !running.has(record.id) && dueAt(record) <= now)
        .sort((a, b) => dueAt(a) - dueAt(b));
      for (const record of due) {
        if (this.stopped || running.size >= MAX_RUNNING) break;
        const job = this.check(record)
          .catch((err: unknown) => {
            this.warn(`watch ${record.id} wasn't recorded: ${(err as Error).message}`);
            // Not straight back into a check that will fail the same way.
            schedule.set(record.id, { at: this.now() + STUCK_RETRY_MS, checkAt: record.data.checkAt });
          })
          .finally(() => {
            running.delete(record.id);
            // A slot just came free: look again rather than leave it empty until the next tick.
            this.lookSoon();
          });
        running.set(record.id, job);
      }
    }
    const owed = await this.readAll(service, { type: WATCH_TYPE, where: { tellAt: { lte: iso } } });
    for (const record of owed) {
      if (this.stopped) break;
      if ((retries.get(record.id) ?? 0) > now) continue;
      this.tellOwner(record);
    }
  }

  /**
   * Every record a query matches, read a page at a time until one comes back
   * empty, so a store that caps its pages lower than asked is still read to
   * the end. Stops too at a page with nothing new, for a store that ignores
   * `offset`, and at {@link READ_MOST}.
   */
  private async readAll(service: StateService, query: StateQueryInput): Promise<StateRecord[]> {
    const seen = new Map<string, StateRecord>();
    for (let offset = 0; seen.size < READ_MOST; ) {
      const page = await service.query(READER, {
        ...query,
        orderBy: { field: "id", direction: "asc" },
        limit: READ_PAGE,
        offset,
      });
      let fresh = 0;
      for (const record of page) {
        if (seen.has(record.id)) continue;
        seen.set(record.id, record);
        fresh++;
      }
      if (fresh === 0) break;
      offset += page.length;
    }
    return [...seen.values()];
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
            fetch: this.opts.fetchFor(),
          }),
        ),
        timedOut,
      ]);
      return this.opts.kinds.result(raw, previous);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Check one due watch and write down what it found, when it found anything. */
  private async check(listed: StateRecord): Promise<void> {
    const service = this.opts.service();
    const ref = { type: WATCH_TYPE, id: listed.id };
    // Read again: the look's copy may be from before another check of it finished, and
    // checking from that copy's snapshot would report the same change twice.
    const record = await service.get(READER, ref);
    if (!record || record.archivedAt || statusOf(record) !== "active" || dueAt(record) > this.now()) return;
    const started = this.now();
    const at = new Date(started).toISOString();
    const owner = ownerOf(record);
    const writer = writerFor(owner ?? "");
    const name = String(record.data.kind ?? "");

    // Things only a person can put right pause the watch, saying why, rather than wake anyone.
    const mismatch = ownerProblem(record);
    if (mismatch) {
      this.warn(`watch ${record.id} is paused: ${mismatch}`);
      await service.patch(writer, ref, { status: "paused", tellAt: null, lastError: mismatch });
      return;
    }

    const kind = this.opts.kinds.get(name);
    if (!kind) {
      if (!this.warnedKinds.has(name)) {
        this.warnedKinds.add(name);
        this.warn(`no loaded plugin brings the "${name}" kind, so watches of it wait`);
      }
      const waiting = `No loaded plugin brings the "${name}" kind, so it can't be checked.`;
      if (record.data.lastError === waiting) {
        schedule.set(record.id, { at: started + NO_KIND_RETRY_MS, checkAt: record.data.checkAt });
        return;
      }
      schedule.delete(record.id);
      await service.patch(writer, ref, {
        checkAt: new Date(started + NO_KIND_RETRY_MS).toISOString(),
        lastError: waiting,
      });
      return;
    }

    const config = configOf(record);
    // The tool checks settings before it saves them; a person's edit on the State page can still break them.
    const problems = this.opts.kinds.validate(kind, config);
    if (problems.length) {
      const why = clip(`Its settings don't suit a ${kind.kind} watch: ${problems.join(" ")}`, ERROR_CHARS);
      this.warn(`watch ${record.id} is paused: ${why}`);
      await service.patch(writer, ref, { status: "paused", tellAt: null, lastError: why });
      return;
    }

    const basis = basisOf(kind.kind, config);
    const previous = previousOf(record, basis);
    const interval = this.opts.kinds.interval(kind, record.data.every);
    const fallback = this.opts.kinds.interval(kind);
    const everyMs =
      typeof interval === "string" ? (typeof fallback === "string" ? NO_KIND_RETRY_MS : fallback.ms) : interval.ms;
    const nextAt = started + everyMs;
    const checkAt = new Date(nextAt).toISOString();

    let result: WatcherResult | undefined;
    let error: string | undefined;
    try {
      result = await this.run(kind, config, previous);
    } catch (err) {
      error = failureText(err, this.opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS);
    }

    // What a person or the owner did while it ran wins: paused, removed, or its settings changed.
    const now = await service.get(READER, ref);
    if (!now || now.archivedAt || statusOf(now) !== "active") {
      schedule.delete(record.id);
      return;
    }
    if (now.data.kind !== record.data.kind || basisOf(kind.kind, configOf(now)) !== basis) return;

    if (error !== undefined) {
      const failures = (typeof now.data.failures === "number" ? now.data.failures : 0) + 1;
      const broken = failures >= MAX_FAILURES;
      schedule.delete(record.id);
      const saved = await service.patch(writer, ref, {
        checkAt,
        failures,
        lastError: clip(error, ERROR_CHARS),
        // Broken is news the owner is owed, like a change.
        ...(broken ? { status: "broken", tellAt: at } : {}),
      });
      this.log(`watch ${record.id} failed (${failures} in a row): ${error}`);
      if (broken) this.tellOwner(saved);
      return;
    }

    const found = result as WatcherResult;
    const snapshot = { basis, data: found.snapshot };
    const quiet =
      found.change === undefined &&
      sameJson(snapshot, now.data.snapshot) &&
      sameJson(found.value ?? null, now.data.lastValue ?? null) &&
      !now.data.failures &&
      now.data.lastError === undefined;
    if (quiet) {
      // Nothing to write down: the next due time is kept here, against the checkAt the record has now.
      schedule.set(record.id, { at: nextAt, checkAt: now.data.checkAt });
      return;
    }

    schedule.delete(record.id);
    const saved = await service.patch(writer, ref, {
      checkAt,
      checkedAt: at,
      snapshot,
      lastValue: found.value ?? null,
      failures: 0,
      lastError: null,
      ...(found.change ? { lastChange: { at, text: found.change }, tellAt: at } : {}),
    });
    if (found.change) {
      this.log(`watch ${record.id} changed: ${found.change}`);
      this.tellOwner(saved);
    }
  }

  /**
   * Wake the owner about what its watch is owed: the last change, or that it
   * broke. One watch at a time per owner; another owed meanwhile keeps its
   * `tellAt`, and is told on the look after this turn ends.
   */
  private tellOwner(record: StateRecord): void {
    const owner = ownerOf(record);
    if (!owner) {
      void this.settle(record, { tellAt: null });
      return;
    }
    if (telling.has(owner)) return;
    const job = this.tell(record, owner)
      .catch((err: unknown) => this.warn(`couldn't tell ${owner} about watch ${record.id}: ${(err as Error).message}`))
      .finally(() => {
        telling.delete(owner);
        this.lookSoon();
      });
    telling.set(owner, job);
  }

  private async tell(record: StateRecord, owner: string): Promise<void> {
    const now = this.now();
    // Whatever happens below, not tried again before the retry is due.
    retries.set(record.id, now + TELL_RETRY_MS);
    // Read again: a person may have paused it, or a newer change come in, since this was owed.
    const current = await this.opts
      .service()
      .get(READER, { type: WATCH_TYPE, id: record.id })
      .catch(() => null);
    if (!current || current.archivedAt || current.data.tellAt === undefined) {
      retries.delete(record.id);
      return;
    }
    const status = statusOf(current);
    const problem = ownerProblem(current);
    if (status === "paused" || problem) {
      retries.delete(record.id);
      return this.settle(current, problem ? { status: "paused", tellAt: null, lastError: problem } : { tellAt: null });
    }
    // tellAt is when the news came, so a change owed is the one seen then. Anything else (a
    // broken watch resumed before its notice went out, say) leaves nothing standing to tell.
    const change = current.data.lastChange as { at?: unknown; text?: unknown } | undefined;
    const broken = status === "broken";
    if (!broken && (typeof change?.text !== "string" || change.at !== current.data.tellAt)) {
      retries.delete(record.id);
      return this.settle(current, { tellAt: null });
    }
    const since = Date.parse(String(current.data.tellAt));
    if (Number.isFinite(since) && now - since > OWED_FOR_MS) {
      this.log(`gave up telling ${owner} about watch ${record.id}: it has been a day; the record keeps what happened`);
      retries.delete(record.id);
      return this.settle(current, { tellAt: null });
    }

    const prompt = broken ? brokenPrompt(current) : changePrompt(current, now);
    const outcome = await this.wakeOwner(owner, current, prompt);
    if (outcome === "paused" || outcome === "at-ceiling") {
      // Still owed, and nothing written: the retry is kept in memory, and tellAt already says it's owed.
      this.log(`${owner} wasn't woken for watch ${record.id} (${outcome}); trying again in a few minutes`);
      return;
    }
    retries.delete(record.id);
    if (outcome === "gone") return this.ownerGone(owner, current);
    // Told. News that came in while the turn ran has its own tellAt, which stays owed.
    const after = await this.opts
      .service()
      .get(READER, { type: WATCH_TYPE, id: record.id })
      .catch(() => null);
    if (after && !after.archivedAt && after.data.tellAt === current.data.tellAt) {
      await this.settle(after, { tellAt: null });
    }
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

  /** A bookkeeping write around a wake, which may find the watch removed in the turn it started. */
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
