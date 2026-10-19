/**
 * Playing the agent's cues at the right moment. The server sends each cue
 * with the `seq` of the sentence it comes before, ahead of that sentence's
 * audio: a wave written before "Hi" plays as "Hi" starts. A cue after the
 * last sentence plays once the speech is over, or at once when there was
 * none, as in a reply that is only `<go to="the couch"/>`.
 */

export interface Cue {
  name: string;
  target?: string;
}

export class CueTimeline {
  private waiting = new Map<number, Cue[]>();
  private done = false;
  private speaking = false;

  constructor(private readonly play: (cue: Cue) => void) {}

  /** A new turn, or the person cut in: nothing from before still plays. */
  reset() {
    this.waiting.clear();
    this.done = false;
  }

  /** A cue arrived, for the sentence numbered `seq`. */
  cue(cue: Cue & { seq: number }) {
    const { seq, ...rest } = cue;
    this.waiting.set(seq, [...(this.waiting.get(seq) ?? []), rest]);
  }

  /** Sentence `seq` has started playing. */
  started(seq: number) {
    this.speaking = true;
    for (const [s, cues] of [...this.waiting].sort(([a], [b]) => a - b)) {
      if (s > seq) break;
      // One for an earlier sentence that never played (it was empty, or failed) goes now too.
      this.waiting.delete(s);
      for (const c of cues) this.play(c);
    }
  }

  /** The speech has gone quiet. Once the turn is done, whatever is left plays. */
  quiet() {
    this.speaking = false;
    if (this.done) this.flush();
  }

  /** The turn's reply is complete. */
  finished() {
    this.done = true;
    if (!this.speaking) this.flush();
  }

  private flush() {
    for (const [, cues] of [...this.waiting].sort(([a], [b]) => a - b)) for (const c of cues) this.play(c);
    this.waiting.clear();
  }
}
