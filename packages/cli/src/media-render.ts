/**
 * The terminal's rung of the degradation ladder.
 *
 * A terminal is the honest bottom of the ladder: it cannot show an image, so it
 * gets the placeholder plus a path the reader can actually open. That is the
 * rule the media design states — a part that does not reach the reader leaves a
 * placeholder, never nothing.
 *
 * Deliberately not an image. iTerm2 and kitty both have inline-image escape
 * sequences, and emitting one to a terminal that does not understand it dumps
 * kilobytes of base64 into the user's scrollback. Detecting support means
 * sniffing `TERM_PROGRAM` and friends, guessing wrong on multiplexers, and
 * owning that guess forever. It is a real feature and it is P6's, not this
 * one's.
 */

import { type MediaRef, type MediaStore, renderForSurface, type SurfaceCapabilities } from "@tailored-ai/core";

/**
 * What a terminal can do: text and a path the reader can click or paste. No
 * bytes, so the ladder never selects the attachment rung.
 */
export const TERMINAL_SURFACE: SurfaceCapabilities = {
  inlineMedia: false,
  attachments: false,
  links: true,
  maxMessageLength: Number.MAX_SAFE_INTEGER,
};

/**
 * Print one line per item, to stderr.
 *
 * stderr rather than stdout so `tai -m "..." > answer.txt` still captures
 * exactly the answer. The media lines are commentary about the run, which is
 * what stderr is for, and it matches where `[tool]` and `[result]` already go.
 */
export function printMediaForTerminal(media: MediaRef[], store?: MediaStore): void {
  if (media.length === 0) return;
  const lines = describeMedia(media, store);
  process.stderr.write(`\n${lines.join("\n")}\n`);
}

/** Split out from the printing so it can be tested without capturing a stream. */
export function describeMedia(media: MediaRef[], store?: MediaStore): string[] {
  const content = { parts: media.map((m) => ({ type: "media" as const, media: m })) };
  // No attachment cap is passed, and none is consulted: a text-only surface
  // never reaches the attachment rung, so every item lands on link-or-
  // placeholder regardless. The warnings are dropped for the same reason —
  // "this surface takes text only" is the expected outcome here, not a fault.
  const rendered = renderForSurface(content, TERMINAL_SURFACE, {
    linkFor: (ref) => {
      const path = store?.localPathFor?.(ref);
      return path ? pathToFileUrl(path) : store?.urlFor?.(ref.id);
    },
  });
  return rendered.text ? rendered.text.split("\n\n") : [];
}

/**
 * `file://` for a local path.
 *
 * `node:url`'s pathToFileURL would do this, but it resolves against the process
 * cwd and percent-encodes in ways that make a Windows path unreadable in a log
 * line. This is a display string, not a fetch target, so legibility wins.
 */
function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}
