/**
 * Voice mode: the agent as it talks in a live session.
 *
 * Same identity and history as the text agent, with a smaller, faster turn: a
 * spoken reply has a couple of seconds, and a 27B model with a full prompt and
 * forty tools cannot answer in two. What changes is said in `voiceMode`; what
 * must not change between turns is the prompt prefix — the system prompt and
 * tool schemas stay byte-identical, so the model server keeps them cached and
 * the first word comes in tens of milliseconds instead of hundreds.
 */
import type { AgentLoopOptions } from "../agent/loop.js";
import type { AgentDefinition } from "../config.js";
import { type Body, bodyInstructions } from "./cues.js";

const SPOKEN_STYLE = [
  "You are talking with the person out loud, in a live voice conversation.",
  "Answer in one to three short spoken sentences.",
  "Everything you write is read aloud, so use no lists, headings, markdown, links or emoji.",
  "If something will take a while, say so in a few words.",
];

/** How a voice turn is told to talk when the agent's `voice:` block says nothing. */
export const DEFAULT_VOICE_INSTRUCTIONS = [
  ...SPOKEN_STYLE,
  // Measured: with no tools, the agent promised "I'll remind you" every run.
  "Only offer to do what your tools let you do; for anything else, say plainly that you can't do it from here.",
].join(" ");

/**
 * The same, when the surface shows the agent with a body. Measured: told
 * only about its tools, the agent refused to walk anywhere even with cues
 * explained; told about its tools and its body, it went 9 times out of 10.
 */
export const DEFAULT_VOICE_INSTRUCTIONS_WITH_BODY = [
  ...SPOKEN_STYLE,
  "Only offer to do what your tools and your body let you do; for anything else, say plainly that you can't do it from here.",
].join(" ");

/** Longest spoken reply, in tokens, when the agent names none. Two or three sentences fit well inside it. */
export const DEFAULT_VOICE_MAX_TOKENS = 300;

/**
 * `body` is what the session's surface shows the agent with, if anything: its
 * cues go at the end of the instructions, after the agent's own, and stay
 * the same for the whole session so the prompt stays cached.
 */
export function voiceMode(opts: AgentLoopOptions, voice: AgentDefinition["voice"], body?: Body): AgentLoopOptions {
  const keep = new Set(voice?.tools ?? []);
  const style = body ? DEFAULT_VOICE_INSTRUCTIONS_WITH_BODY : DEFAULT_VOICE_INSTRUCTIONS;
  const instructions = [
    voice?.instructions ??
      [style, opts.extraInstructions].filter((s) => typeof s === "string" && s.trim()).join("\n\n"),
    body ? bodyInstructions(body) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...opts,
    tools: opts.tools.filter((t) => keep.has(t.name)),
    // The loop re-resolves tools every round; without this the full set
    // would come back on the second round of a voice turn.
    ...(opts.getTools
      ? { getTools: () => (opts.getTools as () => typeof opts.tools)().filter((t) => keep.has(t.name)) }
      : {}),
    extraInstructions: instructions,
    thinking: "off",
    maxTokens: voice?.maxTokens ?? DEFAULT_VOICE_MAX_TOKENS,
    // Recall searches on every turn and its results move; a call has no time
    // for the first and the prefix rule is easier to keep without the second.
    injectMemory: false,
    skillCatalog: [],
    nudgeOnText: 0,
  };
}
