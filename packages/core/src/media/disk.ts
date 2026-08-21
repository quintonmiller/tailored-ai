/**
 * The bundled media store: bytes under `<TAI_HOME>/media/`, metadata in the
 * `media` table.
 *
 * Layout mirrors `documents` (metadata in SQLite, bytes on disk) and the
 * content-addressing of `agent/tool-output.ts`. Blobs are fanned out one level
 * by the first two hex characters of their id, so a long-lived deployment does
 * not end up with a single directory holding a hundred thousand entries.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat as statFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MediaRef } from "../content/types.js";
import { taiHomePath } from "../home.js";
import { type MediaStore, MediaTooLargeError, type PutMediaOptions, type StoredMedia } from "./interface.js";
import { deleteMediaRow, getMediaRow, upsertMediaRow } from "./queries.js";
import { extensionFor, sniffMedia } from "./sniff.js";

export interface DiskMediaStoreOptions {
  db: Database.Database;
  /** Defaults to `<TAI_HOME>/media`. */
  dir?: string;
  /** Reject a `put` above this many bytes. Defaults to 32 MiB. */
  maxBytes?: number;
  /**
   * Base for {@link MediaStore.urlFor}, e.g. `/api/media`. Unset means this
   * store hands out no URLs and surfaces must read bytes instead.
   */
  urlBase?: string;
}

/** Anthropic caps a request at 32 MB; nothing we can send is usefully larger. */
export const DEFAULT_MAX_MEDIA_BYTES = 32 * 1024 * 1024;

export class DiskMediaStore implements MediaStore {
  readonly id = "disk";
  private readonly db: Database.Database;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly urlBase?: string;

  constructor(opts: DiskMediaStoreOptions) {
    this.db = opts.db;
    this.dir = opts.dir ?? taiHomePath("media");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    this.urlBase = opts.urlBase;
  }

  private pathFor(id: string, mimeType: string): string {
    return join(this.dir, id.slice(0, 2), `${id}.${extensionFor(mimeType)}`);
  }

  async put(bytes: Buffer, opts: PutMediaOptions = {}): Promise<MediaRef> {
    // Cap before doing any work, not after — the point of a ceiling is to not
    // pay for what exceeds it.
    if (bytes.byteLength > this.maxBytes) {
      throw new MediaTooLargeError(bytes.byteLength, this.maxBytes);
    }

    const sniffed = sniffMedia(bytes, opts.mimeType);
    const id = createHash("sha256").update(bytes).digest("hex");

    const ref: MediaRef = {
      id,
      mimeType: sniffed.mimeType,
      bytes: bytes.byteLength,
      ...(opts.name ? { name: opts.name } : {}),
      ...((opts.width ?? sniffed.width) ? { width: opts.width ?? sniffed.width } : {}),
      ...((opts.height ?? sniffed.height) ? { height: opts.height ?? sniffed.height } : {}),
    };

    // Content-addressed, so an existing blob with this id already holds exactly
    // these bytes. Skip the write, but still refresh the row so retention sees
    // the new session and the latest name.
    const path = this.pathFor(id, ref.mimeType);
    const existing = await fileExists(path);
    if (!existing) {
      await mkdir(join(this.dir, id.slice(0, 2)), { recursive: true });
      await writeFile(path, bytes);
    }
    upsertMediaRow(this.db, { ref, path, sessionId: opts.sessionId ?? null });
    return ref;
  }

  async get(id: string): Promise<StoredMedia | undefined> {
    const row = getMediaRow(this.db, id);
    if (!row) return undefined;
    try {
      const bytes = await readFile(row.path);
      return { ref: row.ref, bytes };
    } catch {
      // Row without a blob: the file was removed underneath us. Report absence
      // rather than a half-answer.
      return undefined;
    }
  }

  async stat(id: string): Promise<MediaRef | undefined> {
    return getMediaRow(this.db, id)?.ref;
  }

  async delete(id: string): Promise<boolean> {
    const row = getMediaRow(this.db, id);
    if (!row) return false;
    await rm(row.path, { force: true });
    deleteMediaRow(this.db, id);
    return true;
  }

  urlFor(id: string): string | undefined {
    if (!this.urlBase) return undefined;
    return `${this.urlBase.replace(/\/$/, "")}/${id}`;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await statFile(path);
    return true;
  } catch {
    return false;
  }
}
