/**
 * Encoding message content into, and out of, the single `messages.content`
 * TEXT column.
 *
 * One column, not two. The objection to a duplicated API field applies just as
 * well to storage: denormalizing the table to dodge a type problem would be the
 * same mistake wearing a hat.
 *
 * Existing rows therefore need **no rewrite**. A plain string is stored
 * verbatim, exactly as before; only the object arm is JSON-encoded. On read we
 * attempt a parse and accept the result *only* if it strictly matches the
 * encoded shape, falling back to "this row is a plain string". That keeps the
 * migration free for a live `agent.db` holding thousands of sessions.
 *
 * The residual ambiguity is a legacy message whose literal text happens to be a
 * valid encoded envelope. {@link ENCODED_MARKER} exists to make that
 * essentially impossible: a real message would have to contain a key no human
 * writes by accident, and {@link decodeMessageContent} validates every part
 * before trusting it.
 */

import { type ContentPart, isMessageContent, type MediaRef, type MessageContent, messageText } from "./types.js";

/**
 * Discriminator written into every encoded row.
 *
 * Without it, a message whose text is literally `{"parts":[...]}` would decode
 * as structured content. With it, the collision requires a message that is
 * valid JSON *and* carries this exact key — which is the difference between
 * "unlikely" and "someone is doing it on purpose".
 */
export const ENCODED_MARKER = "__tai_content";

interface EncodedContent {
  [ENCODED_MARKER]: 1;
  parts: ContentPart[];
}

/**
 * Content as it goes into the `content` column.
 *
 * `null` stays `null`; a string stays that exact string (so every row written
 * before media existed still round-trips byte-for-byte); the object arm becomes
 * JSON.
 */
export function encodeMessageContent(content: string | MessageContent | null | undefined): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;
  // A parts array holding nothing but text is stored as plain text: it reads
  // the same to every consumer, keeps the column greppable, and avoids
  // encoding rows that gain nothing from it.
  if (!content.parts.some((p) => p.type === "media")) {
    return messageText(content);
  }
  const payload: EncodedContent = { [ENCODED_MARKER]: 1, parts: content.parts };
  return JSON.stringify(payload);
}

/** Content as it comes out of the `content` column. */
export function decodeMessageContent(raw: string | null | undefined): string | MessageContent | null {
  if (raw === null || raw === undefined) return null;
  // Cheap reject before paying for a parse: every encoded row starts with `{`
  // and names the marker.
  if (raw.length < 2 || raw[0] !== "{" || !raw.includes(ENCODED_MARKER)) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof parsed !== "object" || parsed === null) return raw;
  const candidate = parsed as Record<string, unknown>;
  if (candidate[ENCODED_MARKER] !== 1) return raw;
  if (!isMessageContent(candidate)) return raw;
  const parts = candidate.parts.filter(isValidPart);
  // A row that claimed to be encoded but holds nothing we recognize is more
  // honestly surfaced as its own raw text than as an empty message.
  if (parts.length === 0) return raw;
  return { parts };
}

function isValidPart(part: unknown): part is ContentPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  if (p.type === "text") return typeof p.text === "string";
  if (p.type === "media") return isValidMediaRef(p.media);
  return false;
}

function isValidMediaRef(ref: unknown): ref is MediaRef {
  if (typeof ref !== "object" || ref === null) return false;
  const r = ref as Record<string, unknown>;
  return typeof r.id === "string" && r.id.length > 0 && typeof r.mimeType === "string" && typeof r.bytes === "number";
}
