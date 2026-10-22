/**
 * Finding records by what they say, for the types that opt in with `search`.
 *
 * A record is matched one of two ways, and a search uses the better one each
 * record has:
 *
 * - **Meaning.** With an embedder configured (`memory.embeddings`), each
 *   record's search text is embedded in the background and kept in
 *   `state_search`, beside the record's scope, the embedder that made the
 *   vector, and a hash of the text it was made from. A vector counts only
 *   while that hash still matches the record, that embedder is still the one
 *   configured, and it is as long as the query's (a model swapped in behind
 *   the same name makes vectors of another length), so a stale vector is
 *   never used: the record is matched by words instead, and queued to be
 *   embedded again.
 * - **Words.** Overlap between the query's words and the record's, rarer words
 *   counting for more. Always available, and what a record is matched by until
 *   it has a current vector.
 *
 * The index never decides who sees what. A search's candidates come from the
 * store's own query, scoped exactly as `StateService.query` scopes them; the
 * index only supplies vectors for records the caller could already read.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { blobToVector, type EmbeddingProvider, vectorToBlob } from "../providers/embedding.js";
import type { StateRef, StateTypeDef } from "./types.js";

/** Most texts sent in one embedding call. */
const BATCH_SIZE = 16;
/** Least time between one embedding call and the next, so a backfill of thousands never floods the embedder. */
const PAUSE_MS = 1_000;
/** An embedding call that has not answered by now is abandoned, so one hung request can't stall the index. */
const CALL_TIMEOUT_MS = 60_000;
/** How long a search waits for its query's vector before matching words instead. */
const QUERY_TIMEOUT_MS = 10_000;
/** Failed calls in a row before the queue is dropped, to be refilled by the next backfill or search. */
const GIVE_UP_AFTER = 3;

/** Nested arrays and objects read for text, at most this deep. */
const MAX_DEPTH = 8;

/**
 * The fields a type is searched by, or none when it doesn't opt in. Read
 * through here rather than straight off the definition: config shape problems
 * are only warnings, so `fields: summary` (a string) or a number in the list
 * reaches the runtime as written, and either way the type counts as not
 * searchable, as the config warning says, instead of failing later.
 */
export function searchFields(def: StateTypeDef | undefined): string[] {
  const fields = def?.search?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim());
}

/**
 * Whether a vector can be compared at all: some length, every entry a finite
 * number, and not all zeros. An embedder that answers with less than it was
 * asked for can leave empty slots, and cosine against one is always 0.
 */
export function usableVector(v: Float32Array | undefined): v is Float32Array {
  if (!v || v.length === 0) return false;
  let norm = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return false;
    norm += x * x;
  }
  return norm > 0;
}

/**
 * The text a record is searched by: the values of its type's search fields,
 * one per line. Empty when none of them hold any text.
 */
export function searchText(fields: readonly string[], data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of fields) collect(pick(data, field.split(".")), parts, 0);
  return parts.join("\n");
}

/** Every value at a dotted path, reading through arrays on the way, so `updates.text` finds each update's text. */
function pick(value: unknown, path: string[]): unknown[] {
  if (path.length === 0) return [value];
  if (Array.isArray(value)) return value.flatMap((v) => pick(v, path));
  if (value === null || typeof value !== "object") return [];
  return pick((value as Record<string, unknown>)[path[0]], path.slice(1));
}

/** Strings and numbers, reading into arrays and objects. Anything else holds no text. */
function collect(values: unknown[], out: string[], depth: number): void {
  for (const value of values) {
    if (typeof value === "string") {
      const text = value.trim();
      if (text) out.push(text);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      out.push(String(value));
    } else if (depth < MAX_DEPTH && value !== null && typeof value === "object") {
      collect(Array.isArray(value) ? value : Object.values(value), out, depth + 1);
    }
  }
}

/**
 * The query's vector, or undefined when the embedder fails or takes longer
 * than a search should wait, in which case the search matches words.
 */
export async function embedQuery(embedder: EmbeddingProvider, text: string): Promise<Float32Array | undefined> {
  const controller = new AbortController();
  try {
    const result = await within(
      () => embedder.embed([text], { signal: controller.signal }),
      QUERY_TIMEOUT_MS,
      controller,
    );
    const vector = result.vectors[0];
    // An empty or all-zero answer would make every stored vector look stale.
    if (!usableVector(vector)) throw new Error("the embedder returned no usable vector");
    return vector;
  } catch (err) {
    console.warn(`[state] search matched words only: embedding the query failed: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * `work`, unless `ms` pass or `controller` is aborted first. The race is what
 * bounds the wait: an embedder that ignores its signal can't hold a search,
 * or the index, past it. Its late answer is dropped.
 */
export function within<T>(work: () => Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cut = new Promise<never>((_, reject) => {
    const stop = (why: string) => reject(new Error(why));
    timer = setTimeout(() => {
      stop(`no answer in ${ms / 1000}s`);
      controller.abort();
    }, ms);
    timer.unref?.();
    controller.signal.addEventListener("abort", () => stop("stopped"), { once: true });
  });
  // Through `then`, so an embedder that throws before returning a promise is a rejection like any other.
  return Promise.race([Promise.resolve().then(work), cut]).finally(() => clearTimeout(timer));
}

/** A short, stable fingerprint of a record's search text, to tell when its vector no longer describes it. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is " +
    "it its me my no not of on or our she so than that the their them then there these they this to too us was we " +
    "were what when where which who why will with would you your"
  ).split(" "),
);

/**
 * A text's words for matching: lowercased, accents and stopwords dropped, and
 * a trailing plural `s` taken off, so "hotels" meets "hotel".
 */
export function wordsOf(text: string): string[] {
  const words: string[] = [];
  for (const raw of text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || STOPWORDS.has(raw)) continue;
    words.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return words;
}

/**
 * How much of the query each text covers: the share of the query's distinct
 * words it contains, each weighted by how rare it is among `texts`, so
 * "lisbon" counts for more than "trip" when every record mentions a trip. 0
 * when no word matches, 1 when every one does.
 */
export function wordScores(query: string, texts: readonly string[]): number[] {
  const terms = [...new Set(wordsOf(query))];
  const sets = texts.map((text) => new Set(wordsOf(text)));
  if (terms.length === 0) return sets.map(() => 0);
  const weights = terms.map((term) => {
    let holders = 0;
    for (const words of sets) if (words.has(term)) holders++;
    return Math.log(1 + (sets.length + 1) / (holders + 1));
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  return sets.map((words) => terms.reduce((sum, term, i) => sum + (words.has(term) ? weights[i] : 0), 0) / total);
}

/** One record waiting to be embedded. */
interface Queued {
  type: string;
  id: string;
  scope: string;
  text: string;
  hash: string;
}

interface IndexRow {
  id: string;
  scope: string;
  vector: Buffer;
  text_hash: string;
}

/** A record's vector, the scope it was last seen in, and the hash of the text it was made from. */
export interface IndexedVector {
  scope: string;
  hash: string;
  vector: Float32Array;
}

export interface StateSearchIndexOptions {
  db: Database.Database;
  /** Read for every call, so a reload that changes the embedder is picked up without rebuilding the index. */
  getEmbedder: () => EmbeddingProvider | undefined;
  batchSize?: number;
  pauseMs?: number;
}

/**
 * Vectors for searchable records, kept in the runtime database and brought up
 * to date in the background. Nothing here is on a write's path: a change only
 * queues work, and embedding happens later, paced, so a slow or failing
 * embedder never slows or fails a write.
 */
export class StateSearchIndex {
  private readonly db: Database.Database;
  private readonly batchSize: number;
  private readonly pauseMs: number;
  /** Keyed by type and id. A newer change to a queued record replaces its entry. */
  private readonly queued = new Map<string, Queued>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private inFlight: AbortController | undefined;
  private lastCall = 0;
  private failures = 0;
  private closed = false;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly opts: StateSearchIndexOptions) {
    this.db = opts.db;
    this.batchSize = opts.batchSize ?? BATCH_SIZE;
    this.pauseMs = opts.pauseMs ?? PAUSE_MS;
    // Core's own table, made here rather than in the schema migrations so the
    // index works on whatever database the state service is given. Additive:
    // a database from before it simply starts with nothing indexed.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_search (
        type        TEXT NOT NULL,
        id          TEXT NOT NULL,
        scope       TEXT NOT NULL,
        model       TEXT NOT NULL,
        vector      BLOB NOT NULL,
        text_hash   TEXT NOT NULL,
        indexed_at  TEXT NOT NULL,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX IF NOT EXISTS idx_state_search_scope ON state_search(type, model, scope);
    `);
  }

  /** The configured embedder, if any. */
  embedder(): EmbeddingProvider | undefined {
    return this.opts.getEmbedder();
  }

  /** How the index names an embedder. A vector made under another name is stale, so changing models re-embeds. */
  modelKey(embedder: EmbeddingProvider): string {
    return `${embedder.id}:${embedder.defaultModel}`;
  }

  /** A type's vectors made by `model`, by record id. `scopes` narrows them; undefined means every scope. */
  vectors(type: string, model: string, scopes?: string[]): Map<string, IndexedVector> {
    const clauses = ["type = ?", "model = ?"];
    const params: unknown[] = [type, model];
    if (scopes) {
      if (scopes.length === 0) return new Map();
      clauses.push(`scope IN (${scopes.map(() => "?").join(", ")})`);
      params.push(...scopes);
    }
    const rows = this.db
      .prepare(`SELECT id, scope, vector, text_hash FROM state_search WHERE ${clauses.join(" AND ")}`)
      .all(...params) as IndexRow[];
    return new Map(rows.map((r) => [r.id, { scope: r.scope, hash: r.text_hash, vector: blobToVector(r.vector) }]));
  }

  /**
   * A searchable record was written: keep its entry's scope current, and queue
   * it to be embedded unless its vector already matches this text. Empty text
   * leaves nothing to embed, so its entry goes.
   */
  changed(ref: StateRef, scope: string, text: string): void {
    if (!text) {
      this.removed(ref);
      return;
    }
    this.db
      .prepare("UPDATE state_search SET scope = ? WHERE type = ? AND id = ? AND scope <> ?")
      .run(scope, ref.type, ref.id, scope);
    const embedder = this.embedder();
    if (embedder) this.queue({ ...ref, scope, text, hash: hashText(text) }, this.modelKey(embedder));
  }

  /** A record was deleted or erased: its entry goes, and so does anything queued for it. */
  removed(ref: StateRef): void {
    this.queued.delete(keyOf(ref));
    this.db.prepare("DELETE FROM state_search WHERE type = ? AND id = ?").run(ref.type, ref.id);
  }

  /** Bring an entry's scope in line with where its record lives now. */
  moved(ref: StateRef, scope: string): void {
    this.db.prepare("UPDATE state_search SET scope = ? WHERE type = ? AND id = ?").run(scope, ref.type, ref.id);
  }

  /** The ids of every record of a type with an entry, whatever its model. */
  ids(type: string): string[] {
    return this.db.prepare("SELECT id FROM state_search WHERE type = ?").pluck().all(type) as string[];
  }

  /**
   * Queue a record to be embedded by `model`. Nothing is queued when its
   * vector already matches, or the same text is already waiting. `force`
   * queues it even when its row looks current, for a vector a search found it
   * can't use. Returns whether it is waiting now.
   */
  queue(item: Queued, model: string, force = false): boolean {
    if (this.closed) return false;
    const key = keyOf(item);
    const row = force
      ? undefined
      : (this.db
          .prepare("SELECT model, text_hash FROM state_search WHERE type = ? AND id = ?")
          .get(item.type, item.id) as { model: string; text_hash: string } | undefined);
    if (row && row.model === model && row.text_hash === item.hash) {
      this.queued.delete(key);
      return false;
    }
    const waiting = this.queued.get(key);
    if (waiting && waiting.hash === item.hash) {
      // The same text, maybe in a new scope. Updated in place, so a call
      // already out for it still lands, in the scope it is in now.
      waiting.scope = item.scope;
    } else {
      this.queued.set(key, item);
    }
    this.schedule();
    return true;
  }

  /** How many records are waiting to be embedded. */
  backlog(): number {
    return this.queued.size;
  }

  /**
   * Resolves once nothing is waiting or being embedded. While anyone waits,
   * the pause between calls holds the process open, so a script that awaits
   * this doesn't exit before the backlog is done.
   */
  whenIdle(): Promise<void> {
    if (!this.timer && !this.running && this.queued.size === 0) return Promise.resolve();
    this.timer?.ref?.();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Stop embedding and wait for a call already out to finish or abort. Nothing is written after this resolves. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queued.clear();
    this.inFlight?.abort();
    await this.running;
    this.settle();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.running || this.queued.size === 0) return;
    const wait = Math.max(0, this.lastCall + this.pauseMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.embedNext().finally(() => {
        this.running = undefined;
        if (this.queued.size > 0 && !this.closed) this.schedule();
        else this.settle();
      });
    }, wait);
    // A server has other reasons to stay up, and the backlog alone shouldn't
    // keep a process alive; one waiting on `whenIdle` should be kept alive.
    if (this.waiting.length === 0) this.timer.unref?.();
  }

  private settle(): void {
    for (const resolve of this.waiting.splice(0)) resolve();
  }

  private async embedNext(): Promise<void> {
    const embedder = this.embedder();
    if (!embedder) {
      // Embeddings were turned off after these were queued. Nothing can embed
      // them now, and search matches them by words.
      this.queued.clear();
      return;
    }
    const model = this.modelKey(embedder);
    const batch = [...this.queued.values()].slice(0, this.batchSize);
    // Everything queued may have been deleted or settled since the timer was set.
    if (batch.length === 0) return;
    this.lastCall = Date.now();
    const controller = new AbortController();
    this.inFlight = controller;
    let vectors: Float32Array[];
    try {
      const result = await within(
        () =>
          embedder.embed(
            batch.map((b) => b.text),
            { signal: controller.signal },
          ),
        CALL_TIMEOUT_MS,
        controller,
      );
      if (result.vectors.length !== batch.length) {
        throw new Error(`asked for ${batch.length} vectors and got ${result.vectors.length}`);
      }
      // A call that answered with nothing usable failed as surely as one that threw.
      if (!result.vectors.some((v) => usableVector(v))) throw new Error("no usable vector came back");
      vectors = result.vectors;
      this.failures = 0;
    } catch (err) {
      if (this.closed) return;
      this.failed(batch, (err as Error).message);
      return;
    } finally {
      this.inFlight = undefined;
    }
    if (this.closed) return;

    const upsert = this.db.prepare(
      `INSERT INTO state_search (type, id, scope, model, vector, text_hash, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, id) DO UPDATE SET scope = excluded.scope, model = excluded.model,
         vector = excluded.vector, text_hash = excluded.text_hash, indexed_at = excluded.indexed_at`,
    );
    const at = new Date().toISOString();
    const dim = commonLength(vectors);
    let refused = 0;
    for (const [i, item] of batch.entries()) {
      const key = keyOf(item);
      // Changed again, deleted or erased while the call was out: the newer
      // state stands, and a deleted record never comes back as a vector.
      if (this.queued.get(key) !== item) continue;
      this.queued.delete(key);
      // An empty slot, or a vector unlike the rest of its batch, would be
      // stored as current and never match. Left out, the record stays on
      // words, and a search or backfill queues it again.
      if (!usableVector(vectors[i]) || vectors[i].length !== dim) {
        refused++;
        continue;
      }
      try {
        upsert.run(item.type, item.id, item.scope, model, vectorToBlob(vectors[i]), item.hash, at);
      } catch (err) {
        console.warn(
          `[state] could not save the search vector for ${key.replace("\u0000", "/")}: ${(err as Error).message}`,
        );
      }
    }
    if (refused > 0) {
      console.warn(
        `[state] the embedder gave ${refused} of ${batch.length} record(s) an empty or odd-sized vector; they are found by words meanwhile`,
      );
    }
  }

  private failed(batch: Queued[], message: string): void {
    for (const item of batch) {
      const key = keyOf(item);
      if (this.queued.get(key) === item) this.queued.delete(key);
    }
    this.failures++;
    if (this.failures < GIVE_UP_AFTER) {
      console.warn(
        `[state] embedding ${batch.length} record(s) for search failed (${message}); they are found by words meanwhile`,
      );
      return;
    }
    console.warn(
      `[state] embedding for search failed ${this.failures} times in a row (${message}); ${this.queued.size} more record(s) are left to words until the next backfill or search`,
    );
    this.queued.clear();
    this.failures = 0;
  }
}

/** The length most of a batch's usable vectors share, which the odd ones out are measured against. */
function commonLength(vectors: Float32Array[]): number {
  const counts = new Map<number, number>();
  for (const v of vectors) if (usableVector(v)) counts.set(v.length, (counts.get(v.length) ?? 0) + 1);
  let best = 0;
  let most = 0;
  for (const [length, count] of counts) {
    if (count > most) {
      best = length;
      most = count;
    }
  }
  return best;
}

function keyOf(ref: StateRef): string {
  return `${ref.type}\u0000${ref.id}`;
}
