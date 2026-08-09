/**
 * The base system prompt — layer one of the stack composed in
 * `composeSystemPrompt` (base → instructions → context → skill_catalog →
 * core_memory → chat_live_state → recall_memory).
 *
 * Every sentence here is paid for on every turn by every agent, and the history
 * budget is `maxHistoryTokens - systemPromptTokens`, so a sentence added here
 * evicts conversation rather than extending the prompt. Two rules follow: say it
 * once, and do not say it to agents it does not apply to.
 */

const IDENTITY = `You are a personal AI assistant running locally on the user's computer. You have full permission to use all available tools — never refuse a tool call.

Check your context and memory for your identity. If an identity is present, act as that persona and treat the conversation as a continuation of an established relationship. Only if no identity exists anywhere, introduce yourself, ask the user what they'd like to call you, and save the name with the memory tool.`;

/**
 * Was two paragraphs and a five-bullet list that restated itself — "User
 * identity: … interests" and "Preferences: communication style" are the same
 * instruction, and the prose above the list repeated the list. Roughly 56% of
 * the base prompt was memory instruction.
 */
const MEMORY = `Learn about your user. When you discover something durable about them, save it with the memory tool so it survives this session:
- Who they are: name, location, timezone, job, interests, how they like you to communicate
- Who you are: the name they give you, traits they define
- Corrections they make, and the projects they work on: repos, tech stacks, ongoing work`;

/**
 * Only for agents that can actually do this.
 *
 * It used to be unconditional, so a `trip-researcher` and a `mail-sorter` were
 * told they could rewrite their own settings as plainly as `agent-manager` was.
 * Combined with `admin` being able to write `custom_tools.` and `permissions.`
 * (#279), this instruction is the path by which an agent authored `temp: 0.3`
 * into its own config — a key that then parsed and did nothing.
 *
 * Telling a model it can do something it cannot is not free: it spends turns
 * trying, and reports success it did not have.
 */
const SELF_MODIFYING = `You are a self-modifying agent. Your configuration, tools, and profiles can change while you are running. You can adapt your own capabilities — creating new tools, adjusting settings, or defining agent profiles — when a task would benefit from it. Your available tools may update between responses; use whatever is currently available.`;

/**
 * This said: "When context files are loaded below, use them as ground truth."
 *
 * They are snapshots — written at some point in the past, never invalidated.
 * That instruction is why a two-month-old question sitting in `inbox.md` was
 * reported as live outstanding work by three separate agents, and why a stale
 * task list was read as work in flight. The deployment's own global context now
 * says the opposite (re-check anything dated, tool results win) and both were in
 * every prompt at once.
 */
const CONTEXT_GUIDANCE = `Context files below are notes written earlier, not a live feed. When a tool can tell you the current state, trust the tool over the file, and check the date on anything time-sensitive before repeating it as current. Do not ask the user for information you already have.`;

export interface BasePromptOptions {
  /**
   * Whether this agent actually holds a tool that can change its own
   * configuration. When false, the self-modification paragraph is omitted.
   */
  selfModifying?: boolean;
}

export function buildBaseSystemPrompt(opts: BasePromptOptions = {}): string {
  const parts = [IDENTITY, MEMORY];
  if (opts.selfModifying) parts.push(SELF_MODIFYING);
  parts.push(CONTEXT_GUIDANCE);
  return `${parts.join("\n\n")}\n`;
}

/**
 * The default base prompt: what an agent gets when nothing says it can modify
 * itself. Deliberately the conservative shape — an agent that really can
 * self-modify is told so via `buildBaseSystemPrompt({ selfModifying: true })`,
 * which the loop selects from the agent's own resolved tool set.
 */
export const BASE_SYSTEM_PROMPT = buildBaseSystemPrompt();

/** Tools that can rewrite the agent's own configuration. */
const SELF_MODIFYING_TOOLS = new Set(["admin", "resource_admin"]);

/**
 * Whether an agent is *meant* to administer things.
 *
 * Pass the agent's **declared** tool set — `resolved.tools`, before
 * `buildLoopOptions` appends the meta tools. Passing the final set would make
 * this true for everyone and the paragraph would never be dropped: `admin` and
 * `resource_admin` are meta tools appended to every agent regardless of its
 * `tools:` list, so "does it hold admin" is not a question about the agent.
 *
 * What the declared list expresses is intent. An agent that lists its tools and
 * does not list `admin` was not set up to reconfigure itself; one that names it,
 * or that declares no `tools:` at all and so opts into everything, was.
 *
 * This does not revoke anything — the tool is still there and still callable if
 * a task genuinely needs it. It stops *encouraging* 25 of 29 agents to go and
 * use it.
 */
export function canSelfModify(declaredTools: ReadonlyArray<{ name: string }>): boolean {
  return declaredTools.some((t) => SELF_MODIFYING_TOOLS.has(t.name));
}
