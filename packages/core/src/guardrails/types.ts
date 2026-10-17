/**
 * Guardrails: a check an agent's outgoing message has to pass.
 *
 * The gap this fills is narrow and specific. An agent can be told, in its
 * instructions, to keep a certain kind of reply short — and a capable model
 * will still write four paragraphs, because the instruction is one sentence
 * competing with everything else in the prompt and nothing enforces it. The
 * deployment this came from watched six separate reviews tell the same agent
 * the same thing across three sessions and measured no change; the only fix
 * that ever worked was rewriting the persona, which is not a fix that scales
 * to "and also don't do these nine other things".
 *
 * So: a mechanical check, run on the text, before it is delivered.
 *
 * ## What a guardrail is not
 *
 * It is not a moderation or safety layer, and it must not be sold as one. It
 * runs on the agent's own outgoing text at one point in one process; anything
 * that needs to hold against an adversary belongs somewhere with a trust
 * boundary in it. This is a quality tool: it holds a well-intentioned agent to
 * a house style it keeps drifting off.
 *
 * It is also not a rewriter. A guardrail refuses; it never edits. An automatic
 * rewrite would put words in the agent's mouth that it did not choose and
 * cannot see, and the next turn would be reasoning about a message it never
 * sent. Refusing and saying why leaves the agent in charge of its own words.
 *
 * ## Why refusal is worth more than suppression
 *
 * Dropping a bad message loses the turn: the room gets silence and the agent
 * never learns. Refusing it with a reason costs one more model call and gets a
 * better message, because "that was 1,400 characters and the cap is 700" is a
 * correction any model can act on immediately. The room watcher already runs
 * exactly one correction round for malformed output, and a guardrail failure
 * joins that ladder rather than inventing a second one.
 */

/** Where a message was headed, so a guardrail can scope itself. */
export interface GuardrailContext {
  /** The agent that wrote it. */
  agent: string;
  /**
   * What kind of send this is. Core uses `room` for a room post and `reply`
   * for a direct channel reply; a plugin may introduce its own.
   */
  surface: string;
  /** Room ref or channel id, when there is one. */
  destination?: string;
}

/**
 * `ok: false` carries the sentence the agent is shown. Write it as a
 * correction the agent can act on — what was wrong and what to do instead —
 * because it is delivered verbatim into the next prompt.
 */
export type GuardrailVerdict = { ok: true } | { ok: false; reason: string };

export interface Guardrail {
  readonly id: string;
  check(text: string, ctx: GuardrailContext): GuardrailVerdict | Promise<GuardrailVerdict>;
}

/**
 * How config declares one: an open selector plus an opaque options bag.
 *
 * The same shape `tasks.backend` and `sandbox.backend` use, and for the same
 * reason — core must not know the option names of any particular guardrail,
 * or a built-in becomes privileged over a plugin and the seam stops being one.
 */
export interface GuardrailSpec {
  /** Registered guardrail id. */
  use: string;
  /** Surfaces this applies to. Omitted means all of them. */
  surfaces?: string[];
  /** Passed to the factory untouched. */
  options?: Record<string, unknown>;
}

export type GuardrailFactory = (options: Record<string, unknown>) => Guardrail;
