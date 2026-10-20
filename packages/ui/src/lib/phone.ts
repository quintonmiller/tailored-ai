/**
 * A voice as it sounds down a telephone line, for the far side of a call heard
 * out of the phone of an agent you stand by: only the band a phone carries
 * (about 300 to 3,400 Hz), a little edge in the middle, squeezed so the quiet
 * words come up and the loud ones don't spike, and quieter than someone in
 * the room. WebAudio nodes on the playback the page already has, so nothing
 * is rendered twice; the settings and the wiring are pure enough to test
 * without a sound card.
 */

export const PHONE = {
  /** Below this, cut: no chest in a voice down the line. */
  low: 300,
  /** Above this, cut: no air either. */
  high: 3400,
  /** How sharply each edge of the band falls away: a gentle shoulder, not a ring. */
  q: 0.8,
  /** The nasal middle a small speaker has. */
  presence: { frequency: 1800, gain: 5, q: 1.1 },
  /** Squeezed flat, as a line squeezes it. */
  compressor: { threshold: -30, knee: 8, ratio: 6, attack: 0.004, release: 0.2 },
  /** How loud the far side is next to a voice in the room, at most: an earpiece, not a mouth. */
  level: 0.7,
} as const;

/** The quietest a line you can hear at all plays at. */
const FLOOR = 0.15;

/** How loud a line plays, 0–1: nearer is louder, and down the phone no more than {@link PHONE.level} of that. */
export function lineVolume(nearness: number, phone: boolean): number {
  const near = Math.max(FLOOR, Math.min(1, nearness));
  return phone ? Math.max(FLOOR, near * PHONE.level) : near;
}

/** The parts of an AudioContext the phone line is built from: a real one, or a stand-in in a test. */
export interface PhoneParts {
  createBiquadFilter(): BiquadFilterNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  createGain(): GainNode;
}

/**
 * Wire `input` to `output` through a telephone line in `ctx`, at `volume`:
 * the band cut at both ends, the middle lifted, squeezed, then turned down.
 * Returns the nodes in the order the sound goes through them, to let go of
 * once the line has been said.
 */
export function phoneLine(ctx: PhoneParts, input: AudioNode, output: AudioNode, volume: number): AudioNode[] {
  const filter = (type: BiquadFilterType, frequency: number, q: number, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  };
  const squeeze = ctx.createDynamicsCompressor();
  const c = PHONE.compressor;
  squeeze.threshold.value = c.threshold;
  squeeze.knee.value = c.knee;
  squeeze.ratio.value = c.ratio;
  squeeze.attack.value = c.attack;
  squeeze.release.value = c.release;
  const level = ctx.createGain();
  level.gain.value = volume;
  const chain: AudioNode[] = [
    filter("highpass", PHONE.low, PHONE.q),
    filter("lowpass", PHONE.high, PHONE.q),
    filter("peaking", PHONE.presence.frequency, PHONE.presence.q, PHONE.presence.gain),
    squeeze,
    level,
  ];
  let from = input;
  for (const node of chain) {
    from.connect(node);
    from = node;
  }
  from.connect(output);
  return chain;
}
