/**
 * Everything around storage: the one place state is read and written.
 *
 * A provider only stores and retrieves. This service resolves the type,
 * checks who may read or write it and which scopes the caller can see,
 * validates the data, picks the scope a new record lands in, handles
 * versions, and emits `state.changed` after every write. The agent tool, the
 * HTTP API and plugins all come through here, so those rules hold the same
 * way for every caller and every provider.
 */
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import { cosine, type EmbeddingProvider } from "../providers/embedding.js";
import type { Disposer } from "../registry.js";
import "./builtin.js";
import { stateProviderRegistry, stateTypeRegistry } from "./registry.js";
import { embedQuery, hashText, StateSearchIndex, searchText, wordScores } from "./search.js";
import {
  type Actor,
  type HistoryOptions,
  type Source,
  type StateChange,
  StateConflictError,
  StateError,
  type StateProvider,
  type StateQuery,
  type StateRecord,
  type StateRef,
  type StateTypeDef,
  type StateWriteResult,
} from "./types.js";
import { validateAgainstSchema } from "./validate.js";

export interface StateConfig {
  backend?: string;
  options?: Record<string, unknown>;
  types?: StateTypeDef[];
}

/** Who is asking, and from where. Rooms and project decide which scopes an agent sees. */
export interface StateCaller {
  actor: Actor;
  source?: Source;
  /** Rooms the caller is talking in, as formatted refs (`discord:123`). */
  rooms?: string[];
  projectId?: string | null;
}

export interface StateTypeView {
  def: StateTypeDef;
  canWrite: boolean;
}

export interface StateServiceOptions {
  /** Read on every call, so a config reload changes types without a restart. */
  getConfig: () => { state?: StateConfig };
  db?: Database.Database;
  events?: EventBus;
  now?: () => Date;
  /**
   * The embedder searches match meaning with, read on every use so a reload
   * that changes it is picked up. Without it, or without `db` to keep vectors
   * in, search matches words only.
   */
  getEmbedder?: () => EmbeddingProvider | undefined;
}

export interface StatePutInput {
  type: string;
  /** Omit to create a record with a generated id. */
  id?: string;
  scope?: string;
  data: Record<string, unknown>;
}

/** `includeArchived` brings back archived records, which a query otherwise leaves out. */
export type StateQueryInput = Omit<StateQuery, "scopes"> & {
  /** Narrow to one scope. Omitted means every scope the caller can see. */
  scope?: string;
};

export interface StateSearchInput {
  /** What to look for, in a few words or a sentence. */
  text: string;
  /** Only these types. Omitted means every searchable type the caller can read. */
  types?: string[];
  /** Narrow to one scope. Omitted means every scope the caller can see. */
  scope?: string;
  /** Most hits returned. Default 8. */
  limit?: number;
  /** Archived records too, which a search otherwise leaves out. */
  includeArchived?: boolean;
}

export interface StateSearchHit {
  record: StateRecord;
  /**
   * Closer to 1 is a better match. For `meaning`, the cosine similarity of the
   * record's vector to the query's; for `words`, the share of the query's
   * words the record contains, rarer words counting for more. The two are
   * ranked together but come from different measures, so a caller that wants
   * a cut-off should set it for each.
   */
  score: number;
  /** `meaning` when the record had a current vector and an embedder answered; `words` otherwise. */
  how: "meaning" | "words";
}

/** An id a person can read back to an agent: letters, digits, and `_ . : -`. */
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A search's default number of hits: a handful, because each one lands in an agent's prompt. */
const SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 50;
/**
 * Most records of one type a search reads, newest first. Every search reads a
 * type's records and scores them in process (a cosine per vector, a word
 * overlap for the rest), which stays quick for a few thousand records per
 * type. Past this the oldest are left out, and a warning says so once.
 */
const SEARCH_SCAN = 5_000;
/** Records asked for per page while reading a type for search. */
const SCAN_PAGE = 500;

export class StateService {
  private readonly providers = new Map<string, Promise<StateProvider>>();
  private readonly watchers: Disposer[] = [];
  private readonly now: () => Date;
  /** Stores already warned about for returning archived records to a query that didn't ask. */
  private readonly warnedArchived = new Set<string>();
  /** Types already warned about for having more records than a search reads. */
  private readonly warnedScan = new Set<string>();
  /** Vectors for meaning search. Absent without a database to keep them in or an embedder to make them. */
  private readonly index: StateSearchIndex | undefined;

  constructor(private readonly opts: StateServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    const getEmbedder = opts.getEmbedder;
    if (opts.db && getEmbedder) {
      try {
        this.index = new StateSearchIndex({ db: opts.db, getEmbedder });
      } catch (err) {
        console.warn(
          `[state] search will match words only: the search index failed to open: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Every type, from plugins and config. Config wins on a name clash. */
  types(): StateTypeDef[] {
    const byName = new Map<string, StateTypeDef>();
    for (const name of stateTypeRegistry.list()) {
      const def = stateTypeRegistry.get(name);
      if (def) byName.set(name, def);
    }
    for (const def of this.config().types ?? []) byName.set(def.name, def);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getType(name: string): StateTypeDef | undefined {
    return this.types().find((t) => t.name === name);
  }

  /** The types this caller can read, and whether it can also write each one. */
  listTypes(caller: StateCaller): StateTypeView[] {
    return this.types()
      .filter((def) => allowed(def, caller, "read"))
      .map((def) => ({ def, canWrite: allowed(def, caller, "write") }));
  }

  /** Scopes the caller can see, narrowest first. Undefined means all of them. */
  visibleScopes(caller: StateCaller): string[] | undefined {
    // A person through the UI or API, a plugin, or the system sees everything.
    // Scopes keep agents out of each other's state, not people out of theirs.
    if (caller.actor.kind !== "agent") return undefined;
    const scopes = (caller.rooms ?? []).map((ref) => `room:${ref}`);
    scopes.push(`agent:${caller.actor.name}`);
    if (caller.projectId) scopes.push(`project:${caller.projectId}`);
    scopes.push("global");
    return scopes;
  }

  /** One record by id. An archived record is returned too, with `archivedAt` saying so. */
  async get(caller: StateCaller, ref: StateRef): Promise<StateRecord | null> {
    const def = this.requireType(caller, ref.type, "read");
    const record = await (await this.providerFor(def)).get(ref);
    // An invisible record reads as absent: saying it exists elsewhere would
    // leak what another agent's private scope holds.
    return record && this.canSee(caller, record.scope) ? record : null;
  }

  async query(caller: StateCaller, input: StateQueryInput): Promise<StateRecord[]> {
    const def = this.requireType(caller, input.type, "read");
    const scopes = this.scopesFor(caller, input.scope);
    const { scope: _scope, ...rest } = input;
    const provider = await this.providerFor(def);
    const records = await provider.query({ ...rest, scopes });
    if (input.includeArchived) return records;
    // A store that archives but ignores the flag still never puts an archived
    // record in front of a caller that didn't ask: a page comes back short
    // instead. Said once, since a short page reads as the end of the list.
    const live = records.filter((r) => !r.archivedAt);
    if (live.length < records.length && !this.warnedArchived.has(provider.id)) {
      this.warnedArchived.add(provider.id);
      console.warn(
        `[state] the "${provider.id}" store returned archived ${def.name} records to a query that didn't ask; pages will come back short`,
      );
    }
    return live;
  }

  /**
   * Records whose searchable fields match `text`, best first, from the types
   * that opt in with `search`. Who sees what is exactly as for `query`: only
   * types the caller can read, only scopes it can see, and archived records
   * only when asked for.
   *
   * A record is matched by meaning when an embedder is configured and the
   * record has a vector made from its current text, and by words otherwise,
   * so a record written a moment ago is still found while it waits to be
   * embedded. A search that finds records without a current vector queues
   * them, so the next one can match them by meaning.
   */
  async search(caller: StateCaller, input: StateSearchInput): Promise<StateSearchHit[]> {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new StateError("Say what to look for with `text`.");
    const defs = this.searchableTypes(caller, input.types);
    const scopes = this.scopesFor(caller, input.scope);
    const asked = Number.isFinite(input.limit) ? Math.floor(input.limit as number) : SEARCH_LIMIT;
    const limit = Math.min(Math.max(1, asked), MAX_SEARCH_LIMIT);
    const includeArchived = input.includeArchived === true;

    const index = this.index;
    const embedder = defs.length ? index?.embedder() : undefined;
    const query = embedder ? await embedQuery(embedder, text) : undefined;
    const model = index && embedder && query ? index.modelKey(embedder) : undefined;

    const hits: StateSearchHit[] = [];
    for (const def of defs) {
      const fields = def.search?.fields ?? [];
      const records = await this.scan(def, scopes, includeArchived);
      const texts = records.map((r) => searchText(fields, r.data));
      const vectors = index && model ? index.vectors(def.name, model, scopes) : undefined;
      const byWords: number[] = [];
      for (const [i, record] of records.entries()) {
        if (!texts[i]) continue;
        const hash = hashText(texts[i]);
        const indexed = vectors?.get(record.id);
        if (query && indexed && indexed.hash === hash) {
          const score = cosine(query, indexed.vector);
          if (score > 0) hits.push({ record, score, how: "meaning" });
          continue;
        }
        byWords.push(i);
        if (index && model) {
          index.queue({ type: def.name, id: record.id, scope: record.scope, text: texts[i], hash }, model);
        }
      }
      if (byWords.length === 0) continue;
      const scores = wordScores(text, texts);
      for (const i of byWords) if (scores[i] > 0) hits.push({ record: records[i], score: scores[i], how: "words" });
    }
    hits.sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
    return hits.slice(0, limit);
  }

  /**
   * Bring the search index up to date with every searchable record: queue the
   * ones with no vector for their current text (all of them, after the
   * embedder's model changes), fix scopes that drifted, and drop entries for
   * records that are gone. Run at start and after a reload. Resolves with how
   * many records were queued; the embedding itself runs in the background,
   * paced, and never holds up a write or a search. Does nothing without an
   * embedder.
   */
  async backfillSearch(): Promise<number> {
    const index = this.index;
    const embedder = index?.embedder();
    if (!index || !embedder) return 0;
    const model = index.modelKey(embedder);
    let queued = 0;
    for (const def of this.types()) {
      const fields = def.search?.fields;
      if (!fields?.length) continue;
      try {
        const records = await this.scan(def, undefined, true);
        const vectors = index.vectors(def.name, model);
        for (const record of records) {
          const text = searchText(fields, record.data);
          if (!text) continue;
          const hash = hashText(text);
          const indexed = vectors.get(record.id);
          if (indexed && indexed.hash === hash) {
            if (indexed.scope !== record.scope) index.moved(record, record.scope);
            continue;
          }
          if (index.queue({ type: def.name, id: record.id, scope: record.scope, text, hash }, model)) queued++;
        }
        // Only a scan that saw every record can say which entries are orphaned.
        if (records.length < SEARCH_SCAN) index.prune(def.name, new Set(records.map((r) => r.id)));
      } catch (err) {
        console.warn(`[state] could not index ${def.name} records for search: ${(err as Error).message}`);
      }
    }
    return queued;
  }

  /**
   * Resolves once every write so far is embedded, or given up on. For tests,
   * and for a caller that needs a record findable by meaning before it goes on.
   */
  whenIndexed(): Promise<void> {
    return this.index?.whenIdle() ?? Promise.resolve();
  }

  /**
   * Create a record, or replace one by id. Without an id this always creates;
   * with one it creates or replaces, conditional on `expectedVersion` when given.
   */
  async put(caller: StateCaller, input: StatePutInput, expectedVersion?: number): Promise<StateRecord> {
    const def = this.requireType(caller, input.type, "write");
    const data = this.checkData(def, input.data, input.id);
    const provider = await this.providerFor(def);

    if (input.id !== undefined) {
      const id = checkId(input.id);
      const existing = await provider.get({ type: def.name, id });
      if (existing && !this.canSee(caller, existing.scope)) {
        throw new StateError(`${def.name}/${id} already exists in a scope you cannot see. Use a different id.`);
      }
      const scope = input.scope ?? existing?.scope ?? this.defaultScope(caller, def);
      this.checkWritableScope(caller, scope);
      return this.write(provider, caller, { type: def.name, id, scope, data }, expectedVersion);
    }

    const scope = input.scope ?? this.defaultScope(caller, def);
    this.checkWritableScope(caller, scope);
    // A generated id must never land on an existing record, so the write is
    // conditional on there being nothing there. A collision draws again.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.write(provider, caller, { type: def.name, id: newId(def, data), scope, data }, 0);
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 2) throw err;
      }
    }
  }

  /**
   * Change some fields of an existing record. Top-level merge: a field set to
   * `null` is removed. Without `expectedVersion` a concurrent write is
   * retried once against the fresh record, which is safe because a patch
   * names exactly the fields it changes. An archived record is refused: a
   * patch edits the record as it stands, and bringing it back is `unarchive`'s
   * to say.
   */
  async patch(
    caller: StateCaller,
    ref: StateRef,
    changes: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<StateRecord> {
    const def = this.requireType(caller, ref.type, "write");
    if (!isPlainObject(changes)) throw new StateError("The changes must be an object of field names to new values.");
    const provider = await this.providerFor(def);
    for (let attempt = 0; ; attempt++) {
      const existing = await provider.get(ref);
      if (!existing || !this.canSee(caller, existing.scope)) throw new StateError(noRecord(ref));
      if (existing.archivedAt) {
        throw new StateError(`${ref.type}/${ref.id} is archived. Unarchive it before changing it.`);
      }
      const data = this.checkData(def, mergePatch(existing.data, changes), ref.id);
      try {
        return await this.write(
          provider,
          caller,
          { type: def.name, id: ref.id, scope: existing.scope, data },
          expectedVersion ?? existing.version,
        );
      } catch (err) {
        if (!(err instanceof StateConflictError) || expectedVersion !== undefined || attempt >= 1) throw err;
      }
    }
  }

  /**
   * Delete a record, keeping the removal in its history. Null when there was
   * nothing to delete. `expectedVersion` deletes it only if it is still at
   * that version, as `put` writes: otherwise {@link StateConflictError}, so
   * whoever changed it meanwhile doesn't lose their change.
   */
  async delete(caller: StateCaller, ref: StateRef, expectedVersion?: number): Promise<StateRecord | null> {
    const def = this.requireType(caller, ref.type, "write");
    const provider = await this.providerFor(def);
    if (!provider.delete) throw new StateError(`The "${provider.id}" store cannot delete ${def.name} records.`);
    const existing = await provider.get(ref);
    if (!existing || !this.canSee(caller, existing.scope)) return null;
    if (expectedVersion !== undefined && expectedVersion !== existing.version)
      throw new StateConflictError(ref, expectedVersion, existing.version);
    const removed = await provider.delete(ref, caller.actor, caller.source, expectedVersion);
    if (removed) {
      this.emit({
        type: removed.type,
        id: removed.id,
        scope: removed.scope,
        op: "delete",
        before: removed.data,
        version: removed.version + 1,
        actor: caller.actor,
        source: caller.source,
        at: this.now().toISOString(),
      });
    }
    return removed;
  }

  /**
   * Archive a record: kept, with its data and history, but left out of
   * queries — and so of pinned state, lists and the world — until it is
   * unarchived. Null when there is no such record the caller can see. Already
   * archived, it is returned as it is. Announced as an `update` with
   * `lifecycle: "archived"`, so consumers that predate archiving keep working.
   */
  async archive(
    caller: StateCaller,
    ref: StateRef,
    reason?: string,
    expectedVersion?: number,
  ): Promise<StateRecord | null> {
    return this.setArchived(caller, ref, true, reason, expectedVersion);
  }

  /** Bring an archived record back. Null when there is none the caller can see; a live record is returned as it is. */
  async unarchive(caller: StateCaller, ref: StateRef, expectedVersion?: number): Promise<StateRecord | null> {
    return this.setArchived(caller, ref, false, undefined, expectedVersion);
  }

  async history(caller: StateCaller, ref: StateRef, opts?: HistoryOptions): Promise<StateChange[]> {
    const def = this.requireType(caller, ref.type, "read");
    const provider = await this.providerFor(def);
    if (!provider.history) throw new StateError(`The "${provider.id}" store keeps no history for ${def.name} records.`);
    const changes = await provider.history(ref, opts);
    // The latest entry's scope is where the record lives, or lived.
    return changes.length && this.canSee(caller, changes[0].scope) ? changes : [];
  }

  /** Erase a record and its history. Never available to an agent: an agent deletes, and history survives. */
  async purge(caller: StateCaller, ref: StateRef): Promise<boolean> {
    if (caller.actor.kind === "agent") {
      throw new StateError("Only a person or the system can erase a record outright. Delete it instead.");
    }
    const def = this.requireType(caller, ref.type, "write");
    const provider = await this.providerFor(def);
    if (!provider.purge) throw new StateError(`The "${provider.id}" store cannot erase records.`);
    const erased = await provider.purge(ref);
    // A purge announces nothing, so the index is told here.
    if (erased) this.unindex(ref);
    return erased;
  }

  async close(): Promise<void> {
    // The index first, so no vector is written after the stores close.
    await this.index?.close();
    for (const dispose of this.watchers.splice(0)) dispose();
    const providers = [...this.providers.values()];
    this.providers.clear();
    for (const p of providers) {
      try {
        await (await p).close?.();
      } catch {
        // A provider that failed to build or to close has nothing left to release.
      }
    }
  }

  private async setArchived(
    caller: StateCaller,
    ref: StateRef,
    archive: boolean,
    reason: string | undefined,
    expectedVersion: number | undefined,
  ): Promise<StateRecord | null> {
    const def = this.requireType(caller, ref.type, "write");
    const provider = await this.providerFor(def);
    // Refused outright rather than reported as done: a store that can't
    // archive would otherwise leave the record live in every query.
    if (!provider.archive || !provider.unarchive) {
      throw new StateError(
        `The "${provider.id}" store cannot archive ${def.name} records, so ${def.name}/${ref.id} is unchanged.`,
      );
    }
    const existing = await provider.get(ref);
    if (!existing || !this.canSee(caller, existing.scope)) return null;
    if (expectedVersion !== undefined && expectedVersion !== existing.version)
      throw new StateConflictError(ref, expectedVersion, existing.version);
    if (!!existing.archivedAt === archive) return existing;
    const why = reason?.trim() || undefined;
    const result = archive
      ? await provider.archive(ref, caller.actor, why, caller.source, expectedVersion)
      : await provider.unarchive(ref, caller.actor, caller.source, expectedVersion);
    if (!result) return null;
    if (!!result.record.archivedAt !== archive) {
      // The store said it did it and didn't. Better a loud failure than a
      // record everyone believes is archived turning up in every query.
      throw new Error(
        `The "${provider.id}" store reported ${def.name}/${ref.id} ${archive ? "archived" : "unarchived"}, but it is not.`,
      );
    }
    this.emit({
      type: result.record.type,
      id: result.record.id,
      scope: result.record.scope,
      op: "update",
      before: result.previous?.data ?? result.record.data,
      after: result.record.data,
      version: result.record.version,
      actor: caller.actor,
      ...(caller.source ? { source: caller.source } : {}),
      at: result.record.updatedAt,
      lifecycle: archive ? "archived" : "unarchived",
      ...(archive && result.record.archiveReason ? { archiveReason: result.record.archiveReason } : {}),
    });
    return result.record;
  }

  private config(): StateConfig {
    return this.opts.getConfig().state ?? {};
  }

  /** The scopes a read covers: what the caller can see, or the one scope it named, if it can see that. */
  private scopesFor(caller: StateCaller, scope: string | undefined): string[] | undefined {
    const visible = this.visibleScopes(caller);
    if (!scope) return visible;
    if (visible && !visible.includes(scope)) throw new StateError(cannotSee(scope, visible));
    return [scope];
  }

  /**
   * The types a search covers. Named types must be readable and searchable,
   * and saying so beats returning nothing, which reads as "no match".
   */
  private searchableTypes(caller: StateCaller, names: string[] | undefined): StateTypeDef[] {
    const readable = () =>
      this.listTypes(caller)
        .map((v) => v.def)
        .filter(isSearchable);
    const wanted = [...new Set((names ?? []).map((n) => n.trim()).filter(Boolean))];
    if (wanted.length === 0) return readable();
    return wanted.map((name) => {
      const def = this.requireType(caller, name, "read");
      if (isSearchable(def)) return def;
      const searchable = readable().map((d) => d.name);
      throw new StateError(
        `${name} records are not searchable.` +
          (searchable.length ? ` Searchable types: ${searchable.join(", ")}.` : " No type you can read is searchable."),
      );
    });
  }

  /**
   * A type's records, newest first, up to {@link SEARCH_SCAN}. Read in pages
   * until one comes back empty, so a store that caps its pages lower than we
   * ask still gets read to the end; a page with nothing new ends it too, for a
   * store that ignores `offset`.
   */
  private async scan(
    def: StateTypeDef,
    scopes: string[] | undefined,
    includeArchived: boolean,
  ): Promise<StateRecord[]> {
    const provider = await this.providerFor(def);
    const seen = new Map<string, StateRecord>();
    for (let offset = 0; seen.size < SEARCH_SCAN; ) {
      const page = await provider.query({
        type: def.name,
        scopes,
        includeArchived,
        orderBy: { field: "updatedAt", direction: "desc" },
        limit: SCAN_PAGE,
        offset,
      });
      let fresh = 0;
      for (const record of page) {
        if (seen.has(record.id)) continue;
        seen.set(record.id, record);
        fresh++;
      }
      if (page.length === 0 || fresh === 0) break;
      offset += page.length;
    }
    if (seen.size >= SEARCH_SCAN && !this.warnedScan.has(def.name)) {
      this.warnedScan.add(def.name);
      console.warn(
        `[state] ${def.name} has more than ${SEARCH_SCAN} records; search reads the ${SEARCH_SCAN} most recently updated and leaves older ones out`,
      );
    }
    const records = [...seen.values()].slice(0, SEARCH_SCAN);
    // As for `query`: an archived record never reaches a caller that didn't ask.
    return includeArchived ? records : records.filter((r) => !r.archivedAt);
  }

  private requireType(caller: StateCaller, name: string, mode: "read" | "write"): StateTypeDef {
    const def = this.getType(name);
    // A type the caller cannot read is reported exactly like one that does not
    // exist, so the error does not reveal what other agents keep.
    if (!def || !allowed(def, caller, "read")) {
      const known = this.listTypes(caller).map((t) => t.def.name);
      throw new StateError(
        `There is no state type called "${name}".` +
          (known.length ? ` Types you can use: ${known.join(", ")}.` : " There are no types you can use."),
      );
    }
    if (mode === "write" && !allowed(def, caller, "write")) {
      throw new StateError(`You can read ${name} records but not change them.`);
    }
    return def;
  }

  private checkData(def: StateTypeDef, data: unknown, id: string | undefined): Record<string, unknown> {
    if (!isPlainObject(data)) throw new StateError("The data must be an object of field names to values.");
    const errors = validateAgainstSchema(def.schema, data);
    if (errors.length) {
      const what = id ? `${def.name}/${id}` : `The ${def.name}`;
      throw new StateError(`${what} was not saved:\n${errors.map((e) => `- ${e}`).join("\n")}`);
    }
    return data;
  }

  private canSee(caller: StateCaller, scope: string): boolean {
    const visible = this.visibleScopes(caller);
    return !visible || visible.includes(scope);
  }

  private checkWritableScope(caller: StateCaller, scope: string): void {
    if (!scope.trim()) throw new StateError("A scope cannot be empty.");
    const visible = this.visibleScopes(caller);
    if (visible && !visible.includes(scope)) throw new StateError(cannotSee(scope, visible));
  }

  private defaultScope(caller: StateCaller, def: StateTypeDef): string {
    switch (def.scope ?? "global") {
      case "agent":
        if (caller.actor.kind !== "agent") {
          throw new StateError(`${def.name} records belong to an agent. Say which with scope "agent:<name>".`);
        }
        return `agent:${caller.actor.name}`;
      case "room": {
        const rooms = caller.rooms ?? [];
        if (rooms.length === 1) return `room:${rooms[0]}`;
        throw new StateError(
          rooms.length === 0
            ? `${def.name} records belong to a room, and this is not a room conversation. Pass scope "room:<ref>" or "global".`
            : `${def.name} records belong to a room, and this turn spans several (${rooms.join(", ")}). Pass scope to say which.`,
        );
      }
      case "project":
        if (caller.projectId) return `project:${caller.projectId}`;
        throw new StateError(
          `${def.name} records belong to a project, and there is none here. Pass scope "project:<id>" or "global".`,
        );
      default:
        return "global";
    }
  }

  private async write(
    provider: StateProvider,
    caller: StateCaller,
    target: { type: string; id: string; scope: string; data: Record<string, unknown> },
    expectedVersion: number | undefined,
  ): Promise<StateRecord> {
    const result: StateWriteResult = await provider.put(
      { ...target, actor: caller.actor, ...(caller.source ? { source: caller.source } : {}) },
      expectedVersion,
    );
    if (result.record.archivedAt) {
      // A put writes the record live. One the store kept archived would be
      // reported saved while every query and pinned prompt leaves it out.
      throw new Error(
        `The "${provider.id}" store kept ${target.type}/${target.id} archived after a put, which must write it live.`,
      );
    }
    this.emit({
      type: result.record.type,
      id: result.record.id,
      scope: result.record.scope,
      op: result.previous ? "update" : "create",
      ...(result.previous ? { before: result.previous.data } : {}),
      after: result.record.data,
      version: result.record.version,
      actor: caller.actor,
      ...(caller.source ? { source: caller.source } : {}),
      at: result.record.updatedAt,
      // A put over an archived record brings it back, and says so.
      ...(result.previous?.archivedAt && !result.record.archivedAt ? { lifecycle: "unarchived" as const } : {}),
    });
    return result.record;
  }

  private emit(change: StateChange): void {
    // The index follows changes here, where they are announced, rather than
    // through a bus subscription: every reload clears the bus, and a write
    // made before anything re-subscribed would leave a stale vector behind.
    this.indexChange(change);
    try {
      this.opts.events?.emit("state.changed", change);
    } catch (err) {
      // The write has already happened. A subscriber that throws must not make
      // it look as though it did not.
      console.warn(`[state] a state.changed subscriber threw: ${(err as Error).message}`);
    }
  }

  /** Keep the search index in step with one change. Never throws: the write it follows has already happened. */
  private indexChange(change: StateChange): void {
    if (!this.index) return;
    const ref = { type: change.type, id: change.id };
    try {
      if (change.op === "delete") {
        this.index.removed(ref);
        return;
      }
      const fields = this.getType(change.type)?.search?.fields;
      if (!fields?.length) return;
      this.index.changed(ref, change.scope, searchText(fields, change.after ?? {}));
    } catch (err) {
      console.warn(`[state] the search index missed ${change.type}/${change.id}: ${(err as Error).message}`);
    }
  }

  private unindex(ref: StateRef): void {
    try {
      this.index?.removed(ref);
    } catch (err) {
      console.warn(
        `[state] the search index kept ${ref.type}/${ref.id} after it was erased: ${(err as Error).message}`,
      );
    }
  }

  private providerFor(def: StateTypeDef): Promise<StateProvider> {
    const cfg = this.config();
    const id = def.provider ?? cfg.backend;
    if (!id) return Promise.reject(new Error("state.backend is not set, so there is nowhere to keep state."));
    const options = def.provider ? (def.providerOptions ?? {}) : (cfg.options ?? {});
    const key = `${id}\u0000${JSON.stringify(options)}`;
    const cached = this.providers.get(key);
    if (cached) return cached;

    const factory = stateProviderRegistry.get(id);
    if (!factory) {
      const known = stateProviderRegistry.list().join(", ") || "none";
      return Promise.reject(new Error(`No state provider is registered as "${id}". Registered: ${known}.`));
    }
    const built = Promise.resolve()
      .then(() => factory({ db: this.opts.db, options, now: this.now }))
      .then((provider) => {
        if (provider.watch) this.watchers.push(provider.watch((change) => this.emit(change)));
        return provider;
      });
    // A provider that failed to build is not cached, so the next call retries
    // rather than repeating a stale failure forever.
    built.catch(() => this.providers.delete(key));
    this.providers.set(key, built);
    return built;
  }
}

function isSearchable(def: StateTypeDef): boolean {
  return (def.search?.fields?.length ?? 0) > 0;
}

function allowed(def: StateTypeDef, caller: StateCaller, mode: "read" | "write"): boolean {
  if (caller.actor.kind === "plugin" || caller.actor.kind === "system") return true;
  const list = def.access?.[mode];
  if (!list) return true;
  if (caller.actor.kind === "user") return list.includes("user");
  return list.includes("*") || list.includes(caller.actor.name);
}

function checkId(id: string): string {
  if (!RECORD_ID.test(id)) {
    throw new StateError(
      `"${id}" is not a usable id. Use letters, digits and _ . : - (up to 128 characters, starting with a letter or digit).`,
    );
  }
  return id;
}

/** Readable when the type names a title field: `trip-to-lisbon-3f9a`. Otherwise eight hex characters. */
function newId(def: StateTypeDef, data: Record<string, unknown>): string {
  const suffix = randomBytes(2).toString("hex");
  const title = def.title ? data[def.title] : undefined;
  if (typeof title === "string") {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");
    if (slug) return `${slug}-${suffix}`;
  }
  return randomBytes(4).toString("hex");
}

function mergePatch(base: Record<string, unknown>, changes: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noRecord(ref: StateRef): string {
  return `There is no ${ref.type} record with id "${ref.id}".`;
}

function cannotSee(scope: string, visible: string[]): string {
  return `You cannot use scope "${scope}". Scopes you can use: ${visible.join(", ")}.`;
}
