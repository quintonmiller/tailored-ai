/**
 * Resolving media references to bytes, just before a provider call.
 *
 * Conversation history stores a reference, never a payload — that is what keeps
 * base64 out of SQLite and out of `capToolOutput`'s head/tail slice. But a
 * provider that can accept an image needs the actual bytes, and every message →
 * wire converter in the codebase is synchronous.
 *
 * So the loop hydrates once per request: collect every referenced id, fetch each
 * blob once, and hand the converters a lookup table on {@link ChatParams}. A
 * converter stays synchronous, a blob referenced by five turns is read once, and
 * nothing hydrated is ever persisted — the bytes live for the duration of the
 * request and no longer.
 *
 * This is also the seam where "the model cannot have this" is decided by
 * absence: a provider that cannot inline media simply never looks at the map,
 * and the message's text projection is what it sees.
 */

import { mediaRefs } from "../content/types.js";
import type { Message } from "../providers/interface.js";
import type { MediaStore } from "./interface.js";

/** Bytes for the media referenced by a request, keyed by {@link MediaRef.id}. */
export type HydratedMedia = ReadonlyMap<string, Buffer>;

/**
 * Fetch the bytes for every media reference in `messages`.
 *
 * Returns undefined when there is nothing to fetch, so the common text-only
 * request does no work and carries no extra field. A blob that cannot be read
 * is simply absent from the map: the converter then falls back to the text
 * projection for that part, which is the honest outcome — an image we no longer
 * hold is one the model is told about rather than one that silently becomes
 * nothing.
 */
export async function hydrateMedia(
  messages: readonly Message[],
  store: MediaStore | undefined,
): Promise<HydratedMedia | undefined> {
  if (!store) return undefined;

  const ids = new Set<string>();
  for (const msg of messages) {
    for (const ref of mediaRefs(msg.content)) {
      // A ref that carries its own URL is the provider's to fetch, not ours.
      if (!ref.url) ids.add(ref.id);
    }
  }
  if (ids.size === 0) return undefined;

  const entries = await Promise.all(
    Array.from(ids, async (id) => {
      try {
        const stored = await store.get(id);
        return stored ? ([id, stored.bytes] as const) : undefined;
      } catch {
        return undefined;
      }
    }),
  );

  const map = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry) map.set(entry[0], entry[1]);
  }
  return map.size > 0 ? map : undefined;
}
