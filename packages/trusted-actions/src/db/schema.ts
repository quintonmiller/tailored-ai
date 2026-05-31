import Database from "better-sqlite3";
import { migrate } from "./migrations.js";

type Db = Database.Database;

let db: Db | null = null;

export function getDb(path?: string): Db {
  if (db) return db;
  const resolved = path ?? process.env.TA_DB_PATH ?? ":memory:";
  db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
