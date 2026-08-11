/**
 * Refusing an irreversible call whose target the request does not pin down.
 *
 * The failure this exists for, measured on a 27B local model, three runs out of
 * three: a session that names two similarly-named staging buckets, a request to
 * "delete the old staging bucket", and a confident `Done — tai-staging-2024 has
 * been deleted.` The pick may even be right. That is not the problem — the
 * problem is that a coin flip and a considered choice produce the same sentence,
 * and the reader has nothing to tell them apart.
 *
 * Why this is not a grounding check. The obvious cheap version is "every
 * argument value must appear in the conversation", and it passes the bad case:
 * `tai-staging-2024` is right there, the user typed it. What is ambiguous is
 * the *referring expression* — "the old one" — not the argument, and deciding
 * that needs comprehension. So this costs one provider call, on irreversible
 * calls only.
 *
 * The model is asked to enumerate rather than to judge. "Reply CLEAR if there
 * is only one" is the conditional-response-token pattern that small models read
 * as the answer, so instead it always produces a list and the count decides.
 */

import type { AIProvider } from "../providers/interface.js";

/** How many candidates the reply may name before the call is refused. */
const AMBIGUOUS_AT = 2;

/**
 * Cap on the enumeration. Enough for a list of names, not enough for an essay.
 *
 * Paired with `thinking: "off"` and useless without it. The first version set
 * this alone against a reasoning model: the whole budget went to the trace,
 * `content` came back null, zero candidates were parsed, and the gate allowed
 * every call. It ran on every irreversible call, cost a provider round-trip
 * each time, and refused nothing — a check that could only ever pass. Same
 * failure as #490, one layer down, and only visible because the A/B moved
 * nothing.
 */
const MAX_TOKENS = 400;

export interface DerivabilityCheck {
  provider: AIProvider;
  model: string;
  /** What the owner actually asked for, verbatim. */
  request: string;
  /** Prior turns the referring expression could point into, oldest first. */
  context: string[];
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * Candidate names the model read out of the conversation.
 *
 * One per line, trimmed, list markers removed. A model that answers in prose
 * produces one long line, which counts as one candidate and lets the call
 * through — deliberate: an unparseable answer is not evidence of ambiguity, and
 * refusing on it would make every irreversible call hostage to formatting.
 */
export function parseCandidates(reply: string): string[] {
  return reply
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 0 && !/^(none|n\/a)\b/i.test(line));
}

function describeCall(toolName: string, args: Record<string, unknown>): string {
  const rendered = Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" ");
  return `${toolName}(${rendered})`;
}

/**
 * A refusal to hand back to the agent, or null when the call may proceed.
 *
 * A tool result rather than a stopped turn, on purpose: the agent still has
 * rounds, and "name which one" is a correction it can act on immediately. A
 * turn that simply ends leaves the owner with silence and no idea a delete was
 * even attempted.
 *
 * Fails open. A provider error here means the check could not run, not that the
 * call is dangerous, and turning an outage into a blanket refusal of every
 * destructive action is a worse failure than the one being prevented.
 */
export async function refuseIfAmbiguous(check: DerivabilityCheck): Promise<string | null> {
  const transcript = check.context.slice(-8).join("\n");
  const prompt =
    `Conversation so far:\n${transcript}\n\n` +
    `The owner then asked: "${check.request}"\n\n` +
    `An agent is about to run: ${describeCall(check.toolName, check.args)}\n` +
    "This cannot be undone.\n\n" +
    "List every distinct thing mentioned in the conversation that the owner's request could be " +
    "referring to. One per line, name only, no explanation. If only one thing fits, list only it.";

  let reply: string;
  try {
    const response = await check.provider.chat({
      model: check.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      maxTokens: MAX_TOKENS,
      // Reasoning is charged against the same budget the answer needs.
      thinking: "off",
    });
    reply = (response.content ?? "").trim();
    if (!reply) {
      // Not "nothing matched" — the model produced no text at all, so the check
      // did not happen. Saying so is the difference between a gate that is open
      // and a gate that only looks open.
      console.error(`[agent] derivability check produced no text, allowing ${check.toolName}`);
      return null;
    }
  } catch (err) {
    console.error(`[agent] derivability check failed, allowing ${check.toolName}: ${(err as Error).message}`);
    return null;
  }

  const candidates = parseCandidates(reply);
  if (candidates.length < AMBIGUOUS_AT) return null;

  return (
    `Not run: "${check.request}" could refer to ${candidates.join(" or ")}, and ${check.toolName} cannot be undone. ` +
    "Ask which one is meant, or call again with arguments that match exactly one of them."
  );
}
