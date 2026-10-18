/**
 * Cutting a streamed reply into sentences, so speech can start on the first
 * one while the model is still writing the rest. Text-to-speech of one short
 * sentence takes ~200 ms; waiting for the whole reply would put the model's
 * entire generation time in front of the first sound.
 */

/** Below this, a "sentence" is held back and joined to the next: "Hi." alone sounds clipped. */
const MIN_SENTENCE_CHARS = 12;

export class SentenceSplitter {
  private buffer = "";

  /** Add streamed text; returns the sentences it completed, in order. */
  push(delta: string): string[] {
    this.buffer += delta;
    const done: string[] = [];
    for (;;) {
      const end = sentenceEnd(this.buffer);
      if (end < 0) break;
      const sentence = this.buffer.slice(0, end).trim();
      if (sentence.length < MIN_SENTENCE_CHARS && end < this.buffer.length) {
        // Too short to speak alone: look for the next boundary after this one.
        const next = sentenceEnd(this.buffer, end);
        if (next < 0) break;
        done.push(speakable(this.buffer.slice(0, next)));
        this.buffer = this.buffer.slice(next);
        continue;
      }
      if (sentence) done.push(speakable(sentence));
      this.buffer = this.buffer.slice(end);
    }
    return done.filter(Boolean);
  }

  /** What is left once the reply is complete. */
  flush(): string {
    const rest = speakable(this.buffer);
    this.buffer = "";
    return rest;
  }
}

/** The index just past the first sentence boundary at or after `from`, or -1. */
function sentenceEnd(text: string, from = 0): number {
  const pattern = /([.!?…]+["')\]]*)(\s+|$)|\n\s*\n/g;
  pattern.lastIndex = from;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    const end = m.index + m[0].length;
    // A boundary at the very end may be mid-stream ("3." of "3.5"): wait for more.
    if (end >= text.length && !/\s$/.test(m[0])) return -1;
    if (/\d$/.test(text.slice(0, m.index)) && m[1] === "." && /^\d/.test(text.slice(end))) continue;
    return end;
  }
  return -1;
}

/**
 * Text as it should be read aloud: markdown marks, links and emoji removed,
 * whitespace collapsed. A model told to talk still formats now and then, and
 * a voice reading "asterisk asterisk" is worse than one that skips them.
 */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|~]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
