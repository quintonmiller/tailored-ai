/**
 * A {@link MediaStore} whose bytes live in S3 and whose metadata lives where
 * core looks for it.
 *
 * The second half is the part that is easy to get wrong. Core's `media` table
 * is not this store's bookkeeping — the retention sweep walks it and calls
 * `delete`, `touchMedia` reprieves a blob whose rendition was just served, and
 * the byte total sums it. A store that kept metadata elsewhere would be
 * invisible to all three: its objects would never expire and never appear in a
 * total. So the row goes in core's table with the S3 key in `path`, which core
 * never interprets and this store always does.
 */

import { createHash } from "node:crypto";
import type { MediaRef, MediaStore, PutMediaOptions, StoredMedia } from "@tailored-ai/core";
import type Database from "better-sqlite3";
import { type CoreBridge, extensionFor } from "./core-bridge.js";
import { S3Client, type S3ClientOptions } from "./s3.js";

export interface S3MediaStoreOptions extends S3ClientOptions {
  db: Database.Database;
  core: CoreBridge;
  /** Prefix inside the bucket. Default `media`. */
  prefix?: string;
  /** Refuse a put over this many bytes. */
  maxBytes?: number;
  /** Lifetime of a presigned link, seconds. Default one hour. */
  urlExpiresIn?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_URL_EXPIRY = 3600;

export class S3MediaStore implements MediaStore {
  readonly id = "s3";
  private readonly s3: S3Client;

  constructor(private readonly opts: S3MediaStoreOptions) {
    this.s3 = new S3Client(opts);
  }

  /**
   * Content-addressed, and fanned out by the first byte of the hash.
   *
   * The fan-out is not for S3's benefit — it has no directories — but so a
   * human listing the bucket, or a lifecycle rule, sees the same shape the
   * disk store writes.
   */
  private keyFor(id: string, mimeType: string): string {
    const prefix = (this.opts.prefix ?? "media").replace(/^\/+|\/+$/g, "");
    return `${prefix}/${id.slice(0, 2)}/${id}.${extensionFor(mimeType)}`;
  }

  async put(bytes: Buffer, opts: PutMediaOptions = {}): Promise<MediaRef> {
    const maxBytes = this.opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (bytes.byteLength > maxBytes) {
      throw new this.opts.core.MediaTooLargeError(bytes.byteLength, maxBytes);
    }

    const sniffed = this.opts.core.sniffMedia(bytes, opts.mimeType);
    const id = createHash("sha256").update(bytes).digest("hex");
    const ref: MediaRef = {
      id,
      mimeType: sniffed.mimeType,
      bytes: bytes.byteLength,
      ...(opts.name ? { name: opts.name } : {}),
      ...((opts.width ?? sniffed.width) ? { width: opts.width ?? sniffed.width } : {}),
      ...((opts.height ?? sniffed.height) ? { height: opts.height ?? sniffed.height } : {}),
    };

    const key = this.keyFor(id, ref.mimeType);
    // Content-addressed, so an object under this key already holds exactly
    // these bytes. A HEAD is one small round trip and skips uploading a
    // duplicate; the row is refreshed either way so retention sees the new
    // session and the latest name.
    if (!(await this.s3.exists(key))) {
      await this.s3.put(key, bytes, ref.mimeType);
    }
    this.opts.core.upsertMediaRow(this.opts.db, { ref, path: key, sessionId: opts.sessionId ?? null });
    return ref;
  }

  async get(id: string): Promise<StoredMedia | undefined> {
    const row = this.opts.core.getMediaRow(this.opts.db, id);
    if (!row) return undefined;
    const bytes = await this.s3.get(row.path);
    // A row without an object: the bucket lost it, or a lifecycle rule got
    // there first. Report absence rather than a half-answer, exactly as the
    // disk store does for a missing file.
    return bytes ? { ref: row.ref, bytes } : undefined;
  }

  async stat(id: string): Promise<MediaRef | undefined> {
    return this.opts.core.getMediaRow(this.opts.db, id)?.ref;
  }

  async delete(id: string): Promise<boolean> {
    const row = this.opts.core.getMediaRow(this.opts.db, id);
    if (!row) return false;
    await this.s3.delete(row.path);
    this.opts.core.deleteMediaRow(this.opts.db, id);
    return true;
  }

  /**
   * A presigned link, computed fresh every time.
   *
   * Never stale, because nothing stores it: `renderForSurface` asks for a link
   * at render time rather than reading one off the ref. That is what makes a
   * short expiry safe — an hour is long enough to click and short enough that a
   * leaked link stops working.
   */
  urlFor(id: string): string | undefined {
    const row = this.opts.core.getMediaRow(this.opts.db, id);
    if (!row) return undefined;
    return this.s3.presign(row.path, this.opts.urlExpiresIn ?? DEFAULT_URL_EXPIRY);
  }

  // No localPathFor: the bytes are genuinely not on this machine, and
  // returning a fabricated path would be worse than returning nothing.
}
