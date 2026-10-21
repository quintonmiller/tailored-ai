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
import type { Disposer } from "../registry.js";
import "./builtin.js";
import { stateProviderRegistry, stateTypeRegistry } from "./registry.js";
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

/** An id a person can read back to an agent: letters, digits, and `_ . : -`. */
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export class StateService {
  private readonly providers = new Map<string, Promise<StateProvider>>();
  private readonly watchers: Disposer[] = [];
  private readonly now: () => Date;

  constructor(private readonly opts: StateServiceOptions) {
    this.now = opts.now ?? (() => new Date());
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
    const visible = this.visibleScopes(caller);
    let scopes = visible;
    if (input.scope) {
      if (visible && !visible.includes(input.scope)) throw new StateError(cannotSee(input.scope, visible));
      scopes = [input.scope];
    }
    const { scope: _scope, ...rest } = input;
    const records = await (await this.providerFor(def)).query({ ...rest, scopes });
    // A store that archives but ignores the flag still never puts an archived
    // record in front of a caller that didn't ask: a page comes back short
    // instead.
    return input.includeArchived ? records : records.filter((r) => !r.archivedAt);
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
    return provider.purge(ref);
  }

  async close(): Promise<void> {
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
      throw new StateError(`The "${provider.id}" store cannot archive ${def.name} records. Delete it instead.`);
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
    try {
      this.opts.events?.emit("state.changed", change);
    } catch (err) {
      // The write has already happened. A subscriber that throws must not make
      // it look as though it did not.
      console.warn(`[state] a state.changed subscriber threw: ${(err as Error).message}`);
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
