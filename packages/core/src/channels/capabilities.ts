/**
 * What a render surface can actually show.
 *
 * Modelled on `RoomCapabilities` (`rooms/types.ts`), which already establishes
 * the house pattern: callers feature-detect through a struct rather than
 * duck-typing methods, so an unsupported action degrades with a clear message
 * instead of throwing a TypeError halfway through a delivery.
 *
 * The message-length caps live here too. They used to be a `MAX_MESSAGE_LENGTH`
 * constant copy-pasted into two `splitMessage` implementations — 2000 in
 * `channels/split-message.ts` for Discord, 3000 inline in the Slack package —
 * which is the same fact recorded twice with nothing keeping the copies
 * honest. A limit is a capability.
 */

import { mimeMatches } from "../providers/capabilities.js";

export interface SurfaceCapabilities {
  /**
   * The transport renders media inside the message body — a Discord attachment
   * previewing under the text, an HTML page with an `<img>`. Distinct from
   * {@link SurfaceCapabilities.attachments}: a surface can accept a file and
   * still only offer it as a download.
   */
  inlineMedia: boolean;
  /** The transport accepts uploads travelling with the message. */
  attachments: boolean;
  /** A URL in the text renders as something the reader can follow. */
  links: boolean;
  /** Longest single message the transport accepts, in characters. */
  maxMessageLength: number;
  /**
   * Largest single upload, in bytes. Absent means no known cap — which is not
   * the same as "unlimited", only "we have not been told", so nothing treats
   * absence as permission to send a gigabyte.
   */
  maxBytes?: number;
  /**
   * Mime types the transport accepts, as full types or `image/*` globs. Absent
   * means it takes anything it is given.
   */
  mimeTypes?: string[];
}

/**
 * The floor. A surface that has told us nothing gets text and nothing else,
 * because guessing wrong upward means a failed send and guessing wrong
 * downward means a placeholder — and a placeholder is recoverable.
 */
export const TEXT_ONLY_SURFACE: SurfaceCapabilities = {
  inlineMedia: false,
  attachments: false,
  links: true,
  maxMessageLength: Number.MAX_SAFE_INTEGER,
};

/**
 * Does this surface accept an item of this type and size?
 *
 * Kept separate from the ladder in `render.ts` so a caller that is about to
 * upload can ask the same question the renderer asked and get the same answer.
 */
export function surfaceAccepts(caps: SurfaceCapabilities, mimeType: string, bytes: number): boolean {
  if (!caps.attachments && !caps.inlineMedia) return false;
  if (caps.maxBytes !== undefined && bytes > caps.maxBytes) return false;
  if (!caps.mimeTypes) return true;
  // Reuses the model-side matcher rather than growing a second one. The glob
  // rules for "what a surface takes" and "what a model takes" are the same
  // rules, and two implementations of the same rules drift.
  return mimeMatches(mimeType, caps.mimeTypes);
}
