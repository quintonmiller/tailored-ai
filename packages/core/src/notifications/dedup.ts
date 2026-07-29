import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

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
}

export type NotificationVerdict = "new" | "repeat-exact" | "repeat-similar" | "repeat-key" | "dedup-disabled";

export interface NotificationDecision {
  /** Whether the caller should actually send. */
  send: boolean;
  verdict: NotificationVerdict;
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

export class NotificationGate implements NotificationGateLike {
  constructor(
    private db: Database.Database,
    private getConfig: () => NotificationDedupConfig | undefined,
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

  /** Record that the message actually went out. */
  recordSent(candidate: NotificationCandidate): void {
    const normalized = normalizeForDedup(candidate.content);
    const dedupKey = candidate.key ?? hashKey(normalized);
    this.db
      .prepare(
        `INSERT INTO notification_log (source, channel, target, dedup_key, normalized, preview, sent_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(source, channel, target, dedup_key) DO UPDATE SET
           sent_count   = sent_count + 1,
           normalized   = excluded.normalized,
           preview      = excluded.preview,
           last_sent_at = datetime('now'),
           last_seen_at = datetime('now')`,
      )
      .run(
        candidate.source,
        candidate.channel,
        candidate.target,
        dedupKey,
        normalized,
        candidate.content.slice(0, 200),
      );
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
   * Gate a send. Runs `send` only when the message is news, and records the
   * outcome. A send that throws is not recorded, so a transport failure does
   * not suppress the retry.
   */
  async deliver(
    candidate: NotificationCandidate,
    send: () => Promise<void>,
    log?: (message: string) => void,
  ): Promise<NotificationDecision> {
    // Bookkeeping must never cost a message. A locked or migrating database
    // makes check() throw; without this the send would simply not happen, which
    // is the one outcome this module exists to prevent.
    let decision: NotificationDecision;
    try {
      decision = this.check(candidate);
    } catch (err) {
      log?.(`[notify] dedup check failed (${(err as Error).message}) — sending anyway`);
      await send();
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
    try {
      this.recordSent(candidate);
    } catch (err) {
      // The message is already out. Failing to log it only risks a future
      // duplicate, which is the safe direction.
      log?.(`[notify] failed to record sent notification: ${(err as Error).message}`);
    }
    return decision;
  }
}
