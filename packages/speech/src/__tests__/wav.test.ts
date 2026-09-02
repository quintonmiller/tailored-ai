/**
 * Joining audio, which is the part that fails silently.
 *
 * Every assertion here is about something a "did we get bytes back" test
 * would pass: a header claiming the wrong length, samples lost to a
 * metadata chunk, two turns at different sample rates glued together.
 */
import { describe, expect, it } from "vitest";
import { concatWav, isWav, wavDurationMs } from "../wav.js";

/** A minimal but real WAV: 44-byte canonical header plus PCM. */
function wav(samples: Buffer, { sampleRate = 24_000, channels = 1, bits = 16 } = {}): Buffer {
  const byteRate = (sampleRate * channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, samples]);
}

/** The same file with a LIST chunk wedged between `fmt ` and `data`. */
function wavWithMetadata(samples: Buffer): Buffer {
  const plain = wav(samples);
  const fmtEnd = 36;
  const listBody = Buffer.from("INFOhello!!!", "ascii"); // 12 bytes, even
  const list = Buffer.alloc(8 + listBody.byteLength);
  list.write("LIST", 0, "ascii");
  list.writeUInt32LE(listBody.byteLength, 4);
  listBody.copy(list, 8);
  const out = Buffer.concat([plain.subarray(0, fmtEnd), list, plain.subarray(fmtEnd)]);
  out.writeUInt32LE(out.byteLength - 8, 4);
  return out;
}

const A = Buffer.alloc(480, 0x11);
const B = Buffer.alloc(960, 0x22);

describe("isWav", () => {
  it("accepts a RIFF/WAVE file", () => expect(isWav(wav(A))).toBe(true));
  it("rejects an mp3", () => expect(isWav(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe(false));
  it("rejects a buffer too short to hold the magic", () => expect(isWav(Buffer.from("RIF"))).toBe(false));
});

describe("concatWav", () => {
  it("keeps every sample from every input", () => {
    const out = concatWav([wav(A), wav(B)]);
    const { data } = split(out);
    expect(data.byteLength).toBe(A.byteLength + B.byteLength);
    expect(data.subarray(0, A.byteLength).equals(A)).toBe(true);
    expect(data.subarray(A.byteLength).equals(B)).toBe(true);
  });

  it("rewrites both length fields, so players report the joined duration", () => {
    const out = concatWav([wav(A), wav(B)]);
    // The bug this pins: leaving the first file's sizes in place yields a
    // file that plays only the first turn in most players.
    expect(out.readUInt32LE(4)).toBe(out.byteLength - 8);
    const { dataSize, data } = split(out);
    expect(dataSize).toBe(data.byteLength);
  });

  it("does not mistake a metadata chunk for samples", () => {
    // A fixed 44-byte slice would prepend the LIST bytes to the audio as a
    // burst of noise, and the file would still play.
    const out = concatWav([wavWithMetadata(A), wav(B)]);
    const { data } = split(out);
    expect(data.byteLength).toBe(A.byteLength + B.byteLength);
    expect(data.subarray(0, A.byteLength).equals(A)).toBe(true);
  });

  it("refuses inputs whose formats disagree", () => {
    // Joining these would play turn two at half speed and an octave down.
    expect(() => concatWav([wav(A, { sampleRate: 24_000 }), wav(B, { sampleRate: 48_000 })])).toThrow(
      /different audio format/,
    );
  });

  it("survives a streamed file whose declared data size is a placeholder", () => {
    const streamed = wav(A);
    streamed.writeUInt32LE(0xffffffff, 40);
    const out = concatWav([streamed, wav(B)]);
    expect(split(out).data.byteLength).toBe(A.byteLength + B.byteLength);
  });

  it("refuses an empty list rather than emitting a headerless file", () => {
    expect(() => concatWav([])).toThrow(/nothing to join/);
  });
});

describe("wavDurationMs", () => {
  it("reads duration from the header", () => {
    // 24 kHz, mono, 16-bit → 48,000 bytes per second. 48,000 samples = 1s.
    expect(wavDurationMs(wav(Buffer.alloc(48_000)))).toBe(1000);
  });

  it("returns undefined for something that is not a wav", () => {
    expect(wavDurationMs(Buffer.from([0xff, 0xfb]))).toBeUndefined();
  });
});

/** Re-parse an output file the way a player would. */
function split(bytes: Buffer): { data: Buffer; dataSize: number } {
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "data") return { data: bytes.subarray(offset + 8, offset + 8 + size), dataSize: size };
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in output");
}
