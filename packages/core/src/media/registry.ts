/**
 * Media-store selection.
 *
 * Mirrors the provider/embedding/task-backend registries: a string-keyed
 * factory, an open selector, and an opaque options bag. Core never holds a list
 * of known store ids, and the bundled disk store registers through exactly the
 * door a third-party S3 store would use.
 */

import type Database from "better-sqlite3";
import { type Disposer, Registry } from "../registry.js";
import { DiskMediaStore } from "./disk.js";
import type { MediaStore } from "./interface.js";

export interface MediaStoreContext {
  db: Database.Database;
  /** `media.*` from config, verbatim. Store-specific keys live here. */
  options: Record<string, unknown>;
}

export type MediaStoreFactory = (ctx: MediaStoreContext) => MediaStore | undefined;

const registry = new Registry<MediaStoreFactory>("media-store");

/**
 * Returns the inverse, like every other registration in core.
 *
 * It used to return void and drop the disposer the registry already handed
 * back, which made a media-store plugin the one kind that could not be
 * unregistered — see the "registrations return their inverse" note in
 * CLAUDE.md.
 */
export function registerMediaStoreFactory(id: string, factory: MediaStoreFactory): Disposer {
  return registry.register(id, factory);
}

export function listMediaStoreFactories(): string[] {
  return registry.list();
}

/**
 * Build the configured store, or the bundled disk one.
 *
 * Returns undefined only when a deployment names a store nobody registered —
 * an explicit misconfiguration, which the caller should report rather than
 * paper over with a silent fallback to disk.
 */
export function resolveMediaStore(ctx: MediaStoreContext, id?: string): MediaStore | undefined {
  const selected = id ?? "disk";
  const factory = registry.get(selected);
  if (!factory) return undefined;
  return factory(ctx);
}

registerMediaStoreFactory("disk", ({ db, options }) => {
  return new DiskMediaStore({
    db,
    dir: typeof options.dir === "string" ? options.dir : undefined,
    maxBytes: typeof options.maxBytes === "number" ? options.maxBytes : undefined,
    urlBase: typeof options.urlBase === "string" ? options.urlBase : undefined,
  });
});
