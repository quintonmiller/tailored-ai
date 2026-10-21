/**
 * World state: the structured, typed, observable layer agents share.
 *
 * See `docs/world-state-design.md`. In short: a record is typed data with a
 * scope and a version; every write records who made it and through what; a
 * provider stores records and core does everything around storage —
 * validation, access, events — so any provider gets those for free.
 */
import type { Disposer } from "../registry.js";

/** Who made a change. */
export interface Actor {
  kind: "agent" | "user" | "plugin" | "system";
  name: string;
}

/**
 * Through what a change was made. Recorded beside the actor from the first
 * version because a later layer needs to tell a value the user typed from one
 * an agent copied out of a web page, and that cannot be recovered afterwards
 * from data that never wrote it down.
 */
export interface Source {
  tool?: string;
  surface?: string;
  interfaceId?: string;
  /**
   * The agent a plugin or the system wrote for, when the write was that
   * agent's doing but went through a caller with more reach than the agent
   * has. The actor stays the plugin, so access is the plugin's; this says
   * whose change it was, so a subscription doesn't wake an agent for its own
   * change and a line describing it can name the agent. A provider stores it
   * with the rest of the source; one that drops it loses only that.
   */
  onBehalfOf?: string;
}

export interface StateRef {
  type: string;
  id: string;
}

export interface StateRecord {
  type: string;
  id: string;
  /**
   * Memory's scope tokens: `global`, `agent:<name>`, `project:<id>`, plus
   * `room:<ref>`. One token per record.
   */
  scope: string;
  data: Record<string, unknown>;
  /** Starts at 1 and goes up by one on every write, including a delete. */
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: Actor;
  source?: Source;
  /**
   * Set while the record is archived: kept, with its data and history, but
   * left out of queries unless they ask for it. Belongs to the record, not its
   * data, so a type's schema never sees it. Absent means live.
   */
  archivedAt?: string;
  archivedBy?: Actor;
  archiveReason?: string;
}

/**
 * A condition on one data field. A bare value means equality (`null` matches
 * a missing field too); an object combines comparisons, all of which must hold.
 */
export type FieldCondition =
  | string
  | number
  | boolean
  | null
  | {
      in?: (string | number | boolean | null)[];
      ne?: string | number | boolean | null;
      gt?: string | number;
      gte?: string | number;
      lt?: string | number;
      lte?: string | number;
    };

export interface StateQuery {
  type: string;
  /** Only records in one of these scopes. Undefined means every scope. */
  scopes?: string[];
  /** Field path (`status`, `owner.name`) to condition. Every entry must hold. */
  where?: Record<string, FieldCondition>;
  /** `updatedAt`, `createdAt`, `id`, or a data field path. Default `updatedAt` descending. */
  orderBy?: { field: string; direction?: "asc" | "desc" };
  limit?: number;
  offset?: number;
  /** Archived records too. Left out by default, because a query loads what is current. */
  includeArchived?: boolean;
}

export interface StateWrite {
  type: string;
  id: string;
  scope: string;
  data: Record<string, unknown>;
  actor: Actor;
  source?: Source;
}

export type StateOp = "create" | "update" | "delete";

/** One entry in a record's history, and the payload of `state.changed`. */
export interface StateChange {
  type: string;
  id: string;
  scope: string;
  op: StateOp;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  version: number;
  actor: Actor;
  source?: Source;
  at: string;
  /**
   * Set on the update that archived the record or brought it back. The op
   * stays `update`, so a consumer written before archiving existed keeps
   * working; one that cares reads this. An archive changes no data, so its
   * `before` and `after` are the same.
   */
  lifecycle?: "archived" | "unarchived";
  /** Why it was archived, on an `archived` change, when the archiver said. */
  archiveReason?: string;
}

export interface HistoryOptions {
  limit?: number;
}

/** What a provider hands back from a write, so core can describe the change. */
export interface StateWriteResult {
  record: StateRecord;
  /** The live record this write replaced. Absent for a create (including re-creating a deleted one). */
  previous?: StateRecord;
}

/**
 * Storage for records. Verb-shaped on purpose, following the memory registry:
 * a backend should not have to speak TAI's vocabulary to plug in.
 *
 * A provider stores and retrieves. Validation, access checks, scope rules and
 * change events all happen in core before or after these calls, so a provider
 * written against this contract gets them without implementing any.
 */
export interface StateProvider {
  readonly id: string;
  /** A live record, or null when absent or deleted. An archived record is returned, with its archive fields. */
  get(ref: StateRef): Promise<StateRecord | null>;
  /** Live records only, and archived ones only when `includeArchived` is set. */
  query(q: StateQuery): Promise<StateRecord[]>;
  /**
   * Create or replace. `expectedVersion` makes the write conditional: `0`
   * means the record must not exist yet, any other number means the live
   * record must be at exactly that version. A mismatch throws
   * {@link StateConflictError}. Undefined writes unconditionally.
   *
   * A put writes the whole record, and the record it writes is not archived:
   * one over an archived record brings it back, as one over a deleted record
   * creates it again, and its history entry says `lifecycle: "unarchived"`.
   */
  put(write: StateWrite, expectedVersion?: number): Promise<StateWriteResult>;
  /**
   * Remove a live record, keeping the removal in its history. Returns the
   * record as it stood, or null if there was nothing to delete.
   * `expectedVersion` makes it conditional, as for `put`: the live record
   * must be at exactly that version, or {@link StateConflictError} is thrown.
   * Core checks it too, so a provider that ignores it is still guarded, if
   * less tightly.
   */
  delete?(ref: StateRef, actor: Actor, source?: Source, expectedVersion?: number): Promise<StateRecord | null>;
  /**
   * Archive a live record: it keeps its data and history, `get` still returns
   * it with `archivedAt`, `archivedBy` and `archiveReason` set, and `query`
   * leaves it out unless asked. A write like any other: the version goes up by
   * one, `updatedAt`/`updatedBy` change, and history logs an `update` with
   * `lifecycle: "archived"`. Returns what was written, or null when there is
   * no live record. `expectedVersion` as for `delete`.
   *
   * Optional, with `unarchive`. Core refuses to archive in a store that lacks
   * either, rather than report success and leave the record live; a store
   * without them keeps every other part of this contract as it was.
   */
  archive?(
    ref: StateRef,
    actor: Actor,
    reason?: string,
    source?: Source,
    expectedVersion?: number,
  ): Promise<StateWriteResult | null>;
  /** Bring an archived record back, the same kind of write as `archive`, logged with `lifecycle: "unarchived"`. */
  unarchive?(ref: StateRef, actor: Actor, source?: Source, expectedVersion?: number): Promise<StateWriteResult | null>;
  /** Most recent first. */
  history?(ref: StateRef, opts?: HistoryOptions): Promise<StateChange[]>;
  /** Erase a record and its history outright. An admin action, never the default delete. */
  purge?(ref: StateRef): Promise<boolean>;
  /** For data that changes outside TAI. Core re-emits what this reports as `state.changed`. */
  watch?(emit: (change: StateChange) => void): Disposer;
  close?(): Promise<void>;
}

/** The subset of JSON Schema core validates. Other keywords are reported, not trusted. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  description?: string;
  title?: string;
  default?: unknown;
  [keyword: string]: unknown;
}

export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

/**
 * Where a new record of a type lands when the writer does not name a scope:
 * the room it is talking in, its own private scope, the current project, or
 * shared by everyone.
 */
export type StateScopeKind = "global" | "room" | "agent" | "project";

/**
 * A query pinned to an agent's prompt: the records it matches render behind
 * the history every turn, so the agent sees what is true now without asking.
 */
export interface StateContextQuery {
  type: string;
  /** Field path to condition, as in a `state` tool query. Every entry must hold. */
  where?: Record<string, FieldCondition>;
  /** A field to sort by; a leading `-` sorts descending. Default: most recently updated first. */
  orderBy?: string;
  /** Most records shown. Default 10. */
  limit?: number;
  /** Only this scope. Omitted means every scope the agent can see. */
  scope?: string;
}

export interface StateTypeDef {
  /** Open string, lowercase snake_case. Core keeps no list of known types. */
  name: string;
  /** Shown to agents. Says what a record of this type is for. */
  description?: string;
  /** Validated on every write. Omitted means any object. */
  schema?: JsonSchema;
  scope?: StateScopeKind;
  /** Field used to name a record in a list. */
  title?: string;
  /** A provider for this type only, instead of the store-wide `state.backend`. */
  provider?: string;
  /** Options for that provider. Opaque to core. */
  providerOptions?: Record<string, unknown>;
  /**
   * Agent names, `*` for every agent, and `user` for a person through the UI
   * or HTTP API. Omitted means everyone, agents and people alike.
   */
  access?: { read?: string[]; write?: string[] };
  /**
   * Makes records of this type findable by `StateService.search`. `fields`
   * names the data fields whose text is searched: top-level (`summary`) or
   * dotted (`owner.name`). Strings and numbers are read as text, and an array
   * or object is read through to the strings and numbers inside it. A type
   * without `search` is never indexed or searched.
   */
  search?: { fields: string[] };
}

/** A version mismatch on a conditional write. */
export class StateConflictError extends Error {
  constructor(
    readonly ref: StateRef,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      actual === 0
        ? `${ref.type}/${ref.id} does not exist, but the write expected version ${expected}.`
        : expected === 0
          ? `${ref.type}/${ref.id} already exists (version ${actual}).`
          : `${ref.type}/${ref.id} is at version ${actual}, but the write expected version ${expected}.`,
    );
    this.name = "StateConflictError";
  }
}

/**
 * Anything a caller did wrong: an unknown type, invalid data, a scope it cannot
 * see. The message is written to be handed to an agent as a correction.
 */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}
