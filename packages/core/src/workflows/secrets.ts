import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type Database from "better-sqlite3";
import { taiHome } from "../home.js";

/**
 * Per-workflow secrets store. Values are encrypted at rest using AES-256-GCM
 * with a single key derived from `TAI_SECRETS_KEY` (env) or a key file under
 * `~/.tailored-ai/secrets.key` (auto-generated on first use). Secrets are
 * write-only from the UI — read endpoints redact `value` to `null`, only the
 * key list is exposed.
 *
 * Workflows reference secrets via `${secrets.NAME}` in any string field. The
 * scope layer resolves them at run time, never echoing values into run logs
 * (the engine logs the placeholder string itself, not the resolved value).
 */

const ALGORITHM = "aes-256-gcm" as const;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION_MARKER = "v1:";

let cachedKey: Buffer | null = null;

/**
 * Load (or lazily generate) the 32-byte symmetric key used to encrypt
 * secrets. Resolution order:
 *
 * 1. `TAI_SECRETS_KEY` env var (hex-encoded, 64 chars).
 * 2. `<dataDir>/secrets.key` file (hex-encoded). Auto-created on first use.
 *
 * The auto-created file is mode 0600. If both are present, env wins.
 */
export function getSecretsKey(dataDir?: string): Buffer {
  if (cachedKey) return cachedKey;
  const envHex = process.env.TAI_SECRETS_KEY;
  if (envHex && envHex.length === KEY_LENGTH * 2) {
    cachedKey = Buffer.from(envHex, "hex");
    return cachedKey;
  }
  const dir = dataDir ? resolve(dataDir) : taiHome();
  const keyPath = resolve(dir, "secrets.key");
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

/** Reset the cached key — used by tests. */
export function _resetSecretsKeyCache(): void {
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
    throw new Error("secret has unknown encryption version");
  }
  const [, ivHex, tagHex, dataHex] = encrypted.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed encrypted secret");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");
  if (tag.length !== TAG_LENGTH) throw new Error("malformed auth tag");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

export interface SecretRecord {
  workflow_name: string;
  key: string;
  created_at: string;
  updated_at: string;
}

export function setSecret(
  db: Database.Database,
  workflowName: string,
  key: string,
  value: string,
  encryptionKey?: Buffer,
): void {
  const k = encryptionKey ?? getSecretsKey();
  const enc = encrypt(value, k);
  db.prepare(
    `INSERT INTO workflow_secrets (workflow_name, key, value_encrypted)
     VALUES (?, ?, ?)
     ON CONFLICT(workflow_name, key)
     DO UPDATE SET value_encrypted = excluded.value_encrypted,
                   updated_at = datetime('now')`,
  ).run(workflowName, key, enc);
}

export function getSecret(
  db: Database.Database,
  workflowName: string,
  key: string,
  encryptionKey?: Buffer,
): string | null {
  const row = db
    .prepare(`SELECT value_encrypted FROM workflow_secrets WHERE workflow_name = ? AND key = ?`)
    .get(workflowName, key) as { value_encrypted: string } | undefined;
  if (!row) return null;
  const k = encryptionKey ?? getSecretsKey();
  return decrypt(row.value_encrypted, k);
}

export function listSecrets(db: Database.Database, workflowName: string): SecretRecord[] {
  return db
    .prepare(
      `SELECT workflow_name, key, created_at, updated_at FROM workflow_secrets WHERE workflow_name = ? ORDER BY key`,
    )
    .all(workflowName) as SecretRecord[];
}

export function deleteSecret(db: Database.Database, workflowName: string, key: string): boolean {
  const res = db.prepare(`DELETE FROM workflow_secrets WHERE workflow_name = ? AND key = ?`).run(workflowName, key);
  return res.changes > 0;
}

/** Load all secrets for a workflow into a plain {name: value} map. */
export function loadSecretsMap(
  db: Database.Database,
  workflowName: string,
  encryptionKey?: Buffer,
): Record<string, string> {
  const k = encryptionKey ?? getSecretsKey();
  const rows = db
    .prepare(`SELECT key, value_encrypted FROM workflow_secrets WHERE workflow_name = ?`)
    .all(workflowName) as Array<{ key: string; value_encrypted: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = decrypt(r.value_encrypted, k);
    } catch (err) {
      console.warn(`[secrets] failed to decrypt ${workflowName}/${r.key}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Test helper: stable hash of a value for assertions without revealing it. */
export function hashForTest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
