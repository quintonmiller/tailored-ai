/**
 * The voice's loudness over time, so the avatar's mouth opens on the syllables
 * and closes in the gaps. Measured from the decoded audio itself, so it works
 * with any text-to-speech stage and never touches how the audio is played.
 */

/** One loudness value per frame of this many milliseconds. */
export const ENVELOPE_FRAME_MS = 20;

/** Frames quieter than this share of the loudest one count as silence: breath and room noise. */
const SILENCE = 0.08;

/** Loudness per frame (RMS), scaled so the loudest frame is 1. */
export function envelopeOf(samples: Float32Array, sampleRate: number): Float32Array {
  const frame = Math.max(1, Math.round((sampleRate * ENVELOPE_FRAME_MS) / 1000));
  const out = new Float32Array(Math.ceil(samples.length / frame));
  let loudest = 0;
  for (let f = 0; f < out.length; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i];
    out[f] = Math.sqrt(sum / Math.max(1, end - f * frame));
    loudest = Math.max(loudest, out[f]);
  }
  if (loudest === 0) return out;
  for (let f = 0; f < out.length; f++) {
    const v = out[f] / loudest;
    out[f] = v < SILENCE ? 0 : v;
  }
  return out;
}

/** Loudness `seconds` into the clip; silence before it starts and after it ends. */
export function loudnessAt(envelope: Float32Array, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return envelope[Math.floor((seconds * 1000) / ENVELOPE_FRAME_MS)] ?? 0;
}

/** Decode one clip and measure it; null when this browser can't decode it. */
export async function decodeEnvelope(bytes: Uint8Array): Promise<Float32Array | null> {
  if (typeof OfflineAudioContext === "undefined") return null;
  try {
    // Decoding needs no running audio context and no user gesture, unlike playback.
    const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes.slice().buffer);
    return envelopeOf(audio.getChannelData(0), audio.sampleRate);
  } catch {
    return null;
  }
}
