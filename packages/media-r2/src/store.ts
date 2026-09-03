/**
 * R2 is S3 with three answers already filled in, and one thing S3 does not have.
 *
 * Composition rather than inheritance: this holds an `S3MediaStore` and hands
 * it everything except `urlFor`. Reaching into a sibling package's protected
 * state to override one method would couple the two far harder than delegating
 * four calls does.
 */
import type { MediaRef, MediaStore, PutMediaOptions, StoredMedia } from "@tailored-ai/core";
import { type CoreBridge, extensionFor, S3MediaStore } from "@tailored-ai/media-s3";
import type Database from "better-sqlite3";

export interface R2MediaStoreOptions {
  db: Database.Database;
  core: CoreBridge;
  bucket: string;
  /** Cloudflare account id — the endpoint is derived from it. */
  accountId?: string;
  /** Full endpoint, when a custom one is in play. Overrides `accountId`. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  maxBytes?: number;
  urlExpiresIn?: number;
  timeoutMs?: number;
  /**
   * Base URL of a public bucket — an `r2.dev` subdomain or a custom domain.
   *
   * When set, `urlFor` returns a plain public URL instead of a presigned one:
   * permanent, cacheable, and shareable past the presign expiry. When unset,
   * links are presigned and the bucket stays private, which is the default
   * because "every recording this agent has ever made is world-readable to
   * anyone who guesses a hash" should be something a deployment opts into.
   */
  publicBaseUrl?: string;
}

/** `https://<account-id>.r2.cloudflarestorage.com` */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

export class R2MediaStore implements MediaStore {
  readonly id = "r2";
  private readonly inner: S3MediaStore;
  private readonly publicBaseUrl?: string;
  private readonly prefix: string;
  private readonly core: CoreBridge;
  private readonly db: Database.Database;

  constructor(opts: R2MediaStoreOptions) {
    const endpoint = opts.endpoint ?? r2Endpoint(requireAccountId(opts));
    this.inner = new S3MediaStore({
      db: opts.db,
      core: opts.core,
      bucket: opts.bucket,
      // R2 signs against `auto`. Anything else is rejected, and the two values
      // R2 aliases (`us-east-1`, empty) are not worth exposing as a choice.
      region: "auto",
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      endpoint,
      // R2 serves both styles; path-style is what the account endpoint is for
      // and it avoids needing a bucket subdomain to resolve.
      forcePathStyle: true,
      ...(opts.prefix ? { prefix: opts.prefix } : {}),
      ...(typeof opts.maxBytes === "number" ? { maxBytes: opts.maxBytes } : {}),
      ...(typeof opts.urlExpiresIn === "number" ? { urlExpiresIn: opts.urlExpiresIn } : {}),
      ...(typeof opts.timeoutMs === "number" ? { timeoutMs: opts.timeoutMs } : {}),
    });
    this.publicBaseUrl = opts.publicBaseUrl?.replace(/\/+$/, "");
    this.prefix = (opts.prefix ?? "media").replace(/^\/+|\/+$/g, "");
    this.core = opts.core;
    this.db = opts.db;
  }

  put(bytes: Buffer, opts?: PutMediaOptions): Promise<MediaRef> {
    return this.inner.put(bytes, opts);
  }
  get(id: string): Promise<StoredMedia | undefined> {
    return this.inner.get(id);
  }
  stat(id: string): Promise<MediaRef | undefined> {
    return this.inner.stat(id);
  }
  delete(id: string): Promise<boolean> {
    return this.inner.delete(id);
  }

  /**
   * A public URL when the bucket has a domain, a presigned one otherwise.
   *
   * The public form is read off the stored key rather than recomputed, so a
   * blob written under an older `prefix` still resolves.
   */
  urlFor(id: string): string | undefined {
    if (!this.publicBaseUrl) return this.inner.urlFor(id);
    const row = this.core.getMediaRow(this.db, id);
    if (!row) return undefined;
    return `${this.publicBaseUrl}/${row.path}`;
  }

  /** The key this store would write for an id, for callers that need it. */
  keyFor(id: string, mimeType: string): string {
    return `${this.prefix}/${id.slice(0, 2)}/${id}.${extensionFor(mimeType)}`;
  }
}

function requireAccountId(opts: R2MediaStoreOptions): string {
  if (!opts.accountId) {
    throw new Error("media.options.accountId is required for the r2 store (or set an explicit endpoint)");
  }
  return opts.accountId;
}
