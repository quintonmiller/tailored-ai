/**
 * Read a screenplay off disk instead of making the model retype it.
 *
 * A long script is already a file by the time anybody wants it spoken — an
 * agent wrote it, or a person did. Requiring it back as a JSON array in a tool
 * call puts the model in the middle of its own output: a 113-line script has to
 * be transcribed perfectly into `script[]`, every line, or the recording is
 * subtly wrong in a way only listening reveals. Observed directly: an agent
 * spent turn after turn reading a 6.8 KB script back in fragments through
 * `exec`, and never reached the point of speaking it.
 *
 * With a path, the model supplies only what it actually knows — which voice
 * each character should have — and the text travels as text.
 */

/** One parsed line of dialogue. */
export interface ParsedTurn {
  speaker: string;
  text: string;
}

export interface ParsedScript {
  turns: ParsedTurn[];
  /** Distinct speakers, in first-appearance order — the casting list. */
  cast: string[];
  /**
   * Lines that are not dialogue: act headings, scene notes, blank space.
   * Counted rather than silently dropped, so a script that parses to half its
   * length says so instead of quietly recording half a show.
   */
  skipped: string[];
}

// A speaker label is short, starts with a letter, and ends at the first colon.
// Bounded deliberately: without a length cap any sentence containing a colon
// ("The rule is simple: don't open the case") parses as a speaker named
// "The rule is simple", which then fails casting with a baffling message.
const LINE = /^([A-Za-z][A-Za-z0-9 _'.-]{0,31}?)\s*:\s*(\S.*)$/;

export function parseScript(source: string): ParsedScript {
  const turns: ParsedTurn[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  const cast: string[] = [];

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LINE.exec(line);
    if (!m) {
      skipped.push(line);
      continue;
    }
    const speaker = m[1].trim();
    const text = m[2].trim();
    if (!speaker || !text) {
      skipped.push(line);
      continue;
    }
    // Consecutive lines from one speaker are one utterance: a paragraph break
    // in a script is not a pause worth re-priming the voice for, and joining
    // them keeps prosody continuous across it.
    const last = turns.at(-1);
    if (last && last.speaker === speaker) {
      last.text = `${last.text} ${text}`;
    } else {
      turns.push({ speaker, text });
    }
    if (!seen.has(speaker)) {
      seen.add(speaker);
      cast.push(speaker);
    }
  }
  return { turns, cast, skipped };
}
