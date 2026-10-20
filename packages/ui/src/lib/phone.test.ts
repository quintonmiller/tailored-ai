import { describe, expect, it } from "vitest";
import { lineVolume, PHONE, type PhoneParts, phoneLine } from "./phone";

/** A stand-in AudioContext: nodes that remember their settings and what they were connected to. */
function fakeContext() {
  const made: { kind: string; node: Record<string, unknown> & { to: unknown[] } }[] = [];
  const param = (value = 0) => ({ value });
  const node = (kind: string, extra: Record<string, unknown>) => {
    const n = {
      ...extra,
      to: [] as unknown[],
      connect(next: unknown) {
        n.to.push(next);
        return next;
      },
    };
    made.push({ kind, node: n });
    return n;
  };
  const ctx = {
    createBiquadFilter: () => node("filter", { type: "lowpass", frequency: param(350), Q: param(1), gain: param() }),
    createDynamicsCompressor: () =>
      node("compressor", {
        threshold: param(-24),
        knee: param(30),
        ratio: param(12),
        attack: param(0.003),
        release: param(0.25),
      }),
    createGain: () => node("gain", { gain: param(1) }),
  };
  return { ctx: ctx as unknown as PhoneParts, made };
}

const settings = (n: unknown) => n as Record<string, { value: number } | string | unknown[]>;

describe("a voice down the phone", () => {
  it("goes through the phone's band, cut at both ends, lifted in the middle, squeezed and turned down", () => {
    const { ctx, made } = fakeContext();
    const input = { to: [] as unknown[], connect: (n: unknown) => input.to.push(n) };
    const output = { name: "speakers" };
    const chain = phoneLine(ctx, input as unknown as AudioNode, output as unknown as AudioNode, 0.5);
    const [high, low, middle, squeeze, level] = chain.map(settings);
    expect(high.type).toBe("highpass");
    expect((high.frequency as { value: number }).value).toBe(PHONE.low);
    expect(low.type).toBe("lowpass");
    expect((low.frequency as { value: number }).value).toBe(PHONE.high);
    expect(middle.type).toBe("peaking");
    expect((middle.gain as { value: number }).value).toBeGreaterThan(0);
    expect((squeeze.ratio as { value: number }).value).toBe(PHONE.compressor.ratio);
    expect((level.gain as { value: number }).value).toBe(0.5);
    // In that order, from what plays to the speakers, each into the next and nowhere else.
    expect(input.to).toEqual([chain[0]]);
    for (let i = 0; i < chain.length - 1; i++) expect(settings(chain[i]).to).toEqual([chain[i + 1]]);
    expect(settings(chain.at(-1)).to).toEqual([output]);
    expect(made).toHaveLength(5);
  });

  it("keeps to the band a telephone carries", () => {
    expect(PHONE.low).toBeGreaterThanOrEqual(250);
    expect(PHONE.low).toBeLessThanOrEqual(400);
    expect(PHONE.high).toBeGreaterThanOrEqual(3000);
    expect(PHONE.high).toBeLessThanOrEqual(4000);
    expect(PHONE.presence.frequency).toBeGreaterThan(PHONE.low);
    expect(PHONE.presence.frequency).toBeLessThan(PHONE.high);
  });

  it("plays a line quieter the further off it is, and the far side of a call quieter than a voice in the room", () => {
    expect(lineVolume(1, false)).toBe(1);
    expect(lineVolume(0.5, false)).toBe(0.5);
    expect(lineVolume(1, true)).toBe(PHONE.level);
    expect(lineVolume(0.5, true)).toBeLessThan(lineVolume(0.5, false));
    // Never silent once it is heard at all, and never louder than full.
    expect(lineVolume(0, false)).toBeGreaterThan(0);
    expect(lineVolume(0, true)).toBeGreaterThan(0);
    expect(lineVolume(3, false)).toBe(1);
  });
});
