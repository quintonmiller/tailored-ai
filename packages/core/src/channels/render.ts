/**
 * The surface half of the degradation ladder: inline → attachment → link →
 * text projection.
 *
 * One implementation, called by every channel, because the alternative is three
 * transports each deciding independently what to do with a 30 MB video and two
 * of them deciding "drop it". The rule this enforces is the one the media
 * design states outright: **a part that does not reach the reader leaves either
 * a warning or a placeholder — never nothing, and never itself.**
 *
 * Nothing here touches bytes. It decides *what* to deliver and returns
 * references; the caller does the upload, because only the caller knows its own
 * SDK. That split is deliberate — it keeps this function pure and testable, and
 * it means a transport cannot accidentally skip the ladder by having bytes in
 * hand already.
 */

import {
  type ContentPart,
  contentParts,
  type MediaRef,
  type MessageContent,
  mediaPlaceholder,
} from "../content/types.js";
import { type SurfaceCapabilities, surfaceAccepts } from "./capabilities.js";

export interface SurfaceRendering {
  /** The text to post, placeholders and links already folded in. */
  text: string;
  /** Media the caller should upload alongside the text, in part order. */
  attachments: MediaRef[];
  /**
   * What could not be delivered as-is, and why. Empty on the happy path.
   * Callers log these; they are the audit trail that a lossy rung was taken.
   */
  warnings: string[];
}

export interface RenderOptions {
  /**
   * Resolves a media id to a URL the reader could open. Usually the HTTP API's
   * `/api/media/:id` when `media.urlBase` is configured. Returning undefined
   * drops the rung, which is why the fallback below it is unconditional.
   */
  linkFor?: (media: MediaRef) => string | undefined;
  /**
   * Largest number of items to attach. A tool that screenshots in a loop can
   * produce dozens, and a transport that accepts them will happily post
   * dozens. The overflow is reported as a warning, never silently trimmed.
   */
  maxAttachments?: number;
}

/** Attaching every screenshot a long turn produced is not a feature. */
export const DEFAULT_MAX_ATTACHMENTS = 4;

export function renderForSurface(
  content: string | MessageContent | null | undefined,
  caps: SurfaceCapabilities,
  opts: RenderOptions = {},
): SurfaceRendering {
  const parts = contentParts(content);
  const maxAttachments = opts.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS;

  const segments: string[] = [];
  const attachments: MediaRef[] = [];
  const warnings: string[] = [];
  // Deduped because content addressing makes repeats common and identical: an
  // agent that screenshots an unchanged screen three times has one blob, and
  // posting it three times is noise, not fidelity.
  const seen = new Set<string>();

  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) segments.push(part.text);
      continue;
    }
    const rendered = renderMediaPart(part, caps, opts, {
      seen,
      attachments,
      maxAttachments,
      warnings,
    });
    if (rendered) segments.push(rendered);
  }

  return { text: segments.join("\n\n").trim(), attachments, warnings };
}

interface LadderState {
  seen: Set<string>;
  attachments: MediaRef[];
  maxAttachments: number;
  warnings: string[];
}

/**
 * One media part, one rung. Returns the text that should stand in its place, or
 * undefined when the media itself carries the message and no text is needed.
 */
function renderMediaPart(
  part: Extract<ContentPart, { type: "media" }>,
  caps: SurfaceCapabilities,
  opts: RenderOptions,
  state: LadderState,
): string | undefined {
  const { media, alt } = part;

  // Rung 1 and 2: the transport takes the bytes. Inline and attachment are the
  // same delivery here and differ only in how the transport chooses to show it,
  // which is not ours to decide.
  if (surfaceAccepts(caps, media.mimeType, media.bytes)) {
    if (state.seen.has(media.id)) return undefined;
    if (state.attachments.length >= state.maxAttachments) {
      state.warnings.push(
        `${describe(media)} not attached: over the ${state.maxAttachments}-attachment limit for one message`,
      );
      return linkOrPlaceholder(media, alt, caps, opts);
    }
    state.seen.add(media.id);
    state.attachments.push(media);
    return undefined;
  }

  // Say why the bytes were refused before dropping to a weaker rung, so a
  // 30 MB screenshot silently arriving as a link is diagnosable.
  state.warnings.push(`${describe(media)} not attached: ${refusalReason(caps, media)}`);
  return linkOrPlaceholder(media, alt, caps, opts);
}

/** Rung 3 and 4. The placeholder is unconditional, which is what makes it the floor. */
function linkOrPlaceholder(
  media: MediaRef,
  alt: string | undefined,
  caps: SurfaceCapabilities,
  opts: RenderOptions,
): string {
  const placeholder = mediaPlaceholder(media, alt);
  if (!caps.links) return placeholder;
  const url = media.url ?? opts.linkFor?.(media);
  return url ? `${placeholder} ${url}` : placeholder;
}

function refusalReason(caps: SurfaceCapabilities, media: MediaRef): string {
  if (!caps.attachments && !caps.inlineMedia) return "this surface takes text only";
  if (caps.maxBytes !== undefined && media.bytes > caps.maxBytes) {
    return `${media.bytes} bytes is over the surface's ${caps.maxBytes}-byte limit`;
  }
  return `the surface does not accept ${media.mimeType}`;
}

function describe(media: MediaRef): string {
  return media.name ? `${media.name} (${media.mimeType})` : media.mimeType;
}

/**
 * A filename a transport will accept for an upload.
 *
 * Shared because Discord and Slack both need one and both would otherwise
 * invent it. The original name is used when it has an extension, since that is
 * what the recipient recognises; otherwise the content hash plus an extension
 * derived from the mime type, which is always *something* rather than a file
 * called `blob` that no viewer will open.
 *
 * The name is sanitised rather than trusted: it can come from an inbound upload
 * and therefore from anyone, and a filename with a slash in it is a filename
 * doing something other than naming a file.
 */
export function attachmentName(media: MediaRef): string {
  const ext = extensionFor(media.mimeType);
  const raw = media.name?.trim();
  if (raw) {
    const safe = raw
      // Allowlist rather than a blocklist of separators: a blocklist is a list
      // of the traversal tricks someone thought of.
      .replace(/[^A-Za-z0-9._-]/g, "_")
      // No `..` anywhere, not just at the front. Nothing downstream should have
      // to care, but a filename is passed to enough libraries that "should" is
      // doing more work than it can carry.
      .replace(/\.{2,}/g, "_")
      .replace(/^[._-]+/, "")
      .slice(0, 96);
    if (safe && /\.[A-Za-z0-9]{1,12}$/.test(safe)) return safe;
    if (safe) return `${safe}${ext}`;
  }
  return `${media.id.slice(0, 12)}${ext}`;
}

/** Enough of a mime→extension map to name a file; not a general registry. */
function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "text/plain": ".txt",
    "text/csv": ".csv",
    "application/json": ".json",
  };
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (known[base]) return known[base];
  // `image/x-thing` → `.thing`, which is a guess, but a guess that carries the
  // subtype is more useful to a recipient than no extension at all.
  const subtype = base.split("/")[1]?.replace(/^x-/, "");
  return subtype && /^[a-z0-9.+-]{1,12}$/.test(subtype) ? `.${subtype.replace(/[+.]/g, "")}` : "";
}
