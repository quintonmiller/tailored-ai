/**
 * The wire shape of message content, mirrored for the UI.
 *
 * Deliberately a copy rather than an import from `@tailored-ai/core`: this
 * package talks to the server over HTTP and takes no TAI dependency, which is
 * what lets the UI be replaced wholesale. The cost is that this file has to
 * track `content/types.ts`, and the fields below are the stable half of it.
 */

export interface MediaRef {
  id: string;
  mimeType: string;
  bytes: number;
  name?: string;
  width?: number;
  height?: number;
  url?: string;
}

export type ContentPart = { type: "text"; text: string } | { type: "media"; media: MediaRef; alt?: string };

export interface MessageContent {
  parts: ContentPart[];
}

export function isMessageContent(value: unknown): value is MessageContent {
  return typeof value === "object" && value !== null && Array.isArray((value as MessageContent).parts);
}

/** The text of a content value, ignoring media. */
export function contentText(content: string | MessageContent | null | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Media referenced by a content value, in order. */
export function contentMedia(content: string | MessageContent | null | undefined): MediaRef[] {
  if (!content || typeof content === "string") return [];
  return content.parts.flatMap((p) => (p.type === "media" ? [p.media] : []));
}

export function isImage(ref: MediaRef): boolean {
  return ref.mimeType.toLowerCase().startsWith("image/");
}

/**
 * Where to fetch a blob.
 *
 * A ref that carries its own URL keeps it; everything else comes from this
 * deployment's own media route, which is the only origin the CSP's `img-src`
 * admits.
 */
export function mediaSrc(ref: MediaRef): string {
  return ref.url ?? `/api/media/${ref.id}`;
}

/** Human-readable size, for the non-image attachment row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
