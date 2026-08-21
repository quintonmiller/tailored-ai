/**
 * Message and tool-result content that is not necessarily text.
 *
 * See `docs/media-design.md` for the reasoning. Two decisions from it are
 * load-bearing here and should not be "simplified" away:
 *
 * 1. **One `media` part carrying a mime type**, rather than separate `image` /
 *    `audio` / `video` / `document` variants. Adding a modality must not mean
 *    editing a union in core. Use {@link mediaKind} when you need the category.
 *
 * 2. **The non-string arm of the content union is an OBJECT**
 *    ({@link MessageContent}), not a bare `ContentPart[]`. This is deliberate
 *    and it is the whole reason the migration was safe: `string` and `Array`
 *    share `.length`, `.slice`, `.indexOf` and `.includes`, so a bare array arm
 *    type-checks at every existing read site and silently misbehaves —
 *    `estimateTokens` would have returned a *part count* instead of a character
 *    count, and the compaction transcript would have serialized
 *    `[object Object]`. Measured: widening to `string | ContentPart[] | null`
 *    produced exactly one compile error across all of `packages/core`. The
 *    object wrapper turns those silent wrongs into compile errors.
 */

/** A pointer to bytes held by a {@link import("../media/interface.js").MediaStore}. */
export interface MediaRef {
  /**
   * Content address: the sha256 of the bytes, hex, lowercase.
   *
   * Hashed rather than random on purpose, for the same reason
   * `agent/tool-output.ts` hashes capped tool output: the loop's stuck-model
   * detector compares consecutive tool results verbatim, so a per-capture
   * unique id would make two identical screenshots compare unequal and quietly
   * disable that guard. Hashing also dedupes — the same payload stored twice is
   * one blob.
   */
  id: string;
  /** IANA media type, e.g. `image/png`. Resolved from the bytes, not trusted from a caller. */
  mimeType: string;
  /** Size of the stored bytes. */
  bytes: number;
  /** Human-facing label, used in the text projection and as a download filename. */
  name?: string;
  /** Pixel dimensions, when known. Lets a surface lay out without fetching bytes. */
  width?: number;
  height?: number;
  /**
   * Where the bytes are when they are NOT in the media store — an https URL a
   * provider may fetch itself. Unset means "ask the store".
   */
  url?: string;
}

export type ContentPart = { type: "text"; text: string } | { type: "media"; media: MediaRef; alt?: string };

/**
 * The non-string arm of {@link import("../providers/interface.js").Message}'s
 * `content`. An object rather than a bare array — see the note at the top of
 * this file; it is not stylistic.
 */
export interface MessageContent {
  parts: ContentPart[];
}

/** The non-string arm of {@link import("../tools/interface.js").ToolResult}'s `output`. */
export interface ToolOutput {
  parts: ContentPart[];
  /**
   * Machine-readable result, when the tool has one. Mirrors MCP's
   * `structuredContent`: it is NOT a separate channel to the model (models take
   * text and media), but event subscribers, the UI and workflow steps should
   * read it instead of re-parsing prose out of the text projection.
   */
  structured?: unknown;
}

export type MediaKind = "image" | "audio" | "video" | "document" | "other";

/**
 * Category for a mime type. Deliberately derived rather than stored, so a new
 * modality is a new mime type and not a new part variant.
 */
export function mediaKind(mimeType: string): MediaKind {
  const type = mimeType.toLowerCase().split(";")[0].trim();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf" || type.startsWith("text/") || type.startsWith("application/")) return "document";
  return "other";
}

export function isMessageContent(value: unknown): value is MessageContent {
  return typeof value === "object" && value !== null && Array.isArray((value as MessageContent).parts);
}

export function isToolOutput(value: unknown): value is ToolOutput {
  return typeof value === "object" && value !== null && Array.isArray((value as ToolOutput).parts);
}

/** Convenience constructors, so callers rarely hand-write a part literal. */
export function textPart(text: string): ContentPart {
  return { type: "text", text };
}

export function mediaPart(media: MediaRef, alt?: string): ContentPart {
  return alt === undefined ? { type: "media", media } : { type: "media", media, alt };
}

/**
 * How a media part reads on a surface that cannot show it.
 *
 * A placeholder is a *rendering*, never a transport: nothing parses this back
 * out of text to reconstruct a part. The short id makes two renderings of the
 * same blob compare equal, which is what keeps the repeat detector working.
 */
export function mediaPlaceholder(media: MediaRef, alt?: string): string {
  const bits: string[] = [media.name ?? mediaKind(media.mimeType)];
  if (media.width && media.height) bits.push(`${media.width}×${media.height}`);
  bits.push(media.mimeType);
  const label = alt ? `${bits.join(" ")} — ${alt}` : bits.join(" ");
  return `[${mediaKind(media.mimeType)}: ${label} #${media.id.slice(0, 8)}]`;
}

/** Flatten parts to text. The one place a projection is defined. */
export function partsToText(parts: readonly ContentPart[]): string {
  return parts
    .map((p) => (p.type === "text" ? p.text : mediaPlaceholder(p.media, p.alt)))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Text projection of a message's content.
 *
 * A function over the single source of truth rather than a stored field — a
 * stored projection can go stale, this cannot. Every site that legitimately
 * only wants text (logging, excerpts, the compaction transcript, search) calls
 * this and says so at the call site.
 */
export function messageText(content: string | MessageContent | null | undefined): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return partsToText(content.parts);
}

/** Text projection of a tool result's output. */
export function toolOutputText(output: string | ToolOutput | null | undefined): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  const text = partsToText(output.parts);
  if (output.structured === undefined) return text;
  const encoded = safeStringify(output.structured);
  return text ? `${text}\n${encoded}` : encoded;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Every part of a content value, normalizing the string shorthand. */
export function contentParts(content: string | MessageContent | null | undefined): ContentPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [textPart(content)] : [];
  return content.parts;
}

export function toolOutputParts(output: string | ToolOutput | null | undefined): ContentPart[] {
  if (output === null || output === undefined) return [];
  if (typeof output === "string") return output ? [textPart(output)] : [];
  return output.parts;
}

/** True when this value carries at least one non-text part. */
export function hasMedia(content: string | MessageContent | ToolOutput | null | undefined): boolean {
  if (content === null || content === undefined || typeof content === "string") return false;
  return content.parts.some((p) => p.type === "media");
}

/** Every media ref referenced by a content value, in order. */
export function mediaRefs(content: string | MessageContent | ToolOutput | null | undefined): MediaRef[] {
  if (content === null || content === undefined || typeof content === "string") return [];
  return content.parts.flatMap((p) => (p.type === "media" ? [p.media] : []));
}
