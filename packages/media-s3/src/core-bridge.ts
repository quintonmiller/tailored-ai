/**
 * The handful of core functions this store genuinely needs at run time.
 *
 * Every other import from core in this package is `import type`, per core's own
 * plugin contract. These five cannot be: a media store shares core's `media`
 * table, and reimplementing that SQL here would duplicate a schema that core
 * migrates.
 *
 * Exported from the package index as well as used internally, because a
 * sibling store — `@tailored-ai/media-r2` — needs the same five functions and
 * the same version check, and duplicating either would mean two places to get
 * the diagnostic wrong.
 *
 * So they are reached through a **namespace import** rather than named imports.
 * The difference matters. A named import of something the resolved core does
 * not export fails at *link* time:
 *
 *     SyntaxError: The requested module '@tailored-ai/core'
 *     does not provide an export named 'upsertMediaRow'
 *
 * which happens before `register(ctx)` runs, so the plugin contributes nothing
 * and the symptom is that the store simply is not there — indistinguishable
 * from not having configured it. That already happened once in this repo
 * (#633). A namespace import cannot fail that way, which lets
 * {@link bridgeToCore} say what is actually wrong and which version fixes it.
 */

import type { MediaRef, MediaRow } from "@tailored-ai/core";
import * as core from "@tailored-ai/core";
import type Database from "better-sqlite3";

export interface CoreBridge {
  sniffMedia(bytes: Buffer, declared?: string): { mimeType: string; width?: number; height?: number };
  upsertMediaRow(db: Database.Database, row: { ref: MediaRef; path: string; sessionId: string | null }): void;
  getMediaRow(db: Database.Database, id: string): MediaRow | undefined;
  deleteMediaRow(db: Database.Database, id: string): void;
  MediaTooLargeError: new (bytes: number, limit: number) => Error;
}

/** Names that must exist on the resolved core for this store to work. */
const REQUIRED = ["sniffMedia", "upsertMediaRow", "getMediaRow", "deleteMediaRow", "MediaTooLargeError"] as const;

export class CoreTooOldError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `@tailored-ai/media-s3 needs a newer @tailored-ai/core: it does not export ${missing.join(", ")}. ` +
        `The media row helpers became public in 0.1.11. Note the core a plugin resolves is the one in ` +
        `<TAI_HOME>/plugins/node_modules, which is a separate install from the one the runtime itself runs.`,
    );
    this.name = "CoreTooOldError";
  }
}

/**
 * Resolve the bridge, or explain precisely what is missing.
 *
 * Called at registration rather than at first use, so a version mismatch is a
 * clear line in the startup log instead of a failed media write an hour later.
 */
export function bridgeToCore(): CoreBridge {
  const mod = core as unknown as Record<string, unknown>;
  const missing = REQUIRED.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) throw new CoreTooOldError(missing);
  return mod as unknown as CoreBridge;
}

/**
 * Extension for an object key.
 *
 * Local rather than borrowed from core: the key is this store's own business —
 * core never interprets `path` — and it is only there so a human listing the
 * bucket sees `.wav` instead of a bare hash. Drift from core's map costs
 * nothing because nothing compares them.
 */
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "text/plain": "txt",
};

export function extensionFor(mimeType: string): string {
  return EXTENSIONS[mimeType.toLowerCase().split(";")[0].trim()] ?? "bin";
}
