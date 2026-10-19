/**
 * What the agent does with a quiet moment. While a page shows its body and
 * nobody is talking to it, the page asks every few minutes, and the agent
 * picks: wander to the window, sit down, browse the shelf, or stay put.
 *
 * One small completion in voice mode, with the body's cues: no history is
 * written (a quiet moment is not a conversation), reasoning is off, and the
 * reply is read for cues alone. Anything it says is dropped.
 */
import { messageText } from "../content/types.js";
import type { AgentRuntime } from "../runtime.js";
import { type Body, type Cue, CueReader } from "./cues.js";

/** The longest an idle choice runs: a cue or two, no speech. */
const IDLE_MAX_TOKENS = 60;

const IDLE_PROMPT = [
  "Nobody is talking to you right now; you have a few quiet minutes to yourself in your room.",
  "Decide what you do next, as a person would at home: go somewhere, look at something, or stay where you are.",
  "Answer with one or two cues and nothing else.",
].join(" ");

export interface IdleMoment {
  agent?: string;
  body: Body;
  /** Where the body is now, as the room names it: "on the couch". */
  here?: string;
  /** The local hour, 0–23, so evening can feel like evening. */
  hour?: number;
}

function partOfDay(hour: number | undefined): string | undefined {
  if (hour === undefined || !Number.isFinite(hour)) return undefined;
  if (hour < 5) return "the middle of the night";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

/** Ask the agent what it does with a quiet moment; the cues it chose, possibly none. */
export async function chooseIdle(
  runtime: Pick<AgentRuntime, "buildLoopOptions" | "getModel" | "getConfig">,
  moment: IdleMoment,
): Promise<Cue[]> {
  // Loop options are only read here, for the agent's provider, model and voice
  // prompt with its body: no turn runs, so no conversation is stored.
  const session = { id: "idle", model: runtime.getModel(), provider: runtime.getConfig().agent.defaultProvider };
  const opts = runtime.buildLoopOptions({
    session,
    ...(moment.agent ? { agentName: moment.agent } : {}),
    mode: "voice",
    body: moment.body,
  });
  const when = partOfDay(moment.hour);
  const situation = [moment.here ? `You are ${moment.here}.` : "", when ? `It is ${when}.` : "", "What do you do?"]
    .filter(Boolean)
    .join(" ");
  // The agent's own model when it names one, as its turns would use.
  const first = opts.getModelChain?.()[0];
  const provider = first?.provider ?? opts.provider;
  const response = await provider.chat({
    model: first?.model ?? session.model,
    messages: [
      { role: "system", content: `${opts.extraInstructions ?? ""}\n\n${IDLE_PROMPT}` },
      { role: "user", content: situation },
    ],
    // Some variety: the same quiet moment shouldn't always end at the window.
    temperature: 0.9,
    maxTokens: IDLE_MAX_TOKENS,
    thinking: "off",
  });
  const text = messageText(response.content);
  const reader = new CueReader(moment.body);
  return [...reader.push(text), ...reader.flush()].flatMap((p) => ("cue" in p ? [p.cue] : [])).slice(0, 2);
}
