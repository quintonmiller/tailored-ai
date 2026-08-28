/**
 * Remembering what a rendition produced.
 *
 * The history is re-sent every round, so without a cache a five-round turn runs
 * the same OCR pass five times — and an OCR pass is seconds, not milliseconds.
 *
 * Keyed by (blob, recipe) rather than by blob alone, because the settings change
 * the answer: a 640px thumbnail and a 128px one are both renditions of the same
 * picture. Both halves of the key are content-derived, so a cache entry is valid
 * forever — the bytes cannot change under a sha256 id, and the recipe changes
 * when the settings do.
 */

import type Database from "better-sqlite3";
import type { ContentPart } from "../content/types.js";
import { touchMedia } from "./queries.js";
import type { RenditionCache } from "./renditions.js";

export class SqliteRenditionCache implements RenditionCache {
  constructor(private readonly db: Database.Database) {}

  get(parentId: string, recipe: string): ContentPart[] | undefined {
    const row = this.db
      .prepare("SELECT parts FROM media_renditions WHERE parent_id = ? AND recipe = ?")
      .get(parentId, recipe) as { parts: string } | undefined;
    if (!row) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.parts);
    } catch {
      // A corrupt entry is a cache miss, not an outage: drop it and let the
      // renderer produce a fresh one.
      console.warn(`[media] rendition cache entry ${recipe} for ${parentId.slice(0, 8)} is unreadable; recomputing`);
      this.db.prepare("DELETE FROM media_renditions WHERE parent_id = ? AND recipe = ?").run(parentId, recipe);
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;

    // The whole point of the touch. Serving a rendition IS using the original,
    // and retention has no other way to know that — see `touchMedia`.
    touchMedia(this.db, parentId);
    return parsed as ContentPart[];
  }

  set(parentId: string, recipe: string, parts: ContentPart[]): void {
    this.db
      .prepare(
        `INSERT INTO media_renditions (parent_id, recipe, parts) VALUES (?, ?, ?)
         ON CONFLICT(parent_id, recipe) DO UPDATE SET parts = excluded.parts`,
      )
      .run(parentId, recipe, JSON.stringify(parts));
    touchMedia(this.db, parentId);
  }
}
