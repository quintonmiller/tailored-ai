import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { taiHome } from "../home.js";

/**
 * Age-encrypted secrets vault keyed by `ns.key` (namespace.key).
 *
 * The vault stores secrets encrypted at rest using AES-256-GCM with a master
 * key derived from `TAI_VAULT_KEY` (env) or a key file under
 * `~/.tailored-ai/vault.key` (auto-generated on first use).
 *
 * References use `$ns.key` syntax (e.g. `$amazon.password`,
 * `$home.shipping_address`). The reference parser expands these at the
 * mediator boundary — values never appear in tool returns or audit logs.
 *
 * Single-use fetcher refs (e.g. `$robinhood.agentic_card.pan`) trigger
 * an external MCP fetch on expansion when the value is not cached.
 */

const ALGORITHM = "aes-256-gcm" as const;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_MARKER = "v1:";

let cachedKey: Buffer | null = null;

/** Vault master key resolution. */
export function getVaultKey(dataDir?: string): Buffer {
  if (cachedKey) return cachedKey;
  const envHex = process.env.TAI_VAULT_KEY;
  if (envHex && envHex.length === KEY_LENGTH * 2) {
    cachedKey = Buffer.from(envHex, "hex");
    return cachedKey;
  }
  const dir = dataDir ? resolve(dataDir) : taiHome();
  const keyPath = resolve(dir, "vault.key");
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, "utf-8").trim();
    cachedKey = Buffer.from(hex, "hex");
    return cachedKey;
  }
  if (!existsSync(dir)) mkdirSync(dirname(keyPath), { recursive: true });
  const fresh = randomBytes(KEY_LENGTH);
  writeFileSync(keyPath, fresh.toString("hex"), { mode: 0o600 });
  cachedKey = fresh;
  return fresh;
}

/** Reset cached key — used by tests. */
export function _resetVaultKeyCache(): void {
  cachedKey = null;
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION_MARKER}${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

function decrypt(encrypted: string, key: Buffer): string {
  if (!encrypted.startsWith(VERSION_MARKER)) {
    throw new Error("vault secret has unknown encryption version");
  }
  const [, ivHex, tagHex, dataHex] = encrypted.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed encrypted vault secret");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  if (tag.length !== TAG_LENGTH) throw new Error("malformed auth tag");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

/** Namespace.key format: `namespace.key` where both parts are non-empty. */
export interface VaultKey {
  namespace: string;
  key: string;
}

/** Parse `$ns.key` or `ns.key` into a VaultKey. Returns null if invalid. */
export function parseVaultKey(ref: string): VaultKey | null {
  // Strip leading $ if present
  const raw = ref.startsWith("$") ? ref.slice(1) : ref;
  const dotIndex = raw.indexOf(".");
  if (dotIndex < 1 || dotIndex === raw.length - 1) return null;
  const namespace = raw.slice(0, dotIndex);
  const key = raw.slice(dotIndex + 1);
  if (!namespace || !key) return null;
  return { namespace, key };
}

/** Serialize a VaultKey back to `$ns.key` format. */
export function formatVaultKey(k: VaultKey): string {
  return `$${k.namespace}.${k.key}`;
}

/** Vault record stored in the database. */
export interface VaultRecord {
  namespace: string;
  key: string;
  created_at: string;
  updated_at: string;
  /** True if this secret is a single-use fetcher ref (triggers MCP on expansion). */
  is_fetcher: boolean;
}

/** Store a secret in the vault. */
export function vaultSet(
  db: Database.Database,
  namespace: string,
  key: string,
  value: string,
  isFetcher?: boolean,
  encryptionKey?: Buffer,
): void {
  const k = encryptionKey ?? getVaultKey();
  const enc = encrypt(value, k);
  db.prepare(
    `INSERT INTO vault (namespace, key, value_encrypted, is_fetcher)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(namespace, key)
     DO UPDATE SET value_encrypted = excluded.value_encrypted,
                   is_fetcher = excluded.is_fetcher,
                   updated_at = datetime('now')`,
  ).run(namespace, key, enc, isFetcher ? 1 : 0);
}

/** Retrieve a secret from the vault. Returns null if not found. */
export function vaultGet(db: Database.Database, namespace: string, key: string, encryptionKey?: Buffer): string | null {
  const row = db.prepare(`SELECT value_encrypted FROM vault WHERE namespace = ? AND key = ?`).get(namespace, key) as
    | { value_encrypted: string }
    | undefined;
  if (!row) return null;
  const k = encryptionKey ?? getVaultKey();
  return decrypt(row.value_encrypted, k);
}

/** List all vault entries (metadata only, no values). */
export function vaultList(db: Database.Database, namespace?: string): VaultRecord[] {
  if (namespace) {
    return db
      .prepare(`SELECT namespace, key, created_at, updated_at, is_fetcher FROM vault WHERE namespace = ? ORDER BY key`)
      .all(namespace) as VaultRecord[];
  }
  return db
    .prepare(`SELECT namespace, key, created_at, updated_at, is_fetcher FROM vault ORDER BY namespace, key`)
    .all() as VaultRecord[];
}

/** Delete a vault entry. Returns true if deleted. */
export function vaultDelete(db: Database.Database, namespace: string, key: string): boolean {
  const res = db.prepare(`DELETE FROM vault WHERE namespace = ? AND key = ?`).run(namespace, key);
  return res.changes > 0;
}

/**
 * Check if a vault entry is a single-use fetcher ref.
 */
export function vaultIsFetcher(db: Database.Database, namespace: string, key: string): boolean {
  const row = db.prepare(`SELECT is_fetcher FROM vault WHERE namespace = ? AND key = ?`).get(namespace, key) as
    | { is_fetcher: number }
    | undefined;
  return !!row?.is_fetcher;
}

/** Test helper: stable hash of a value for assertions. */
export function hashForTest(value: string): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
