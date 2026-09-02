/**
 * Content parts, constructed here rather than imported from core.
 *
 * Core's plugin contract is explicitly type-only — `PluginMeta`'s own doc
 * says "plugins keep zero runtime dependency on core" — and importing
 * `mediaPart`/`textPart` as values broke it. The cost was not theoretical:
 * a plugin home pinned to an older core has no such export, and the plugin
 * fails to *load* with `does not provide an export named 'mediaPart'`. The
 * tool never registers, and the failure is at import time rather than at
 * the call, so it looks like the plugin was never configured.
 *
 * The shapes are two fields wide and are wire format, not API. `parts.test.ts`
 * asserts they stay identical to what core's constructors produce, so drift
 * fails a test here instead of silently emitting a part core will not read.
 */

/** Mirrors core's `ContentPart`. */
export type ContentPart = { type: "text"; text: string } | { type: "media"; media: MediaRefLike; alt?: string };

/**
 * The parts of core's `MediaRef` this package touches. Structural on purpose:
 * whatever `mediaStore.put()` returns is passed straight back out, so this
 * only has to be assignable, not complete.
 */
export interface MediaRefLike {
  id: string;
  mimeType: string;
  bytes: number;
  name?: string;
}

export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function mediaPart(media: MediaRefLike, alt?: string): ContentPart {
  return alt === undefined ? { type: "media", media } : { type: "media", media, alt };
}
