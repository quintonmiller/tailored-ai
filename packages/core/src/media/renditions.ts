/**
 * What the model actually sees when a picture arrives.
 *
 * An image reaching an agent had exactly two fates: hydrated to bytes and sent
 * as an image part, or flattened to its text placeholder because the model
 * declared it cannot take pictures. Both are chosen by *capability*, and there
 * are good reasons to choose by preference instead — image tokens are
 * expensive, a screenshot of a terminal is mostly text, a small local model may
 * read OCR output better than the picture, and sometimes a path is all an agent
 * needs because its next move is a shell command.
 *
 * A rendition is that choice. It answers one question — given a reference, what
 * does the model receive — and the answer is {@link ContentPart}s, which is
 * already a union of text and media. That union is what makes a single
 * interface cover behaviours that look unrelated:
 *
 * | Strategy        | Returns                                             |
 * |-----------------|-----------------------------------------------------|
 * | OCR             | one text part                                        |
 * | path / URL only | one text part                                        |
 * | resize          | one media part, smaller bytes                        |
 * | describe        | one text part, from another model                    |
 * | cheap + handle  | a media part AND a text part naming the original id  |
 *
 * Core ships the seam and no strategy. Every one of the above is a plugin, for
 * the reason CLAUDE.md gives: a resize needs an image library, an OCR pass needs
 * a WASM blob, and a describing rendition needs somebody's API — none of which
 * core should learn the name of.
 *
 * **Renditions do not rewrite history.** They shape the outbound request, the
 * same way {@link import("../providers/capabilities.js").adaptForCapabilities}
 * and {@link import("./hydrate.js").hydrateMedia} do. The session keeps the
 * original reference, so changing configuration changes what the next round
 * shows without rewriting what the last one saw, and an operator who turns a
 * rendition off gets their pictures back.
 */

import { createHash } from "node:crypto";
import type { ContentPart, MediaRef, MessageContent } from "../content/types.js";
import { contentParts } from "../content/types.js";
import type { Message } from "../providers/interface.js";
import { Registry } from "../registry.js";
import type { MediaStore } from "./interface.js";

/** What a rendition is given. */
export interface RenditionContext {
  /** The store holding the original, and where derived bytes belong. */
  store: MediaStore;
  /**
   * The original bytes, read at most once and only if asked.
   *
   * Lazy because the cheapest renditions never need them: a path-only
   * rendition answers from the ref alone, and reading a 4 MB screenshot to
   * print its filename would be the most expensive no-op in the loop.
   */
  bytes(): Promise<Buffer>;
  /** This rendition's config, verbatim. Core never looks inside. */
  options: Record<string, unknown>;
}

export interface MediaRendition {
  /**
   * What the model receives instead of the raw part.
   *
   * Returning `[{ type: "media", media: ref }]` unchanged is a valid answer and
   * means "pass it through". Returning `[]` drops the part entirely, which is
   * legal and almost never what anyone wants — prefer a text part saying what
   * was there, so the model is told rather than quietly shortchanged.
   */
  render(ref: MediaRef, ctx: RenditionContext): Promise<ContentPart[]>;
}

export interface MediaRenditionFactoryContext {
  /** `media.renditions.<id>.options` from config, verbatim. */
  options: Record<string, unknown>;
}

export type MediaRenditionFactory = (ctx: MediaRenditionFactoryContext) => MediaRendition;

const registry = new Registry<MediaRenditionFactory>("media-rendition");

export function registerMediaRenditionFactory(id: string, factory: MediaRenditionFactory) {
  return registry.register(id, factory);
}

export function listMediaRenditionFactories(): string[] {
  return registry.list();
}

/**
 * Build a rendition, or undefined when nobody registered that id.
 *
 * Undefined rather than a silent pass-through: naming a transform no plugin
 * provides is a misconfiguration, and the caller should say so out loud. A
 * deployment that wants pictures untouched configures nothing at all.
 */
export function resolveMediaRendition(id: string, options: Record<string, unknown> = {}): MediaRendition | undefined {
  const factory = registry.get(id);
  return factory ? factory({ options }) : undefined;
}

/**
 * Cache key for one (transform, settings) pair.
 *
 * The options are part of it because they change the answer: a 640px thumbnail
 * and a 128px one are different renditions of the same blob, and keying on the
 * transform id alone would serve whichever ran first for the rest of time.
 * Sorted so two configs that differ only in key order share a cache entry.
 */
export function recipeFor(transformId: string, options: Record<string, unknown>): string {
  const canonical = JSON.stringify(options, Object.keys(options).sort());
  return `${transformId}:${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

/** A rendition plus the identity its cache entries are filed under. */
export interface ResolvedRendition {
  rendition: MediaRendition;
  recipe: string;
}

/**
 * Replace every media part in `messages` with what the rendition returns.
 *
 * Runs once per round, before hydration, for the reason hydration itself gives:
 * the history is re-sent every round and a fallback chain sends the same
 * history to each candidate. Doing this per rung instead would re-run an OCR
 * pass for every fallback attempt, and would also have to re-hydrate, since a
 * rendition can mint bytes that did not exist when the round started.
 *
 * A rendition that throws leaves its part alone. That is the deliberate
 * failure mode: a broken OCR plugin should cost the agent its text extraction,
 * not its picture and not its turn.
 */
export async function applyRenditions(
  messages: readonly Message[],
  resolved: ResolvedRendition,
  ctx: { store: MediaStore; options: Record<string, unknown>; cache?: RenditionCache },
): Promise<Message[]> {
  let changed = false;
  const out: Message[] = [];

  for (const msg of messages) {
    const parts = contentParts(msg.content);
    if (!parts.some((p) => p.type === "media")) {
      out.push(msg);
      continue;
    }

    const rendered: ContentPart[] = [];
    for (const part of parts) {
      if (part.type !== "media") {
        rendered.push(part);
        continue;
      }
      const replacement = await renderOne(part.media, resolved, ctx);
      if (replacement) {
        rendered.push(...replacement);
        changed = true;
      } else {
        rendered.push(part);
      }
    }

    out.push(changed ? { ...msg, content: { parts: rendered } satisfies MessageContent } : msg);
  }

  return changed ? out : [...messages];
}

async function renderOne(
  ref: MediaRef,
  resolved: ResolvedRendition,
  ctx: { store: MediaStore; options: Record<string, unknown>; cache?: RenditionCache },
): Promise<ContentPart[] | undefined> {
  const hit = ctx.cache?.get(ref.id, resolved.recipe);
  if (hit) return hit;

  try {
    let loaded: Buffer | undefined;
    const parts = await resolved.rendition.render(ref, {
      store: ctx.store,
      options: ctx.options,
      bytes: async () => {
        if (loaded) return loaded;
        const found = await ctx.store.get(ref.id);
        if (!found) throw new Error(`media ${ref.id.slice(0, 8)} is referenced but not in the store`);
        loaded = found.bytes;
        return loaded;
      },
    });
    ctx.cache?.set(ref.id, resolved.recipe, parts);
    return parts;
  } catch (err) {
    // Loud, and then carry on with the original. A rendition is an optimisation
    // — losing it should cost quality, never the turn.
    console.warn(`[media] rendition ${resolved.recipe} failed for ${ref.id.slice(0, 8)}: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Where a computed rendition is remembered.
 *
 * Synchronous because the only implementation is SQLite, and the loop's media
 * step is already the one place that awaits. Optional throughout: a caller
 * without a database still works, and pays for every render.
 */
export interface RenditionCache {
  get(parentId: string, recipe: string): ContentPart[] | undefined;
  set(parentId: string, recipe: string, parts: ContentPart[]): void;
}
