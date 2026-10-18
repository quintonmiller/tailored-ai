/**
 * The loudness envelope the avatar's mouth follows: loud where the voice is,
 * silent in the gaps and outside the clip.
 */
import { describe, expect, it } from "vitest";
import { ENVELOPE_FRAME_MS, envelopeOf, loudnessAt } from "./envelope";

const RATE = 8000;

/** `seconds` of a tone at `amplitude`. */
function tone(seconds: number, amplitude: number): number[] {
  return Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amplitude * Math.sin(i / 3));
}

describe("envelopeOf", () => {
  it("has one value per frame, the loudest scaled to 1", () => {
    const envelope = envelopeOf(Float32Array.from([...tone(0.1, 0.2), ...tone(0.1, 0.5)]), RATE);
    expect(envelope.length).toBe(Math.ceil(200 / ENVELOPE_FRAME_MS));
    expect(Math.max(...envelope)).toBeCloseTo(1, 5);
    expect(envelope[0]).toBeCloseTo(0.4, 1);
  });

  it("reads breath and room noise as silence", () => {
    const envelope = envelopeOf(Float32Array.from([...tone(0.1, 0.5), ...tone(0.1, 0.01)]), RATE);
    expect(envelope[envelope.length - 1]).toBe(0);
  });

  it("is all zeros for a silent clip", () => {
    expect([...envelopeOf(new Float32Array(RATE), RATE)].every((v) => v === 0)).toBe(true);
  });
});

describe("loudnessAt", () => {
  const envelope = envelopeOf(Float32Array.from([...tone(0.1, 0), ...tone(0.1, 0.5)]), RATE);

  it("reads the frame that time falls in", () => {
    expect(loudnessAt(envelope, 0.05)).toBe(0);
    expect(loudnessAt(envelope, 0.15)).toBeGreaterThan(0.9);
  });

  it("is silent before the clip, after it, and for a time it can't read", () => {
    expect(loudnessAt(envelope, -1)).toBe(0);
    expect(loudnessAt(envelope, 5)).toBe(0);
    expect(loudnessAt(envelope, Number.NaN)).toBe(0);
  });
});
