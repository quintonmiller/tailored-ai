/**
 * Joining WAV files, because a dialogue is rendered a turn at a time.
 *
 * Only WAV. mp3 frames can be concatenated and will usually play, but the
 * result reports the duration of the first file in most players and clicks
 * at the seams in some — a defect that survives every test that checks
 * "did we get audio" and is found only by listening to the end. WAV is
 * PCM with a header, so joining it is exact.
 *
 * The alternative was to shell out to ffmpeg. That buys every format and
 * costs a host binary the deployment has to install, on a path that would
 * fail at run time rather than at config time. Not worth it for the one
 * format we control.
 */

const RIFF = 0x52494646; // "RIFF"
const WAVE = 0x57415645; // "WAVE"

export function isWav(bytes: Buffer): boolean {
  return bytes.byteLength >= 12 && bytes.readUInt32BE(0) === RIFF && bytes.readUInt32BE(8) === WAVE;
}

interface WavParts {
  /** Everything up to and including the `data` chunk header. */
  header: Buffer;
  /** The samples. */
  data: Buffer;
  /** The `fmt ` chunk body, so mismatched inputs can be refused. */
  fmt: Buffer;
}

/**
 * Walk the chunk list rather than assuming a 44-byte header. Real encoders
 * emit `LIST`/`fact`/metadata chunks before `data`, and slicing at a fixed
 * offset turns those bytes into a burst of noise at the top of the turn.
 */
function parseWav(bytes: Buffer): WavParts {
  if (!isWav(bytes)) throw new Error("not a RIFF/WAVE file");
  let offset = 12;
  let fmt: Buffer | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") fmt = bytes.subarray(body, body + size);
    if (id === "data") {
      if (!fmt) throw new Error("data chunk before fmt chunk");
      // Trust the file's length over the declared size: a streamed WAV is
      // routinely written with a placeholder size it never goes back to fix.
      const end = Math.min(body + size, bytes.byteLength);
      return { header: bytes.subarray(0, body), data: bytes.subarray(body, end), fmt };
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk");
}

/**
 * Concatenate WAV buffers into one file.
 *
 * Refuses inputs whose `fmt` chunks disagree. Two turns at different sample
 * rates joined regardless would play the second at the wrong pitch and speed
 * — audible, obviously wrong, and impossible to trace back to here.
 */
/**
 * Join rendered turns, optionally leaving a beat of silence between them.
 *
 * Without a gap the result is relentless: measured on a real episode, twelve
 * and a half minutes of dialogue contained no pause longer than eight tenths
 * of a second, and ran at 219 words per minute against an audiobook norm near
 * 150. Every speaker change landed immediately on the last syllable of the
 * one before, which reads as an argument rather than a conversation.
 *
 * The silence is written in the source's own format — same sample rate, same
 * width, same channel count — because the format check above exists precisely
 * to stop mismatched audio being spliced together.
 */
export function concatWav(files: Buffer[], gapMs = 0): Buffer {
  if (files.length === 0) throw new Error("nothing to join");
  const parsed = files.map(parseWav);
  const [first, ...rest] = parsed;

  for (const [i, part] of rest.entries()) {
    if (!part.fmt.equals(first.fmt)) {
      throw new Error(
        `turn ${i + 2} has a different audio format from turn 1 — ` + `joining them would change its pitch and speed`,
      );
    }
  }

  // `fmt `: channels at byte 2, sample rate at 4, bits per sample at 14.
  const channels = first.fmt.readUInt16LE(2);
  const sampleRate = first.fmt.readUInt32LE(4);
  const bitsPerSample = first.fmt.readUInt16LE(14);
  const frameBytes = (bitsPerSample / 8) * channels;
  const gapBytes = gapMs > 0 ? Math.round((sampleRate * gapMs) / 1000) * frameBytes : 0;
  // 8-bit PCM is unsigned with a midpoint of 128; everything wider is signed,
  // where silence is zero. Filling 8-bit with zeroes is full-scale noise.
  const silence = gapBytes > 0 ? Buffer.alloc(gapBytes, bitsPerSample === 8 ? 128 : 0) : null;

  const pieces: Buffer[] = [];
  for (const [i, part] of parsed.entries()) {
    if (silence && i > 0) pieces.push(silence);
    pieces.push(part.data);
  }
  const data = Buffer.concat(pieces);
  const header = Buffer.from(first.header); // copy: the source is a view

  // Rewrite the two sizes the header got wrong the moment we appended.
  header.writeUInt32LE(data.byteLength, header.byteLength - 4); // data chunk size
  header.writeUInt32LE(header.byteLength + data.byteLength - 8, 4); // RIFF size

  return Buffer.concat([header, data]);
}

/**
 * Duration in milliseconds, read from the header.
 *
 * `MediaRef` has nowhere to put this yet — it carries `width`/`height` and no
 * time axis (#596) — so for now it only reaches the text the tool returns.
 * That is still the difference between "audio attached" and "4 minutes of
 * audio attached".
 */
export function wavDurationMs(bytes: Buffer): number | undefined {
  try {
    const { fmt, data } = parseWav(bytes);
    if (fmt.byteLength < 16) return undefined;
    const byteRate = fmt.readUInt32LE(8);
    if (!byteRate) return undefined;
    return Math.round((data.byteLength / byteRate) * 1000);
  } catch {
    return undefined;
  }
}
