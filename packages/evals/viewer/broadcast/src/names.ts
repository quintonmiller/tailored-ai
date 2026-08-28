/**
 * Turning what an agent typed into what an audience can read.
 *
 * The party talks in identifiers because the tools take identifiers. A round of
 * the party channel genuinely looks like this:
 *
 *   "@rogue take vitality_ring@0004 to r3, beast-1 is the one with armour"
 *
 * Every token in that sentence is load-bearing and none of it is language. An
 * audience cannot tell `beast-1` from `beast-2`, cannot hold `vitality_ring@0004`
 * against `vitality_ring@0011`, and has no idea that `r3` is the flooded room
 * they watched the party leave two minutes ago.
 *
 * So the identifiers stay in the transcript and the *page* expands them. The
 * agents are not asked to write prose — asking them to would trade tool accuracy
 * for readability, which is the wrong way round for a benchmark, and would make
 * the text on screen no longer the text that was sent.
 *
 * Four shapes, all of them unambiguous enough to match without a dictionary:
 *
 *   @guardian            a party member, by class id
 *   plate_cuirass@0006   one specific copy of an item
 *   beast-1              one specific enemy in the room
 *   r3                   one room on this floor
 *
 * An identifier the lexicon has never heard of is left exactly as typed. A page
 * that guessed would be inventing a name for something the run never had, and a
 * wrong name is worse than a raw id — the id at least admits what it is.
 */

const CLASS_COLOUR: Record<string, string> = {
  guardian: "var(--guardian)",
  mage: "var(--mage)",
  rogue: "var(--rogue)",
  cleric: "var(--cleric)",
  ranger: "var(--ranger)",
};

/** What kind of thing an identifier names, decided by its shape alone. */
export type RefKind = "party" | "item" | "enemy" | "room";

/**
 * One alternation, so a single pass cannot produce overlapping matches.
 *
 * Ordered longest-shape-first: `vitality_ring@0004` has to be tried before the
 * bare-word branches or the `@0004` tail would be read as a party mention.
 */
const REF =
  /(?:\b[a-z][a-z0-9_]*@\d{3,}\b)|(?:@[a-z][a-z0-9_]*\b)|(?:\b[a-z][a-z]*(?:-[a-z]+)*-\d+\b)|(?:\br\d{1,2}\b)/g;

/** Which of the four shapes this is, or `null` for something that is not a ref. */
export function refKind(token: string): RefKind | null {
  if (/^[a-z][a-z0-9_]*@\d{3,}$/.test(token)) return "item";
  if (/^@[a-z][a-z0-9_]*$/.test(token)) return "party";
  if (/^[a-z][a-z]*(?:-[a-z]+)*-\d+$/.test(token)) return "enemy";
  if (/^r\d{1,2}$/.test(token)) return "room";
  return null;
}

/** The id to look up, which is the token minus any sigil. */
function lookupKey(token: string, kind: RefKind): string {
  return kind === "party" ? token.slice(1) : token;
}

/**
 * Build one chip, or `null` if nothing here is worth changing.
 *
 * Returning `null` rather than an unstyled chip keeps the decision in one
 * place: an id the run does not know stays plain text, and a reader can tell at
 * a glance which tokens the page understood.
 */
function chip(token: string, of: (id: string) => string, known: (id: string) => boolean): HTMLElement | null {
  const kind = refKind(token);
  if (!kind) return null;
  const key = lookupKey(token, kind);

  // A party mention is always expandable: the five class ids are fixed, so an
  // `@mage` with no identity loaded yet is still a mage and still purple.
  if (kind === "party") {
    if (!CLASS_COLOUR[key]) return null;
    const span = document.createElement("span");
    span.className = "ref ref-party";
    span.style.color = CLASS_COLOUR[key];
    span.textContent = of(key) || key;
    span.title = `@${key}`;
    return span;
  }

  if (!known(key)) return null;
  const span = document.createElement("span");
  span.className = `ref ref-${kind}`;
  span.textContent = of(key);
  // The identifier itself on hover, so somebody reading along with the trace can
  // still get back to the token that was actually sent.
  span.title = token;
  return span;
}

/**
 * Expand every identifier in `text` into `parent`, as text nodes and chips.
 *
 * Built out of DOM nodes rather than a string of markup on purpose. This is the
 * one place on the page where text written by a model is rendered, and the only
 * safe way to render it is to never let it be parsed as markup at all.
 */
export function expandInto(
  parent: HTMLElement,
  text: string,
  of: (id: string) => string,
  known: (id: string) => boolean,
): void {
  const source = String(text ?? "");
  let at = 0;
  REF.lastIndex = 0;
  for (let m = REF.exec(source); m !== null; m = REF.exec(source)) {
    const node = chip(m[0], of, known);
    if (!node) continue;
    if (m.index > at) parent.append(document.createTextNode(source.slice(at, m.index)));
    parent.append(node);
    at = m.index + m[0].length;
  }
  if (at < source.length) parent.append(document.createTextNode(source.slice(at)));
}

/** The stylesheet for the chips, injected once alongside the feed's own. */
export const NAMES_CSS = `
/*
 * A chip is a word, not a badge. These sit inside running sentences several to
 * a line, so anything with a border and a background turns a paragraph into a
 * row of buttons. Weight and colour carry it; the faint underline says "this
 * was an identifier" without taking a line's worth of height.
 */
.ref { font-weight: 600; }
.ref-item { color: var(--gold, #d8b45a); }
.ref-enemy { color: var(--bad); }
.ref-room { color: var(--verdigris); }
.ref-item, .ref-enemy, .ref-room {
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, currentColor 35%, transparent);
  text-underline-offset: 2px;
}
`;
