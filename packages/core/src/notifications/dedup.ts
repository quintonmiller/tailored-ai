import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus, NotificationFields } from "../events.js";

/**
 * Repeat suppression for unsolicited messages.
 *
 * The agent has two very different reasons to speak: because you asked, and
 * because it decided you should know something. Only the second kind routes
 * through this gate. A reply to a question you just asked is never suppressed,
 * however many times you ask it — repetition is only a defect when nobody
 * requested it.
 *
 * Two messages count as "the same thing" when either
 *   - the caller gives the same explicit `key` (preferred: it survives rewording), or
 *   - their normalized bodies are identical, or
 *   - their normalized bodies are similar enough to clear `similarityThreshold`.
 *
 * The similarity tier exists because a model asked to summarize the same
 * unchanged state twice rarely emits the same bytes twice — it rephrases. Exact
 * hashing alone would let a stream of near-identical restatements through.
 *
 * Given the runtime's bus, the gate also says what passes through it:
 * `notification.outgoing` before the repeat check, where a subscriber can hold
 * a message back, and `notification.sent` once one has gone out.
 */

export interface NotificationDedupConfig {
  /** Master switch. Default true. */
  enabled?: boolean;
  /**
   * How long a delivered message keeps suppressing its repeats, in hours.
   * After this the same content is treated as news again. Default 24.
   */
  windowHours?: number;
  /**
   * Jaccard score (0-1) over normalized word sets above which two messages are
   * "the same". 1 disables the similarity tier, leaving exact-match only.
   * Default 0.92, which tolerates a word or two of drift in a typical
   * notification. Safe to keep this low because messages whose numbers differ
   * are never matched by similarity — see {@link numbersIn}.
   */
  similarityThreshold?: number;
  /**
   * Messages shorter than this many words are compared exactly and never by
   * similarity. Short strings collide too easily ("Done." vs "Done!"). Default 12.
   */
  minWordsForSimilarity?: number;
  /**
   * How many words the candidate may contain that the already-sent message did
   * not, and still count as a repeat. Guards the case similarity alone cannot
   * see: an unchanged digest with one genuinely new line appended still scores
   * ~0.95, and that line is the news. Default 3.
   */
  maxNewWords?: number;
}

export const DEDUP_DEFAULTS = {
  enabled: true,
  windowHours: 24,
  similarityThreshold: 0.92,
  minWordsForSimilarity: 12,
  maxNewWords: 3,
} as const;

/** A message the agent wants to push at the owner without being asked. */
export interface NotificationCandidate {
  /** Stream identity, e.g. `cron:email-summary` or `owner-notifier:task.blocked`. */
  source: string;
  /** Outbound channel id. */
  channel: string;
  /** Recipient — user id for a DM, room id for a channel post. */
  target: string;
  /** The message body. */
  content: string;
  /**
   * Stable identity for the underlying fact, when the caller knows it.
   * Strongly preferred over content matching: `task:ptask_ab12:blocked` keeps
   * suppressing however the model rephrases the sentence.
   */
  key?: string;
  /**
   * Override the look-back window for this one message, in hours. Lets a
   * caller scale suppression to urgency — "the build is broken" may be worth
   * repeating every 15 minutes, "your weekly digest is ready" is not. Falls
   * back to the configured default when unset.
   */
  windowHours?: number;
  /**
   * What kind of message this is, for whoever listens on the bus. Coarse on
   * purpose: one per sort of initiative (`cron:<job>`, `digest`, `notify`), not
   * per fact, which is what `key` is for. Defaults to `source` with `agent`'s
   * name taken off the end. See {@link notificationKind}.
   */
  kind?: string;
  /** The agent sending it, when an agent is. */
  agent?: string;
}

/**
 * A candidate's kind: the one its caller named, or else its `source` with the
 * sending agent's name taken off the end, so `room:planner` from `planner` is
 * the kind `room`. A source that doesn't end in the agent's name is the kind
 * as it stands.
 */
export function notificationKind(candidate: Pick<NotificationCandidate, "source" | "kind" | "agent">): string {
  if (candidate.kind) return candidate.kind;
  const suffix = candidate.agent ? `:${candidate.agent}` : "";
  return suffix && candidate.source.endsWith(suffix) ? candidate.source.slice(0, -suffix.length) : candidate.source;
}

/**
 * `held` is a `notification.outgoing` subscriber holding the message back,
 * whether or not it was a repeat; the `repeat-*` verdicts are the gate's own.
 */
export type NotificationVerdict = "new" | "repeat-exact" | "repeat-similar" | "repeat-key" | "dedup-disabled" | "held";

export interface NotificationDecision {
  /** Whether the caller should actually send. */
  send: boolean;
  verdict: NotificationVerdict;
  /** Why a subscriber held the message back, when `verdict` is `held`. */
  reason?: string;
  /**
   * Primary key of the notification_log row that matched. Carried so
   * `recordSuppressed` updates exactly the row the decision came from instead
   * of re-deriving it from non-unique columns.
   */
  entryId?: number;
  /** Sends suppressed for this entry so far (excluding this one). */
  suppressedCount: number;
  firstSentAt?: string;
  lastSentAt?: string;
  /** Similarity score, only when verdict is `repeat-similar`. */
  similarity?: number;
}

interface LogRow {
  id: number;
  dedup_key: string;
  normalized: string;
  first_sent_at: string;
  last_sent_at: string;
  sent_count: number;
  suppressed_count: number;
}

/**
 * Lowercase, collapse whitespace, and drop markdown emphasis so that
 * cosmetic reformatting of an identical message still matches. Numbers and
 * words are left alone: "3 new listings" and "5 new listings" are genuinely
 * different news and must not collapse into each other.
 */
export function normalizeForDedup(content: string): string {
  return content
    .toLowerCase()
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** What the log keeps of a message, and what the bus is shown of it. */
function previewOf(content: string): string {
  return content.slice(0, 200);
}

/**
 * Split into comparable words. Punctuation is stripped at the edges so
 * "proceed." and "proceed" match — without this a single added trailing word
 * shifts the punctuation and costs two tokens instead of one, which was enough
 * to push real restatements below the threshold.
 */
function tokenize(text: string): string[] {
  return text
    .split(" ")
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/**
 * Every number appearing in the text, as a set.
 *
 * Numbers carry most of the news in a notification — a price, a count, a
 * listing id, a date. Two messages that differ only in a number ("$312" vs
 * "$412") can score above any sane word-similarity threshold while being
 * exactly the update the user needs, so a difference here vetoes similarity
 * matching entirely.
 */
export function numbersIn(text: string): Set<string> {
  return new Set(text.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[,.]+$/, "")) ?? []);
}

function sameNumbers(a: string, b: string): boolean {
  const na = numbersIn(a);
  const nb = numbersIn(b);
  if (na.size !== nb.size) return false;
  for (const n of na) if (!nb.has(n)) return false;
  return true;
}

/**
 * Words that flip the meaning of a message rather than decorate it.
 *
 * Word-set similarity is length-relative: in a 40-word body, swapping one word
 * still scores ~0.95. That is fine for "proceed" vs "proceed today" and fatal
 * for "completed successfully" vs "completed unsuccessfully" — the second is
 * precisely the message that must get through. If the polarity words differ at
 * all, the two messages are never treated as the same news.
 */
const POLARITY_WORDS = new Set([
  "no",
  "not",
  "never",
  "none",
  "fail",
  "failed",
  "failing",
  "failure",
  "unsuccessful",
  "unsuccessfully",
  "success",
  "succeeded",
  "successful",
  "successfully",
  "error",
  "errors",
  "unable",
  "cannot",
  "blocked",
  "unblocked",
  "open",
  "closed",
  "up",
  "down",
  "approved",
  "denied",
  "rejected",
  "cancelled",
  "canceled",
  "expired",
  "missing",
  "found",
  "online",
  "offline",
  "healthy",
  "unhealthy",
  "passed",
  "broken",
  "fixed",
  "stopped",
  "started",
]);

function samePolarity(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (POLARITY_WORDS.has(w) && !b.has(w)) return false;
  for (const w of b) if (POLARITY_WORDS.has(w) && !a.has(w)) return false;
  return true;
}

/**
 * Words present in the candidate but not in what was already sent.
 *
 * Jaccard is symmetric, so appending a whole new paragraph to an otherwise
 * unchanged digest still scores high — and that appended line is exactly the
 * new information. Suppression therefore also requires the candidate to be
 * saying (almost) nothing the user hasn't already been told.
 */
function newWordCount(candidate: Set<string>, prior: Set<string>): number {
  let n = 0;
  for (const w of candidate) if (!prior.has(w)) n += 1;
  return n;
}

/**
 * Jaccard overlap of the two word sets. Order- and count-insensitive on
 * purpose: a reordered or lightly padded restatement of the same message
 * should score high.
 */
export function wordSetSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return setA.size === setB.size ? 1 : 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** The part of {@link NotificationGate} consumers actually need. */
export interface NotificationGateLike {
  deliver(
    candidate: NotificationCandidate,
    send: () => Promise<void>,
    log?: (message: string) => void,
  ): Promise<NotificationDecision>;
}

/** A gate that suppresses nothing. Stands in when a host wired no gate. */
export const PASSTHROUGH_GATE: NotificationGateLike = {
  async deliver(_candidate, send) {
    await send();
    return { send: true, verdict: "dedup-disabled", suppressedCount: 0 };
  },
};

/**
 * Resolve a gate without ever letting gate plumbing block a message.
 *
 * Fail-open is deliberate: a duplicate is an annoyance, a dropped notification
 * is a missed thing the user needed to know. If the accessor is absent or
 * throws, everything still goes out.
 */
export function resolveGate(get?: () => NotificationGateLike | undefined): NotificationGateLike {
  try {
    return get?.() ?? PASSTHROUGH_GATE;
  } catch {
    return PASSTHROUGH_GATE;
  }
}

/**
 * Set while a `notification.outgoing` subscriber runs.
 *
 * A subscriber that sends a message of its own, such as a hook that copies
 * every message into an audit room, would otherwise run the waterfall again
 * from inside itself, and again from inside that, before the first message was
 * ever sent: the repeat check comes after the waterfall, so it cannot end the
 * loop. Module-wide rather than per gate, so two gates on one bus cannot pass
 * the loop between them.
 *
 * The store is a token switched off once the subscribers finish, not a flag.
 * Node carries the store into every timer and promise started inside `run`, so
 * a flag would also cover work a subscriber only started: a room post that arms
 * an agent's wake would hand the skip to that agent's whole turn, and to every
 * turn it wakes in turn, and a mute would stop applying to all of them.
 */
const insideOutgoing = new AsyncLocalStorage<{ live: boolean }>();

/**
 * How long the gate waits for `notification.outgoing` before sending anyway.
 *
 * A ceiling, not a tuning knob: it is there so a subscriber that never returns
 * delays a message instead of stopping every unprompted message, and with them
 * the room turn waiting on a post, until a restart. Set above the 120 seconds a
 * `script` hook gets by default, so a slow hook's refusal still counts.
 */
export const OUTGOING_TIMEOUT_MS = 300_000;

/** SQLite's `datetime('now')`, for a send the log couldn't give a time to. */
function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export class NotificationGate implements NotificationGateLike {
  constructor(
    private db: Database.Database,
    private getConfig: () => NotificationDedupConfig | undefined,
    /**
     * Where `notification.outgoing` and `notification.sent` go. Without a bus
     * the gate works exactly as it did before it had one, and says nothing.
     */
    private events?: EventBus,
  ) {}

  private settings() {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled ?? DEDUP_DEFAULTS.enabled,
      windowHours: c.windowHours ?? DEDUP_DEFAULTS.windowHours,
      similarityThreshold: c.similarityThreshold ?? DEDUP_DEFAULTS.similarityThreshold,
      minWordsForSimilarity: c.minWordsForSimilarity ?? DEDUP_DEFAULTS.minWordsForSimilarity,
      maxNewWords: c.maxNewWords ?? DEDUP_DEFAULTS.maxNewWords,
    };
  }

  /**
   * Decide whether `candidate` is news. Read-only — call `recordSent` after a
   * successful send, or use `deliver` to get both in the right order.
   */
  check(candidate: NotificationCandidate): NotificationDecision {
    const { enabled, similarityThreshold, minWordsForSimilarity, maxNewWords } = this.settings();
    if (!enabled) return { send: true, verdict: "dedup-disabled", suppressedCount: 0 };

    const windowHours = candidate.windowHours ?? this.settings().windowHours;
    const normalized = normalizeForDedup(candidate.content);
    const dedupKey = candidate.key ?? hashKey(normalized);

    const rows = this.db
      .prepare(
        `SELECT id, dedup_key, normalized, first_sent_at, last_sent_at, sent_count, suppressed_count
         FROM notification_log
         WHERE source = ? AND channel = ? AND target = ?
           AND sent_count > 0
           AND datetime(last_sent_at) > datetime('now', ?)`,
      )
      .all(candidate.source, candidate.channel, candidate.target, `-${windowHours} hours`) as LogRow[];

    // 1. Explicit key, or the identical body, is an unambiguous repeat.
    const exact = rows.find((r) => r.dedup_key === dedupKey || r.normalized === normalized);
    if (exact) {
      return {
        send: false,
        verdict: candidate.key && exact.dedup_key === candidate.key ? "repeat-key" : "repeat-exact",
        entryId: exact.id,
        suppressedCount: exact.suppressed_count,
        firstSentAt: exact.first_sent_at,
        lastSentAt: exact.last_sent_at,
      };
    }

    // 2. Otherwise look for a restatement of something already sent.
    if (similarityThreshold < 1) {
      const words = tokenize(normalized).length;
      if (words >= minWordsForSimilarity) {
        const candidateWords = new Set(tokenize(normalized));
        let best: { row: LogRow; score: number } | undefined;
        for (const row of rows) {
          const priorWords = new Set(tokenize(row.normalized));
          if (priorWords.size < minWordsForSimilarity) continue;
          // Three vetoes, each covering a way that "looks the same" and
          // "is the same news" come apart. Any one of them means deliver.
          if (!sameNumbers(normalized, row.normalized)) continue;
          if (!samePolarity(candidateWords, priorWords)) continue;
          if (newWordCount(candidateWords, priorWords) > maxNewWords) continue;
          const score = wordSetSimilarity(normalized, row.normalized);
          if (!best || score > best.score) best = { row, score };
        }
        if (best && best.score >= similarityThreshold) {
          return {
            send: false,
            verdict: "repeat-similar",
            similarity: best.score,
            entryId: best.row.id,
            suppressedCount: best.row.suppressed_count,
            firstSentAt: best.row.first_sent_at,
            lastSentAt: best.row.last_sent_at,
          };
        }
      }
    }

    return { send: true, verdict: "new", suppressedCount: 0 };
  }

  /** Record that the message actually went out, and say on which row and when. */
  recordSent(candidate: NotificationCandidate): { id: number; at: string } {
    const normalized = normalizeForDedup(candidate.content);
    const dedupKey = candidate.key ?? hashKey(normalized);
    const row = this.db
      .prepare(
        `INSERT INTO notification_log (source, channel, target, dedup_key, normalized, preview, sent_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(source, channel, target, dedup_key) DO UPDATE SET
           sent_count   = sent_count + 1,
           normalized   = excluded.normalized,
           preview      = excluded.preview,
           last_sent_at = datetime('now'),
           last_seen_at = datetime('now')
         RETURNING id, last_sent_at`,
      )
      .get(
        candidate.source,
        candidate.channel,
        candidate.target,
        dedupKey,
        normalized,
        previewOf(candidate.content),
      ) as { id: number; last_sent_at: string };
    return { id: row.id, at: row.last_sent_at };
  }

  /**
   * Record that a repeat was withheld. Keyed on the entry that matched, so the
   * counter tracks "how many times we spared you this" rather than creating a
   * new row per suppressed attempt.
   */
  recordSuppressed(_candidate: NotificationCandidate, decision: NotificationDecision): void {
    // Uses the id the decision came from. Re-deriving the row from
    // (source, channel, target, first_sent_at) looked equivalent but is not:
    // first_sent_at has one-second resolution and no uniqueness, so two
    // notifications sent in the same second would charge the counter to
    // whichever row SQLite scanned first.
    if (decision.entryId === undefined) return;
    this.db
      .prepare(
        `UPDATE notification_log
         SET suppressed_count = suppressed_count + 1, last_seen_at = datetime('now')
         WHERE id = ?`,
      )
      .run(decision.entryId);
  }

  /**
   * Gate a send. Runs `send` only when the message is news and no
   * `notification.outgoing` subscriber held it back, and records the outcome.
   * A send that throws is not recorded, so a transport failure does not
   * suppress the retry, and it is not announced as sent.
   */
  async deliver(
    candidate: NotificationCandidate,
    send: () => Promise<void>,
    log?: (message: string) => void,
  ): Promise<NotificationDecision> {
    const fields: NotificationFields = {
      source: candidate.source,
      kind: notificationKind(candidate),
      ...(candidate.agent ? { agent: candidate.agent } : {}),
      channel: candidate.channel,
      target: candidate.target,
      preview: previewOf(candidate.content),
    };

    // Before the repeat check, so a subscriber sees every message, repeats
    // included. What it holds back is logged and left out of the table, whose
    // counts are of messages sent and repeats withheld. Not awaited at all
    // without a bus, so a gate with none runs as it did before it had one, nor
    // for a message a subscriber sends while it runs, which would otherwise
    // run the waterfall from inside itself without end.
    const held =
      this.events && !insideOutgoing.getStore()?.live ? await this.outgoing(this.events, fields, log) : undefined;
    if (held) {
      log?.(`[notify] suppressed ${candidate.source} -> ${candidate.target} (${held})`);
      return { send: false, verdict: "held", reason: held, suppressedCount: 0 };
    }

    // Bookkeeping must never cost a message. A locked or migrating database
    // makes check() throw; without this the send would simply not happen, which
    // is the one outcome this module exists to prevent.
    let decision: NotificationDecision;
    try {
      decision = this.check(candidate);
    } catch (err) {
      log?.(`[notify] dedup check failed (${(err as Error).message}) — sending anyway`);
      await send();
      this.announce(fields, undefined, log);
      return { send: true, verdict: "dedup-disabled", suppressedCount: 0 };
    }

    if (!decision.send) {
      try {
        this.recordSuppressed(candidate, decision);
      } catch {
        // Counter drift is cosmetic; the suppression decision still stands.
      }
      log?.(
        `[notify] suppressed ${candidate.source} -> ${candidate.target} (${decision.verdict}` +
          `${decision.similarity ? ` ${(decision.similarity * 100).toFixed(0)}%` : ""}` +
          `, first sent ${decision.firstSentAt}, ${decision.suppressedCount + 1} withheld since)`,
      );
      return decision;
    }
    await send();
    let recorded: { id: number; at: string } | undefined;
    try {
      recorded = this.recordSent(candidate);
    } catch (err) {
      // The message is already out. Failing to log it only risks a future
      // duplicate, which is the safe direction.
      log?.(`[notify] failed to record sent notification: ${(err as Error).message}`);
    }
    this.announce(fields, recorded, log);
    return decision;
  }

  /**
   * Run `notification.outgoing` and return the reason a subscriber gave for
   * holding the message back, if one did.
   *
   * Fails open, like the rest of the gate. The bus already skips a listener
   * that throws; this covers a bus that throws itself, because a broken
   * subscriber must not cost the message it was only looking at, and a
   * subscriber that takes longer than {@link OUTGOING_TIMEOUT_MS}.
   */
  private async outgoing(
    events: EventBus,
    fields: NotificationFields,
    log?: (message: string) => void,
  ): Promise<string | undefined> {
    const token = { live: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const waterfall = insideOutgoing.run(token, () => events.waterfall("notification.outgoing", { ...fields }));
      // Off when the subscribers finish rather than when the gate stops
      // waiting, so one still running past the timeout keeps its own sends
      // out of the waterfall. Registered first, so it is off before the
      // await below resumes.
      const off = () => {
        token.live = false;
      };
      waterfall.then(off, off);
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), OUTGOING_TIMEOUT_MS);
      });
      const out = await Promise.race([waterfall, timedOut]);
      if (out === "timeout") {
        log?.(`[notify] notification.outgoing timed out after ${OUTGOING_TIMEOUT_MS}ms — sending anyway`);
        return undefined;
      }
      return out?.deny || undefined;
    } catch (err) {
      token.live = false;
      log?.(`[notify] notification.outgoing failed (${(err as Error).message}) — sending anyway`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Say a message went out. Never throws: the send has already happened, and a
   * caller that saw an error here would report a delivered message as failed.
   */
  private announce(
    fields: NotificationFields,
    recorded: { id: number; at: string } | undefined,
    log?: (message: string) => void,
  ): void {
    if (!this.events) return;
    try {
      this.events.emit("notification.sent", {
        ...fields,
        ...(recorded ? { logId: recorded.id } : {}),
        at: recorded?.at ?? sqliteNow(),
      });
    } catch (err) {
      log?.(`[notify] notification.sent failed: ${(err as Error).message}`);
    }
  }
}
