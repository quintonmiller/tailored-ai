/**
 * The built-in state provider: records and their history in the runtime's
 * SQLite database.
 *
 * It creates its own tables rather than core's schema creating them, because
 * a store that is meant to be replaceable should not leave its schema behind
 * in core when it is replaced.
 *
 * History is an append-only log beside the records. A delete is a tombstone —
 * the row stays, marked deleted, and the removal is logged — so a record's
 * history survives it. `purge` is the hard delete, for an admin. An archived
 * record is a live row with `archived_at` set, which queries skip unless asked.
 */
import type Database from "better-sqlite3";
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

/** A data field path: `status`, `owner.name`. Anything else never reaches SQL. */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

interface RecordRow {
  type: string;
  id: string;
  scope: string;
  data: string;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
  source: string | null;
  deleted: number;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

interface ChangeRow {
  type: string;
  id: string;
  scope: string;
  op: StateChange["op"];
  before: string | null;
  after: string | null;
  version: number;
  actor: string;
  source: string | null;
  at: string;
  lifecycle: StateChange["lifecycle"] | null;
  archive_reason: string | null;
}

export class SqliteStateProvider implements StateProvider {
  readonly id = "sqlite";

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS state_records (
        type        TEXT NOT NULL,
        id          TEXT NOT NULL,
        scope       TEXT NOT NULL,
        data        TEXT NOT NULL,
        version     INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        updated_by  TEXT NOT NULL,
        source      TEXT,
        deleted     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX IF NOT EXISTS idx_state_records_scope ON state_records(type, scope, deleted);
      CREATE TABLE IF NOT EXISTS state_changes (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        type     TEXT NOT NULL,
        id       TEXT NOT NULL,
        scope    TEXT NOT NULL,
        op       TEXT NOT NULL,
        before   TEXT,
        after    TEXT,
        version  INTEGER NOT NULL,
        actor    TEXT NOT NULL,
        source   TEXT,
        at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_changes_ref ON state_changes(type, id, seq);
    `);
    // Archiving came later. Added in place, so a store from before it reads
    // every record as live, with nothing for anyone to run.
    for (const ddl of [
      "ALTER TABLE state_records ADD COLUMN archived_at TEXT",
      "ALTER TABLE state_records ADD COLUMN archived_by TEXT",
      "ALTER TABLE state_records ADD COLUMN archive_reason TEXT",
      "ALTER TABLE state_changes ADD COLUMN lifecycle TEXT",
      "ALTER TABLE state_changes ADD COLUMN archive_reason TEXT",
    ]) {
      try {
        db.exec(ddl);
      } catch {
        // The column is already there.
      }
    }
  }

  async get(ref: StateRef): Promise<StateRecord | null> {
    const row = this.row(ref);
    return row && !row.deleted ? toRecord(row) : null;
  }

  async query(q: StateQuery): Promise<StateRecord[]> {
    const clauses = ["type = ?", "deleted = 0"];
    const params: unknown[] = [q.type];
    if (!q.includeArchived) clauses.push("archived_at IS NULL");

    if (q.scopes) {
      if (q.scopes.length === 0) return [];
      clauses.push(`scope IN (${q.scopes.map(() => "?").join(", ")})`);
      params.push(...q.scopes);
    }

    for (const [field, condition] of Object.entries(q.where ?? {})) {
      const column = dataColumn(field);
      clauses.push(...conditionSql(column, condition, params, field));
    }

    const order = orderSql(q.orderBy);
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
    const offset = Math.max(0, Math.floor(q.offset ?? 0));
    const rows = this.db
      .prepare(`SELECT * FROM state_records WHERE ${clauses.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as RecordRow[];
    return rows.map(toRecord);
  }

  async put(write: StateWrite, expectedVersion?: number): Promise<StateWriteResult> {
    return this.db.transaction((): StateWriteResult => {
      const existing = this.row(write);
      const live = existing && !existing.deleted ? existing : undefined;
      const liveVersion = live?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== liveVersion) {
        throw new StateConflictError(write, expectedVersion, liveVersion);
      }

      const at = this.now().toISOString();
      // A tombstoned record keeps counting from where it stopped, so a version
      // number is never reused for the same id.
      const version = (existing?.version ?? 0) + 1;
      const createdAt = live ? live.created_at : at;
      this.db
        .prepare(
          `INSERT INTO state_records (type, id, scope, data, version, created_at, updated_at, updated_by, source, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(type, id) DO UPDATE SET
             scope = excluded.scope, data = excluded.data, version = excluded.version,
             created_at = excluded.created_at, updated_at = excluded.updated_at,
             updated_by = excluded.updated_by, source = excluded.source, deleted = 0,
             archived_at = NULL, archived_by = NULL, archive_reason = NULL`,
        )
        .run(
          write.type,
          write.id,
          write.scope,
          JSON.stringify(write.data),
          version,
          createdAt,
          at,
          JSON.stringify(write.actor),
          write.source ? JSON.stringify(write.source) : null,
        );

      this.log({
        type: write.type,
        id: write.id,
        scope: write.scope,
        op: live ? "update" : "create",
        before: live ? JSON.parse(live.data) : undefined,
        after: write.data,
        version,
        actor: write.actor,
        source: write.source,
        at,
        // A put writes the whole record, archive state included, so one over
        // an archived record brings it back.
        ...(live?.archived_at ? { lifecycle: "unarchived" as const } : {}),
      });

      const record = toRecord(this.row(write) as RecordRow);
      return live ? { record, previous: toRecord(live) } : { record };
    })();
  }

  async delete(ref: StateRef, actor: Actor, source?: Source, expectedVersion?: number): Promise<StateRecord | null> {
    return this.db.transaction((): StateRecord | null => {
      const live = this.row(ref);
      if (!live || live.deleted) return null;
      if (expectedVersion !== undefined && expectedVersion !== live.version)
        throw new StateConflictError(ref, expectedVersion, live.version);
      const at = this.now().toISOString();
      const version = live.version + 1;
      this.db
        .prepare(
          `UPDATE state_records SET deleted = 1, version = ?, updated_at = ?, updated_by = ?, source = ?
           WHERE type = ? AND id = ?`,
        )
        .run(version, at, JSON.stringify(actor), source ? JSON.stringify(source) : null, ref.type, ref.id);
      this.log({
        type: ref.type,
        id: ref.id,
        scope: live.scope,
        op: "delete",
        before: JSON.parse(live.data),
        version,
        actor,
        source,
        at,
      });
      return toRecord(live);
    })();
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
    const rows = this.db
      .prepare("SELECT * FROM state_changes WHERE type = ? AND id = ? ORDER BY seq DESC LIMIT ?")
      .all(ref.type, ref.id, limit) as ChangeRow[];
    return rows.map(toChange);
  }

  async purge(ref: StateRef): Promise<boolean> {
    return this.db.transaction((): boolean => {
      const removed = this.db.prepare("DELETE FROM state_records WHERE type = ? AND id = ?").run(ref.type, ref.id);
      const erased = this.db.prepare("DELETE FROM state_changes WHERE type = ? AND id = ?").run(ref.type, ref.id);
      return removed.changes + erased.changes > 0;
    })();
  }

  /** Archive (`archive` given) or bring back (null) a live record: a write of its own, data unchanged. */
  private setArchived(
    ref: StateRef,
    archive: { reason?: string } | null,
    actor: Actor,
    source: Source | undefined,
    expectedVersion: number | undefined,
  ): StateWriteResult | null {
    return this.db.transaction((): StateWriteResult | null => {
      const live = this.row(ref);
      if (!live || live.deleted) return null;
      if (expectedVersion !== undefined && expectedVersion !== live.version)
        throw new StateConflictError(ref, expectedVersion, live.version);
      const at = this.now().toISOString();
      const version = live.version + 1;
      const reason = archive?.reason || undefined;
      this.db
        .prepare(
          `UPDATE state_records SET version = ?, updated_at = ?, updated_by = ?, source = ?,
             archived_at = ?, archived_by = ?, archive_reason = ?
           WHERE type = ? AND id = ?`,
        )
        .run(
          version,
          at,
          JSON.stringify(actor),
          source ? JSON.stringify(source) : null,
          archive ? at : null,
          archive ? JSON.stringify(actor) : null,
          reason ?? null,
          ref.type,
          ref.id,
        );
      const data = JSON.parse(live.data);
      this.log({
        type: ref.type,
        id: ref.id,
        scope: live.scope,
        op: "update",
        before: data,
        after: data,
        version,
        actor,
        source,
        at,
        lifecycle: archive ? "archived" : "unarchived",
        ...(reason ? { archiveReason: reason } : {}),
      });
      return { record: toRecord(this.row(ref) as RecordRow), previous: toRecord(live) };
    })();
  }

  private row(ref: StateRef): RecordRow | undefined {
    return this.db.prepare("SELECT * FROM state_records WHERE type = ? AND id = ?").get(ref.type, ref.id) as
      | RecordRow
      | undefined;
  }

  private log(change: StateChange): void {
    this.db
      .prepare(
        `INSERT INTO state_changes (type, id, scope, op, before, after, version, actor, source, at, lifecycle, archive_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.type,
        change.id,
        change.scope,
        change.op,
        change.before ? JSON.stringify(change.before) : null,
        change.after ? JSON.stringify(change.after) : null,
        change.version,
        JSON.stringify(change.actor),
        change.source ? JSON.stringify(change.source) : null,
        change.at,
        change.lifecycle ?? null,
        change.archiveReason ?? null,
      );
  }
}

function toRecord(row: RecordRow): StateRecord {
  return {
    type: row.type,
    id: row.id,
    scope: row.scope,
    data: JSON.parse(row.data),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: JSON.parse(row.updated_by),
    ...(row.source ? { source: JSON.parse(row.source) } : {}),
    ...(row.archived_at
      ? {
          archivedAt: row.archived_at,
          ...(row.archived_by ? { archivedBy: JSON.parse(row.archived_by) } : {}),
          ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
        }
      : {}),
  };
}

function toChange(row: ChangeRow): StateChange {
  return {
    type: row.type,
    id: row.id,
    scope: row.scope,
    op: row.op,
    ...(row.before ? { before: JSON.parse(row.before) } : {}),
    ...(row.after ? { after: JSON.parse(row.after) } : {}),
    version: row.version,
    actor: JSON.parse(row.actor),
    ...(row.source ? { source: JSON.parse(row.source) } : {}),
    at: row.at,
    ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}),
    ...(row.archive_reason ? { archiveReason: row.archive_reason } : {}),
  };
}

function dataColumn(field: string): string {
  if (!FIELD_PATH.test(field)) {
    throw new StateError(`\`${field}\` is not a field name a query can filter or sort on.`);
  }
  // Validated above, so interpolating the path is safe.
  return `json_extract(data, '$.${field}')`;
}

/** JSON1 hands booleans back as 1 and 0, so a boolean parameter has to match that. */
function sqlValue(value: string | number | boolean): string | number {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

function conditionSql(column: string, condition: FieldCondition, params: unknown[], field: string): string[] {
  if (condition === null) return [`${column} IS NULL`];
  if (typeof condition !== "object") {
    params.push(sqlValue(condition));
    return [`${column} = ?`];
  }
  const out: string[] = [];
  for (const [op, operand] of Object.entries(condition)) {
    switch (op) {
      case "in": {
        const values = Array.isArray(operand) ? operand : [];
        if (values.length === 0) {
          out.push("0");
          break;
        }
        const nonNull = values.filter((v): v is string | number | boolean => v !== null);
        const parts: string[] = [];
        if (nonNull.length) {
          parts.push(`${column} IN (${nonNull.map(() => "?").join(", ")})`);
          params.push(...nonNull.map(sqlValue));
        }
        if (nonNull.length !== values.length) parts.push(`${column} IS NULL`);
        out.push(`(${parts.join(" OR ")})`);
        break;
      }
      case "ne":
        if (operand === null) out.push(`${column} IS NOT NULL`);
        else {
          out.push(`(${column} IS NULL OR ${column} != ?)`);
          params.push(sqlValue(operand as string | number | boolean));
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const sym = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
        out.push(`${column} ${sym} ?`);
        params.push(sqlValue(operand as string | number));
        break;
      }
      default:
        throw new StateError(
          `\`${op}\` is not a condition a query understands on \`${field}\`. Use a value, or one of: in, ne, gt, gte, lt, lte.`,
        );
    }
  }
  return out.length ? out : ["1"];
}

function orderSql(orderBy: StateQuery["orderBy"]): string {
  const direction = orderBy?.direction === "asc" ? "ASC" : "DESC";
  const field = orderBy?.field ?? "updatedAt";
  const column =
    field === "updatedAt"
      ? "updated_at"
      : field === "createdAt"
        ? "created_at"
        : field === "id"
          ? "id"
          : dataColumn(field);
  // `id` breaks ties so a page boundary never shows the same record twice.
  return `${column} ${direction}, id ASC`;
}
