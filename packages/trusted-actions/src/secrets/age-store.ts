import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Age-encrypted blob store for credentials and session data.
 *
 * Uses a simple AES-256-GCM scheme keyed by a passphrase that lives
 * in systemd-creds (or an env var for dev). In production the
 * passphrase never touches disk — it's injected at boot via
 * `LoadCredential=` in the systemd unit.
 *
 * Each blob is stored as a JSON file with:
 * - `iv`: 16-byte initialization vector (hex)
 * - `tag`: 16-byte auth tag (hex)
 * - `data`: encrypted payload (hex)
 */

const DEFAULT_SECRETS_DIR = path.join(process.env.HOME || "/tmp", ".tai-executor", "secrets");

export interface AgeStoreOptions {
  /** Directory to store encrypted blobs. Defaults to ~/.tai-executor/secrets/ */
  secretsDir?: string;
  /** Passphrase for encryption. In production, injected via systemd-creds. */
  passphrase?: string;
}

export class AgeStore {
  private secretsDir: string;
  private passphrase: string | null;

  constructor(opts?: AgeStoreOptions) {
    this.secretsDir = opts?.secretsDir ?? DEFAULT_SECRETS_DIR;
    this.passphrase = opts?.passphrase ?? process.env.TAI_EXECUTOR_PASSPHRASE ?? null;
  }

  /**
   * Derive a 32-byte key from the passphrase using PBKDF2.
   */
  private deriveKey(): Buffer {
    if (!this.passphrase) {
      throw new Error("TAI_EXECUTOR_PASSPHRASE must be set to access encrypted secrets");
    }
    return crypto.pbkdf2Sync(this.passphrase, "tai-executor-salt", 100_000, 32, "sha256");
  }

  /**
   * Encrypt and save a blob to the store.
   */
  public async save(key: string, plaintext: string): Promise<void> {
    const keyMaterial = this.deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial, iv);

    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const blob = {
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      data: encrypted.toString("hex"),
    };

    fs.mkdirSync(this.secretsDir, { recursive: true });
    fs.writeFileSync(path.join(this.secretsDir, `${key}.json`), JSON.stringify(blob));
  }

  /**
   * Load and decrypt a blob from the store.
   */
  public async load(key: string): Promise<string | null> {
    const filePath = path.join(this.secretsDir, `${key}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const blob = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const keyMaterial = this.deriveKey();
    const iv = Buffer.from(blob.iv, "hex");
    const tag = Buffer.from(blob.tag, "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(Buffer.from(blob.data, "hex")), decipher.final()]);

    return decrypted.toString("utf8");
  }

  /**
   * Check if a key exists in the store.
   */
  public exists(key: string): boolean {
    return fs.existsSync(path.join(this.secretsDir, `${key}.json`));
  }

  /**
   * Remove a key from the store.
   */
  public async remove(key: string): Promise<void> {
    const filePath = path.join(this.secretsDir, `${key}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
