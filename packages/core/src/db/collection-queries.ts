import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type CollectionType = "steelbook" | "tiki_mug" | "restaurant" | "bar" | "tiki_bar";

export interface Collection {
  id: string;
  type: CollectionType;
  name: string;
  notes: string | null;
  rating: number | null;
  location: string | null;
  url: string | null;
  added_by: "user" | "tai";
  source: "email_id" | "chat" | "manual" | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionInput {
  type: CollectionType;
  name: string;
  notes?: string | null;
  rating?: number | null;
  location?: string | null;
  url?: string | null;
  added_by?: "user" | "tai";
  source?: "email_id" | "chat" | "manual" | null;
}

export interface CollectionListFilter {
  type?: CollectionType;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CollectionListResult {
  items: Collection[];
  total: number;
}

export interface CollectionStats {
  steelbooks: number;
  tiki_mugs: number;
  restaurants: number;
  bars: number;
  tiki_bars: number;
  total: number;
}

function rowToCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    type: row.type as CollectionType,
    name: row.name,
    notes: row.notes,
    rating: row.rating,
    location: row.location,
    url: row.url,
    added_by: row.added_by as "user" | "tai",
    source: row.source as "email_id" | "chat" | "manual" | null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface CollectionRow {
  id: string;
  type: string;
  name: string;
  notes: string | null;
  rating: number | null;
  location: string | null;
  url: string | null;
  added_by: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export function listCollections(db: Database.Database, filter: CollectionListFilter = {}): CollectionListResult {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.type) {
    conditions.push("type = ?");
    params.push(filter.type);
  }

  if (filter.search) {
    conditions.push("(name LIKE ? OR notes LIKE ?)");
    const pattern = `%${filter.search}%`;
    params.push(pattern, pattern);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = db.prepare(`SELECT COUNT(*) as total FROM collections ${where}`).get(...params) as {
    total: number;
  };

  const limit = Math.min(filter.limit ?? 20, 100);
  const offset = filter.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM collections ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CollectionRow[];

  return {
    items: rows.map(rowToCollection),
    total: countRow.total,
  };
}

export function getCollectionStats(db: Database.Database): CollectionStats {
  const rows = db
    .prepare("SELECT type, COUNT(*) as count FROM collections GROUP BY type")
    .all() as Array<{ type: string; count: number }>;

  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.type] = r.count;
  }

  const steelbooks = map.steelbook ?? 0;
  const tiki_mugs = map.tiki_mug ?? 0;
  const restaurants = map.restaurant ?? 0;
  const bars = map.bar ?? 0;
  const tiki_bars = map.tiki_bar ?? 0;

  return {
    steelbooks,
    tiki_mugs,
    restaurants,
    bars,
    tiki_bars,
    total: steelbooks + tiki_mugs + restaurants + bars + tiki_bars,
  };
}

export function createCollection(db: Database.Database, input: CollectionInput): Collection {
  const validTypes: CollectionType[] = ["steelbook", "tiki_mug", "restaurant", "bar", "tiki_bar"];
  if (!validTypes.includes(input.type)) {
    throw new Error(`Invalid collection type: ${input.type}`);
  }
  if (!input.name?.trim()) {
    throw new Error("name is required");
  }
  if (input.rating !== undefined && input.rating !== null) {
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
      throw new Error("rating must be an integer 1–5");
    }
  }

  const id = `col_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO collections (id, type, name, notes, rating, location, url, added_by, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.type,
    input.name.trim(),
    input.notes ?? null,
    input.rating ?? null,
    input.location ?? null,
    input.url ?? null,
    input.added_by ?? "user",
    input.source ?? null,
    now,
    now,
  );

  return getCollection(db, id)!;
}

export function getCollection(db: Database.Database, id: string): Collection | null {
  const row = db.prepare("SELECT * FROM collections WHERE id = ?").get(id) as CollectionRow | undefined;
  return row ? rowToCollection(row) : null;
}

export function deleteCollection(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM collections WHERE id = ?").run(id);
  return result.changes > 0;
}
