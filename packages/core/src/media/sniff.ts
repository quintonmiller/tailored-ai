/**
 * Resolve a media type from the bytes themselves.
 *
 * A caller's declared type is a claim, not evidence: an upload saying
 * `image/png` over HTML, or over four gigabytes, decides nothing. So the ladder
 * is: sniff the bytes → fall back to the caller's declaration → fail with a
 * message that names why, rather than guessing. That ordering is borrowed from
 * the Vercel AI SDK's `resolveFullMediaType`, which reaches the same conclusion
 * and additionally *recovers* the type from a data URL rather than trusting the
 * part that carried it.
 *
 * Deliberately a small magic-byte table rather than a dependency. The formats
 * below are the ones a model can actually consume today; anything else falls
 * through to the declared type, which is the honest answer for a store that
 * holds arbitrary attachments.
 */

export interface SniffResult {
  mimeType: string;
  width?: number;
  height?: number;
}

/** Thrown when neither the bytes nor the caller identify the payload. */
export class UnknownMediaTypeError extends Error {
  constructor() {
    super(
      "Could not determine a media type: the bytes match no known signature and no mimeType was supplied. " +
        "Pass an explicit mimeType if you know it.",
    );
    this.name = "UnknownMediaTypeError";
  }
}

function startsWith(buf: Buffer, sig: number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((byte, i) => buf[offset + i] === byte);
}

/**
 * PNG dimensions live in the IHDR chunk at a fixed offset — cheap and exact.
 * Knowing them lets a surface reserve layout without fetching the blob.
 */
function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 10) return undefined;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** JPEG stores size in a start-of-frame marker whose position varies; walk the segments. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    const marker = buf[offset + 1];
    // SOF0..SOF15, excluding the non-frame markers DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return undefined;
}

/**
 * Best-effort type and dimensions for a payload.
 *
 * `declared` is used only when the bytes are unrecognized — never to override a
 * confident match, since that is exactly the case an attacker controls.
 */
export function sniffMedia(bytes: Buffer, declared?: string): SniffResult {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", ...pngSize(bytes) };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", ...jpegSize(bytes) };
  }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { mimeType: "image/gif", ...gifSize(bytes) };
  }
  // RIFF....WEBP
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mimeType: "image/webp" };
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { mimeType: "application/pdf" };
  }
  // ftyp box at offset 4 — mp4 and friends.
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return { mimeType: "video/mp4" };
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { mimeType: "audio/ogg" };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
    return { mimeType: "audio/wav" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mimeType: "video/webm" };
  }
  if (declared) return { mimeType: declared };
  throw new UnknownMediaTypeError();
}

/** Extension for a stored blob, used only to make on-disk files openable by hand. */
export function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
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
    "text/plain": "txt",
  };
  return map[mimeType.toLowerCase().split(";")[0].trim()] ?? "bin";
}
