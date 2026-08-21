/**
 * Where media bytes live.
 *
 * A seam, not a hardcoded directory: a deployment that wants S3 or a CDN
 * registers its own through {@link import("./registry.js").registerMediaStoreFactory}
 * and core never learns its name. The bundled disk implementation registers
 * through the same door as a third party would.
 *
 * The shape follows `documents` — metadata in SQLite, bytes on disk — and
 * generalizes what `agent/tool-output.ts` already does for capped tool output:
 * content-addressed names, so storing the same payload twice costs one blob.
 */

import type { MediaRef } from "../content/types.js";

export interface PutMediaOptions {
  /**
   * Declared media type, if the caller has one. Advisory: an implementation
   * SHOULD resolve the real type from the bytes and prefer that, because a
   * caller's claim about an upload is not evidence.
   */
  mimeType?: string;
  /** Human-facing label, kept for the text projection and downloads. */
  name?: string;
  /** Session this blob was first seen in. Used by retention, not for access control. */
  sessionId?: string;
  width?: number;
  height?: number;
}

export interface StoredMedia {
  ref: MediaRef;
  bytes: Buffer;
}

export interface MediaStore {
  id: string;

  /**
   * Store bytes and return a reference to them.
   *
   * Idempotent by content: putting identical bytes twice returns the same
   * {@link MediaRef.id} and stores one copy.
   */
  put(bytes: Buffer, opts?: PutMediaOptions): Promise<MediaRef>;

  /** Bytes plus metadata, or undefined when the id is unknown. */
  get(id: string): Promise<StoredMedia | undefined>;

  /** Metadata only — cheap, and enough to render a placeholder or an <img> src. */
  stat(id: string): Promise<MediaRef | undefined>;

  /** Remove a blob. Returns false when the id was already unknown. */
  delete(id: string): Promise<boolean>;

  /**
   * A URL a render surface can fetch this from, when the deployment serves one.
   * Undefined means "no URL; read the bytes instead".
   */
  urlFor?(id: string): string | undefined;
}

/** Thrown when a `put` exceeds the configured size ceiling. */
export class MediaTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`Media is ${bytes} bytes, over the ${limit}-byte limit`);
    this.name = "MediaTooLargeError";
  }
}
