/**
 * A state provider that keeps records in the process and nowhere else: for
 * state that is only true while it lasts — what an agent is doing this second,
 * who is looking at a page — where a database row per change would be a log
 * of things nobody will read.
 *
 * Gone on restart, and on a config reload, which builds providers afresh. A
 * record's history is kept, but only its latest changes (`history`, default
 * 50), so a record written every few seconds costs the same memory forever.
 *
 * Queries mean what they mean against SQLite: the same conditions, the same
 * order, missing and `null` alike, booleans equal to 1 and 0.
 */
import {
  type Actor,
  type FieldCondition,
  type HistoryOptions,
  type Source,
  type StateChange,
  StateConflictError,
  StateError,
  type StateProvider,
  type StateQuery,
  type StateRecord,
  type StateRef,
  type StateWrite,
  type StateWriteResult,
} from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_HISTORY = 50;

/** A data field path: `status`, `owner.name`. The same names SQLite accepts. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

interface Slot {
  record: StateRecord;
  deleted: boolean;
  changes: StateChange[];
}

export interface MemoryStateOptions {
  /** Changes kept per record, newest first. */
  history?: number;
}

export class MemoryStateProvider implements StateProvider {
  readonly id = "memory";
  private readonly slots = new Map<string, Slot>();
  private readonly keep: number;

  constructor(
    private readonly now: () => Date = () => new Date(),
    opts: MemoryStateOptions = {},
  ) {
    this.keep = Math.max(1, Math.floor(opts.history ?? DEFAULT_HISTORY));
  }

  async get(ref: StateRef): Promise<StateRecord | null> {
    const slot = this.slots.get(key(ref));
    return slot && !slot.deleted ? structuredClone(slot.record) : null;
  }

  async query(q: StateQuery): Promise<StateRecord[]> {
    const conditions = Object.entries(q.where ?? {}).map(([field, condition]) => {
      const path = fieldPath(field);
      return (data: Record<string, unknown>) => holds(read(data, path), condition, field);
    });
    const sortBy = q.orderBy?.field ?? "updatedAt";
    const sortPath = ["updatedAt", "createdAt", "id"].includes(sortBy) ? undefined : fieldPath(sortBy);
    const direction = q.orderBy?.direction === "asc" ? 1 : -1;
    const sortKey = (r: StateRecord): unknown =>
      sortPath ? read(r.data, sortPath) : r[sortBy as "updatedAt" | "createdAt" | "id"];

    const live = [...this.slots.values()]
      .filter((s) => !s.deleted && s.record.type === q.type)
      .map((s) => s.record)
      .filter((r) => q.includeArchived || !r.archivedAt)
      .filter((r) => !q.scopes || q.scopes.includes(r.scope))
      .filter((r) => conditions.every((test) => test(r.data)));
    // `id` breaks ties, ascending, so a page boundary never shows the same record twice.
    live.sort((a, b) => direction * compare(sortKey(a), sortKey(b)) || compare(a.id, b.id));
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const offset = Math.max(0, Math.floor(q.offset ?? 0));
    return live.slice(offset, offset + limit).map((r) => structuredClone(r));
  }

  async put(write: StateWrite, expectedVersion?: number): Promise<StateWriteResult> {
    const existing = this.slots.get(key(write));
    const live = existing && !existing.deleted ? existing.record : undefined;
    const liveVersion = live?.version ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== liveVersion) {
      throw new StateConflictError(write, expectedVersion, liveVersion);
    }
    const at = this.now().toISOString();
    // A deleted record keeps counting from where it stopped, so a version
    // number is never reused for the same id.
    const version = (existing?.record.version ?? 0) + 1;
    const record: StateRecord = {
      type: write.type,
      id: write.id,
      scope: write.scope,
      data: structuredClone(write.data),
      version,
      createdAt: live ? live.createdAt : at,
      updatedAt: at,
      updatedBy: write.actor,
      ...(write.source ? { source: write.source } : {}),
    };
    const slot: Slot = { record, deleted: false, changes: existing?.changes ?? [] };
    this.slots.set(key(write), slot);
    this.log(slot, {
      type: write.type,
      id: write.id,
      scope: write.scope,
      op: live ? "update" : "create",
      ...(live ? { before: live.data } : {}),
      after: record.data,
      version,
      actor: write.actor,
      ...(write.source ? { source: write.source } : {}),
      at,
      // The record a put writes carries no archive fields, so one over an
      // archived record brings it back.
      ...(live?.archivedAt ? { lifecycle: "unarchived" as const } : {}),
    });
    const copy = structuredClone(record);
    return live ? { record: copy, previous: structuredClone(live) } : { record: copy };
  }

  async delete(ref: StateRef, actor: Actor, source?: Source, expectedVersion?: number): Promise<StateRecord | null> {
    const slot = this.slots.get(key(ref));
    if (!slot || slot.deleted) return null;
    const removed = slot.record;
    if (expectedVersion !== undefined && expectedVersion !== removed.version)
      throw new StateConflictError(ref, expectedVersion, removed.version);
    const at = this.now().toISOString();
    const version = removed.version + 1;
    slot.deleted = true;
    slot.record = { ...removed, version, updatedAt: at, updatedBy: actor, ...(source ? { source } : {}) };
    this.log(slot, {
      type: ref.type,
      id: ref.id,
      scope: removed.scope,
      op: "delete",
      before: removed.data,
      version,
      actor,
      ...(source ? { source } : {}),
      at,
    });
    return structuredClone(removed);
  }

  async archive(
    ref: StateRef,
    actor: Actor,
    reason?: string,
    source?: Source,
    expectedVersion?: number,
  ): Promise<StateWriteResult | null> {
    return this.setArchived(ref, { reason }, actor, source, expectedVersion);
  }

  async unarchive(
    ref: StateRef,
    actor: Actor,
    source?: Source,
    expectedVersion?: number,
  ): Promise<StateWriteResult | null> {
    return this.setArchived(ref, null, actor, source, expectedVersion);
  }

  async history(ref: StateRef, opts: HistoryOptions = {}): Promise<StateChange[]> {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    return structuredClone((this.slots.get(key(ref))?.changes ?? []).slice(0, limit));
  }

  async purge(ref: StateRef): Promise<boolean> {
    return this.slots.delete(key(ref));
  }

  /** Archive (`archive` given) or bring back (null) a live record: a write of its own, data unchanged. */
  private setArchived(
    ref: StateRef,
    archive: { reason?: string } | null,
    actor: Actor,
    source: Source | undefined,
    expectedVersion: number | undefined,
  ): StateWriteResult | null {
    const slot = this.slots.get(key(ref));
    if (!slot || slot.deleted) return null;
    const previous = slot.record;
    if (expectedVersion !== undefined && expectedVersion !== previous.version)
      throw new StateConflictError(ref, expectedVersion, previous.version);
    const at = this.now().toISOString();
    const version = previous.version + 1;
    const reason = archive?.reason || undefined;
    const { archivedAt: _at, archivedBy: _by, archiveReason: _why, source: _source, ...rest } = previous;
    slot.record = {
      ...rest,
      version,
      updatedAt: at,
      updatedBy: actor,
      ...(source ? { source } : {}),
      ...(archive ? { archivedAt: at, archivedBy: actor, ...(reason ? { archiveReason: reason } : {}) } : {}),
    };
    this.log(slot, {
      type: ref.type,
      id: ref.id,
      scope: previous.scope,
      op: "update",
      before: previous.data,
      after: previous.data,
      version,
      actor,
      ...(source ? { source } : {}),
      at,
      lifecycle: archive ? "archived" : "unarchived",
      ...(reason ? { archiveReason: reason } : {}),
    });
    return { record: structuredClone(slot.record), previous: structuredClone(previous) };
  }

  private log(slot: Slot, change: StateChange): void {
    slot.changes.unshift(structuredClone(change));
    if (slot.changes.length > this.keep) slot.changes.length = this.keep;
  }
}

function key(ref: StateRef): string {
  return `${ref.type}\u0000${ref.id}`;
}

function fieldPath(field: string): string[] {
  if (!FIELD_PATH.test(field)) {
    throw new StateError(`\`${field}\` is not a field name a query can filter or sort on.`);
  }
  return field.split(".");
}

function read(data: Record<string, unknown>, path: string[]): unknown {
  let at: unknown = data;
  for (const part of path) {
    if (at === null || typeof at !== "object" || Array.isArray(at)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** SQLite's view of a value: booleans are 1 and 0, and missing is null. */
function norm(value: unknown): unknown {
  if (value === undefined) return null;
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function holds(raw: unknown, condition: FieldCondition, field: string): boolean {
  const value = norm(raw);
  if (condition === null) return value === null;
  if (typeof condition !== "object") return value === norm(condition);
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case "in": {
        const values = Array.isArray(operand) ? operand : [];
        if (!values.some((v) => norm(v) === value)) return false;
        break;
      }
      case "ne":
        if (operand === null ? value === null : value !== null && value === norm(operand)) return false;
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        if (value === null) return false;
        const c = compare(value, norm(operand));
        if (op === "gt" ? c <= 0 : op === "gte" ? c < 0 : op === "lt" ? c >= 0 : c > 0) return false;
        break;
      }
      default:
        throw new StateError(
          `\`${op}\` is not a condition a query understands on \`${field}\`. Use a value, or one of: in, ne, gt, gte, lt, lte.`,
        );
    }
  }
  return true;
}

/** SQLite's ordering across types: null, then numbers, then text, then anything else as JSON text. */
function compare(a: unknown, b: unknown): number {
  const x = norm(a);
  const y = norm(b);
  const rank = (v: unknown) => (v === null ? 0 : typeof v === "number" ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (x === null) return 0;
  if (typeof x === "number" && typeof y === "number") return x - y;
  const s = typeof x === "string" ? x : JSON.stringify(x);
  const t = typeof y === "string" ? y : JSON.stringify(y);
  return s < t ? -1 : s > t ? 1 : 0;
}
