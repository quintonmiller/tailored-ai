import type Database from "better-sqlite3";

/**
 * Vault table schema. Creates the vault table if it doesn't exist.
 *
 * The vault stores secrets encrypted at rest with AES-256-GCM.
 * Each entry is keyed by (namespace, key) and optionally marked
 * as a fetcher ref for single-use MCP expansion.
 */
export function createVaultTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      is_fetcher INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (namespace, key)
    )
  `);
}
