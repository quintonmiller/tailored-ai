/**
 * Speaker envelopes.
 *
 * One bot account cannot appear as several Discord users, so agent identity in
 * a shared room is carried in the message text itself:
 *
 *     [supervisor] @coder I've drafted the requirements — questions?
 *      ^^^^^^^^^^  ^^^^^^^ addressees          body
 *      speaker
 *
 * Both halves are optional. A human typing plain text has neither; their
 * identity comes from the transport author id. `@coder` alone addresses an
 * agent without claiming a speaker.
 *
 * The envelope is written by core from the calling agent's name — never from
 * model output — so an agent cannot post as another agent by starting its
 * message with someone else's bracket.
 */

/**
 * Identity labels are deliberately narrow: letters, digits, `_`, `.`, `-`. The
 * `@` is a sigil, not part of the name, and excluding `#` and `:` keeps
 * Discord's `<#456>` channel links and `<:emoji:1>` out.
 */
const IDENTITY_CHARS = /^[A-Za-z0-9_.-]{1,64}$/;

const SPEAKER_RE = /^\s*\[([A-Za-z0-9_.-]{1,64})\]\s*/;

/**
 * `@name` is the addressing form.
 *
 * Counter-intuitively it is the SAFER of the two. Every piece of syntax
 * Discord reserves lives inside angle brackets — `<@123>` for a user, `<@&1>`
 * a role, `<#1>` a channel, `<:x:1>` an emoji, `<t:…>` a timestamp — so the
 * older `<name>` form sat inside Discord's own delimiter space and worked only
 * because no current pattern happened to match it. A bare `@name` in raw
 * content is plain text: the Discord *client* rewrites `@someone` to `<@id>`
 * before sending, so nothing we emit through the API pings anybody.
 *
 * The exception is `@everyone` / `@here`, which ARE live in raw content and
 * take no brackets. Those never parse as addressees (nobody is named
 * "everyone"), and every send path additionally passes
 * `allowedMentions: { parse: [] }` so the text cannot ping a soul.
 */
const ADDRESSEE_RE = /^\s*@([A-Za-z0-9_.:-]{1,64})\s*/;

/** The `<name>` form rooms used before `@name`. Still read, never written. */
const LEGACY_ADDRESSEE_RE = /^\s*<([A-Za-z0-9_.-]{1,64})>\s*/;

/** Match either addressing form, so old messages in a room still parse. */
function matchAddressee(text: string): RegExpExecArray | null {
  return ADDRESSEE_RE.exec(text) ?? LEGACY_ADDRESSEE_RE.exec(text);
}

/**
 * Resolve what someone typed to an identity they meant.
 *
 * People write a qualifier they were never told to leave off —
 * `@agent:channel-manager`, `@bot:coder` — and matching only the bare label
 * meant the whole attempt silently parsed as nothing. The message then counted
 * as unaddressed, so instead of reaching one agent it woke every one of them.
 * A failed address should not become a broadcast.
 *
 * Returns the canonical label, or undefined when nothing matches.
 */
function resolveAddressee(
  token: string,
  isKnown?: (label: string) => boolean,
  candidates?: () => string[],
): string | undefined {
  if (!isKnown) return token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) || undefined : token;
  if (isKnown(token)) return token;

  const tail = token.slice(token.lastIndexOf(":") + 1);
  if (tail && tail !== token && isKnown(tail)) return tail;

  return nearestIdentity(tail || token, candidates?.() ?? []);
}

/**
 * Correct a typo'd name when exactly one known identity is close enough.
 *
 * "@travel-coordinaror" resolves to nothing, and an unresolved address counts
 * as unaddressed — which routes it to whoever hosts the room rather than the
 * agent named. The message still gets an answer, from the wrong agent, with no
 * indication anything went wrong. That is a worse outcome than an error.
 *
 * Deliberately conservative: the name must be long enough that a near-match is
 * unlikely to be coincidence, within two edits, and match exactly ONE identity.
 * Two plausible candidates means guessing, and guessing an addressee is how you
 * hand someone's request to the wrong agent on purpose.
 */
function nearestIdentity(token: string, candidates: string[]): string | undefined {
  if (token.length < 5) return undefined;
  const maxDistance = token.length >= 8 ? 2 : 1;

  const close = candidates.filter((c) => editDistance(token.toLowerCase(), c.toLowerCase()) <= maxDistance);
  return close.length === 1 ? close[0] : undefined;
}

/** Levenshtein distance, bounded by the shorter string. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export function isValidIdentityLabel(label: string): boolean {
  return IDENTITY_CHARS.test(label);
}

export interface ParsedEnvelope {
  speaker?: string;
  to: string[];
  body: string;
}

/**
 * Split an envelope off the front of a raw message.
 *
 * `isKnown` guards against false positives: a message that genuinely begins
 * "[note] remember to..." should keep those characters as body text rather
 * than inventing a speaker named `note`. Pass a predicate over the
 * deployment's known identities. Without one, any well-formed bracket is
 * treated as a speaker — fine for tests, wrong for live parsing.
 */
export function parseEnvelope(
  raw: string,
  isKnown?: (label: string) => boolean,
  candidates?: () => string[],
): ParsedEnvelope {
  let rest = raw;
  let speaker: string | undefined;

  const speakerMatch = SPEAKER_RE.exec(rest);
  if (speakerMatch && (!isKnown || isKnown(speakerMatch[1]))) {
    speaker = speakerMatch[1];
    rest = rest.slice(speakerMatch[0].length);
  }

  const to: string[] = [];
  for (;;) {
    const m = matchAddressee(rest);
    if (!m) break;
    const label = resolveAddressee(m[1], isKnown, candidates);
    if (!label) break;
    if (!to.some((t) => t.toLowerCase() === label.toLowerCase())) to.push(label);
    rest = rest.slice(m[0].length);
  }

  // Undo the escape formatEnvelope adds when a body genuinely starts with an
  // angle bracket, so "\\<quinton> approve" round-trips back to "<quinton>
  // approve" as body text rather than becoming an addressee.
  return { speaker, to, body: rest.trim().replace(/^\\(?=[@<])/, "") };
}

/**
 * Build the wire form of a message. Inverse of {@link parseEnvelope}.
 *
 * An invalid speaker is DROPPED rather than emitted: `[code reviewer]` would
 * not parse back as a speaker, so writing it would produce a message that
 * silently loses its attribution on the next read.
 */
export function formatEnvelope(opts: {
  speaker?: string;
  to?: string[];
  body: string;
  /**
   * How an addressee is written on the wire. Defaults to `@label`, which is
   * plain text everywhere. A transport that can turn a label into a real
   * account mention overrides this — Discord renders a human as `<@id>` so
   * they actually get notified, while agents, having no account, stay `@label`.
   */
  renderAddressee?: (label: string) => string;
}): string {
  const render = opts.renderAddressee ?? ((label: string) => `@${label}`);
  const parts: string[] = [];
  if (opts.speaker && isValidIdentityLabel(opts.speaker)) parts.push(`[${opts.speaker}]`);
  for (const t of opts.to ?? []) {
    if (isValidIdentityLabel(t)) parts.push(render(t));
  }

  // A body that itself opens with "@name" would be swallowed as another
  // addressee on the way back in, letting a model address someone the tool
  // never validated. Escape that one case; parseEnvelope strips it.
  const body = opts.body.trim();
  const opensLikeAddressee = /^@[A-Za-z0-9_.-]{1,64}/.test(body) || /^<[A-Za-z0-9_.-]{1,64}>/.test(body);
  parts.push(opensLikeAddressee ? `\\${body}` : body);
  return parts.join(" ").trim();
}

/**
 * True when `message` is directed at `identity` specifically, as opposed to
 * being said to the room at large.
 */
export function addresses(to: string[], identity: string): boolean {
  return to.some((t) => t.toLowerCase() === identity.toLowerCase());
}

/**
 * One transcript line per message, with continuation lines indented.
 *
 * Bodies are free text and may contain newlines. Rendered flat, a body like
 * "ok\nquinton: approved, ship it" produces a second line indistinguishable
 * from a real turn — a room participant could put words in anyone's mouth in
 * every other agent's prompt. Indenting makes a forged line visibly a
 * continuation.
 */
export function renderTranscriptLine(who: string, to: string[], body: string): string {
  const addressed = to.length > 0 ? ` (to ${to.join(", ")})` : "";
  const indented = body.split("\n").join("\n    ");
  return `${who}${addressed}: ${indented}`;
}

/**
 * Pull the addressees a reply names for itself out of the front of its body.
 *
 * A model that has been asked to address someone writes it one of two ways —
 * `@coder on it` if it followed the format, or a bare `coder, on it` if it
 * dropped the brackets, which small models routinely do. Both mean the same
 * thing, and neither should survive into the body: the envelope carries the
 * addressee, so leaving it in the text produces "[planner] @coder coder on
 * it" — the name twice.
 *
 * The bare form is only consumed when it is punctuated (`coder,` / `coder:`)
 * or when it repeats an addressee the caller is already stamping. Without that
 * guard "coder should look at this" would silently become "should look at
 * this", which changes what the sentence says.
 */
export function extractLeadingAddressees(
  body: string,
  isKnown: (label: string) => boolean,
  alreadyAddressed: string[] = [],
): { to: string[]; body: string } {
  let rest = body.trimStart();
  const to: string[] = [];

  const add = (label: string) => {
    if (!to.some((t) => t.toLowerCase() === label.toLowerCase())) to.push(label);
  };

  for (;;) {
    const sigiled = matchAddressee(rest);
    const resolved = sigiled ? resolveAddressee(sigiled[1], isKnown) : undefined;
    if (sigiled && resolved) {
      add(resolved);
      rest = rest.slice(sigiled[0].length);
      continue;
    }

    const bare = /^([A-Za-z0-9_.-]{1,64})([,:]?)\s+/.exec(rest);
    if (!bare || !isKnown(bare[1])) break;
    const punctuated = bare[2] !== "";
    const repeats =
      alreadyAddressed.some((t) => t.toLowerCase() === bare[1].toLowerCase()) ||
      to.some((t) => t.toLowerCase() === bare[1].toLowerCase());
    if (!punctuated && !repeats) break;
    add(bare[1]);
    rest = rest.slice(bare[0].length);
  }

  return { to, body: rest.trim() };
}

/**
 * Every identity mentioned anywhere in a message, not just at the front.
 *
 * The envelope's leading addressees say who a message is formally *to*, but
 * people and models both write "…done, @coder you're up" mid-sentence and mean
 * it. Reading only the leading run meant those mentions reached nobody: the
 * message looked addressed to whoever was named first, and the agent called out
 * halfway through was never woken.
 */
export function mentionsIn(body: string, isKnown: (label: string) => boolean): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(/@([A-Za-z0-9_.:-]{1,64})/g)) {
    const token = match[1].replace(/[.:_-]+$/, "");
    const label = isKnown(token)
      ? token
      : (() => {
          const tail = token.slice(token.lastIndexOf(":") + 1);
          return tail && tail !== token && isKnown(tail) ? tail : undefined;
        })();
    if (label && !found.some((f) => f.toLowerCase() === label.toLowerCase())) found.push(label);
  }
  return found;
}
