import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import {
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  createApprovalRequestId,
  evaluatePermission,
  formatApprovalDescription,
  type PermissionsConfig,
} from "../approval.js";
import { loadAllContext, loadContextFiles } from "../context.js";
import { recordTokenUsage } from "../db/autopilot-queries.js";
import { getCoreMemory, renderCoreMemory } from "../db/core-memory-queries.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  Message,
  ThinkingLevel,
  ToolCall,
  ToolSchema,
} from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import { type ActiveSkillState, createActiveSkillState } from "./active-skill.js";
import type { SkillCatalogEntry } from "./agents.js";
import { buildChatLiveState, renderChatLiveState } from "./chat-live-state.js";
import type { ConfigDeclaredSlot } from "./context-slots.js";
import { listContextSlots, renderContextSlots, slotsFromConfig } from "./context-slots.js";
import { buildMemoryBlockWithMeta } from "./memory-inject.js";
import type { Session } from "./session.js";
import {
  composeSystemPrompt,
  composeTailBlock,
  resolveBase,
  resolveCustomLayers,
  type SystemPromptOverride,
} from "./system-prompt.js";
import { capToolOutput, resolveToolOutputLimit } from "./tool-output.js";

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

/**
 * One rung of the fallback chain: a built provider and the model to ask it for.
 * `label` is what the operator sees in a log line, so it names the configured
 * provider id rather than the provider's display name — two entries can share
 * an implementation (both OpenAI-compatible) and differ only by id.
 */
export interface ModelCandidate {
  provider: AIProvider;
  model: string;
  label: string;
  /**
   * Per-rung overrides from `ModelEntry`. Absent means inherit the value the
   * call already resolved — a rung that says nothing behaves exactly as it did
   * before these existed.
   */
  thinking?: ThinkingLevel;
  temperature?: number;
  maxTokens?: number;
  /**
   * Provider-specific request fields for this rung. Replaces the inherited bag
   * rather than merging with it — see {@link ModelEntry.providerExtra}.
   */
  providerExtra?: Record<string, unknown>;
  /**
   * This model's context window, from `ModelEntry.maxContextTokens`. Used to
   * size the history for *this* rung: a chain that mixes window sizes would
   * otherwise hand a fallback a request built for the head.
   */
  maxContextTokens?: number;
}

/**
 * Fold a rung's overrides into the call's params.
 *
 * Explicitly per-field rather than a spread of the candidate: `undefined` on an
 * override must mean "inherit", and `{...params, ...candidate}` would instead
 * erase the inherited value with it.
 */
export function applyCandidateParams(params: Omit<ChatParams, "model">, candidate: ModelCandidate): ChatParams {
  const out: ChatParams = { ...params, model: candidate.model };
  if (candidate.thinking !== undefined) out.thinking = candidate.thinking;
  if (candidate.temperature !== undefined) out.temperature = candidate.temperature;
  if (candidate.maxTokens !== undefined) out.maxTokens = candidate.maxTokens;
  if (candidate.providerExtra !== undefined) out.extra = candidate.providerExtra;
  return out;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[agent] Provider call failed (attempt ${attempt + 1}), retrying in ${RETRY_DELAY_MS}ms: ${lastError.message}`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

/**
 * One provider call, streaming when the caller wants deltas and the
 * provider supports them. Falls back to blocking `chat()` otherwise.
 *
 * Retry semantics: a failure before any delta retries the stream; a
 * failure after deltas were emitted retries with non-streaming `chat()`
 * so the consumer never sees replayed text (every consumer treats the
 * final response as superseding streamed deltas anyway).
 */
async function chatOnce(
  provider: AIProvider,
  params: ChatParams,
  onTextDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  retry = true,
): Promise<ChatResponse> {
  // `retry` is false for every rung of a fallback chain except the last: when a
  // different model is standing by, spending a second and another failed call
  // on the one that just refused is worse than moving on. The last rung keeps
  // the transient-blip retry, which is what a single-model deployment has
  // always had.
  const attempt = retry ? withRetry : <T>(fn: () => Promise<T>) => fn();
  const stream = provider.chatStream?.bind(provider);
  if ((!onTextDelta && !onReasoningDelta) || !stream) {
    return attempt(() => provider.chat(params));
  }
  let emitted = false;
  return attempt(async () => {
    if (emitted) return provider.chat(params);
    let done: ChatResponse | undefined;
    for await (const ev of stream(params)) {
      if (ev.type === "delta") {
        emitted = true;
        try {
          onTextDelta?.(ev.content);
        } catch (e) {
          console.error("[agent] onTextDelta callback error:", (e as Error).message);
        }
      } else if (ev.type === "reasoning") {
        // Mark emitted so a mid-stream failure falls back to non-streaming
        // chat() and never replays reasoning. Reasoning is a separate channel.
        emitted = true;
        try {
          onReasoningDelta?.(ev.content);
        } catch (e) {
          console.error("[agent] onReasoningDelta callback error:", (e as Error).message);
        }
      } else {
        done = ev.response;
      }
    }
    if (!done) throw new Error(`${provider.name} chatStream ended without a done event`);
    return done;
  });
}

/**
 * Walk a fallback chain until one candidate answers.
 *
 * Each rung gets one attempt; the last also gets the transient retry, so a
 * one-entry chain behaves exactly as a single provider always did. Any failure
 * moves to the next rung — including a 4xx, because "this model refuses this
 * request" is precisely when a different model is worth trying, and because a
 * provider error arrives as an `Error` whose status is only in its message.
 *
 * Deltas already emitted by a failed candidate are not replayed or withdrawn:
 * the consumer contract is that the final response supersedes streamed deltas.
 * Crossing models mid-turn makes that visible as a flicker, which is a better
 * outcome than failing a turn while a working model sits in the list.
 *
 * Throws the *first* error when everything fails. The first rung is the one the
 * operator configured as primary, so its failure is the one that explains the
 * outage; later rungs failing is expected once the primary is down.
 *
 * `params` may be a function of the candidate, which is how a rung with a
 * smaller context window gets a request sized for it rather than one built for
 * the head of the chain. A plain object behaves as it always did.
 */
export async function chatWithFallback(
  candidates: ModelCandidate[],
  params: Omit<ChatParams, "model"> | ((candidate: ModelCandidate) => Omit<ChatParams, "model">),
  onTextDelta?: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
): Promise<{ response: ChatResponse; candidate: ModelCandidate; fellBack: boolean }> {
  if (candidates.length === 0) throw new Error("no model candidates configured");
  const paramsFor = typeof params === "function" ? params : () => params;
  let firstError: Error | undefined;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const isLast = i === candidates.length - 1;
    try {
      const response = await chatOnce(
        candidate.provider,
        // Two independent per-rung adjustments: the caller sizes the request
        // for this rung, then the rung's own overrides land on top.
        applyCandidateParams(paramsFor(candidate), candidate),
        onTextDelta,
        onReasoningDelta,
        isLast,
      );
      if (i > 0) {
        console.warn(`[agent] answered by fallback ${candidate.label} (${candidate.model}) after ${i} failed`);
      }
      return { response, candidate, fellBack: i > 0 };
    } catch (err) {
      const error = err as Error;
      firstError ??= error;
      if (isLast) break;
      console.warn(
        `[agent] ${candidate.label} (${candidate.model}) failed, trying ${candidates[i + 1].label} ` +
          `(${candidates[i + 1].model}): ${error.message}`,
      );
    }
  }
  throw firstError;
}

/**
 * Why an agent loop ended. Reported through {@link AgentLoopOptions.onStop} so
 * callers branch on structure instead of parsing the loop's prose.
 *
 * - `complete` — the model stopped calling tools and answered. The normal exit.
 * - `tool-ended` — a tool returned `endsTurn`, so the turn stopped on the tool's
 *   say-so rather than the model's. `sleep` and `room` pass do this. Not a
 *   stall: it is the most deliberate exit there is.
 * - `aborted` — `options.signal` fired. `requestedByCaller` distinguishes an
 *   abort the caller asked for (token budget, runtime shutdown) from anything
 *   else, which is the difference between "working as configured" and "stuck".
 * - `max-rounds` — hit `maxToolRounds`. A genuine stall.
 * - `repeated-calls` — the model looped on identical tool calls. A genuine stall.
 * - `truncated` — the model hit its output cap before writing anything. Not a
 *   stall: it did work, it was billed for it, and none of it survived.
 */
export type LoopStop =
  | { kind: "complete" }
  | { kind: "tool-ended"; tool: string; reason?: string }
  | { kind: "aborted"; requestedByCaller: boolean; reason?: string }
  | { kind: "max-rounds"; rounds: number }
  | { kind: "repeated-calls" }
  | { kind: "truncated"; model: string; maxTokens?: number; outputTokens?: number; spentOnReasoning: boolean };

/** True when the loop ended because it got stuck, rather than finishing or being told to stop. */
export function isStallStop(stop: LoopStop): boolean {
  return stop.kind === "max-rounds" || stop.kind === "repeated-calls";
}

/**
 * Explain a turn that hit the output cap before saying anything.
 *
 * `maxTokens` goes out as `max_completion_tokens`, which on a reasoning model
 * caps reasoning *plus* visible output rather than output alone. A hard turn
 * can therefore spend the whole budget thinking and return an empty message
 * with `finish_reason: "length"`, billed in full. An empty assistant message is
 * indistinguishable from a model that had nothing to say, and that ambiguity is
 * how the class of bug survives — so name it, and say which knob moves it.
 */
export function describeTruncation(stop: Extract<LoopStop, { kind: "truncated" }>): string {
  const parts = [`${stop.model} reached its output limit before writing a reply`];
  if (stop.maxTokens !== undefined) parts.push(`maxTokens is ${stop.maxTokens}`);
  if (stop.outputTokens !== undefined) parts.push(`${stop.outputTokens} output tokens were billed`);
  if (stop.spentOnReasoning) parts.push("the budget went to reasoning, which shares this cap with the answer");
  const advice = stop.spentOnReasoning
    ? "Raise maxTokens for this model, or lower its reasoning effort."
    : "Raise maxTokens for this model.";
  return `${parts.join(" — ")}. ${advice}`;
}

export interface AgentLoopOptions {
  provider: AIProvider;
  session: Session;
  db: Database.Database;
  tools: Tool[];
  extraInstructions: string;
  maxToolRounds: number;
  maxHistoryTokens: number;
  /** Chars of a single tool result that reach history. 0 disables. Defaults to {@link DEFAULT_MAX_TOOL_OUTPUT_CHARS}. */
  maxToolOutputChars?: number;
  /** Per-tool override of `maxToolOutputChars`, keyed by resolved tool name. */
  toolOutputLimits?: Record<string, number>;
  /** Where full pre-truncation output is kept. Defaults to `$TAI_HOME/tool-outputs`. */
  toolOutputDir?: string;
  temperature: number;
  contextDir?: string;
  /** Token threshold for the oversized-context warning. 0 disables. */
  contextWarnTokens?: number;
  agentContextDir?: string;
  kbDir?: string;
  agentKbDir?: string;
  signal?: AbortSignal;
  /** When >0, re-prompt the model up to N times if it responds with text instead of tool calls. */
  nudgeOnText?: number;
  /** Custom nudge message. Defaults to a generic "continue" prompt. */
  nudgeMessage?: string;
  /** When true, only load agent-specific context files (skip global). */
  skipGlobalContext?: boolean;
  /** When true, summarize dropped history instead of silently discarding it. Uses an extra provider call. */
  summarizeOnTrim?: boolean;
  /**
   * Whether this agent is meant to reconfigure itself. Drives the
   * self-modification paragraph in the base prompt. Set by
   * `runtime.buildLoopOptions` from the agent's **declared** tools; defaults to
   * false, which is the conservative shape for callers that build options by
   * hand. See `canSelfModify`.
   */
  selfModifying?: boolean;
  getTools?: () => Tool[];
  getProvider?: () => AIProvider;
  /**
   * The agent's fallback chain, re-resolved every iteration so a config reload
   * takes effect mid-run like `getTools`/`getProvider` do. When absent (or
   * returning an empty list) the loop uses `provider` + `session.model` alone,
   * which is what every caller that builds options by hand still gets.
   *
   * Building a candidate can fail — a provider whose plugin is not installed —
   * so the resolver drops those rather than surfacing them here. A chain that
   * resolves to nothing falls back to the single provider for the same reason.
   */
  getModelChain?: () => ModelCandidate[];
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  /** Fires with a short description when the agent emits reasoning text before tool calls. Fires null when the loop ends. */
  onActivity?: (description: string | null) => void;
  /** Fires after each provider.chat() with token counts from the response. */
  onUsage?: (usage: { input: number; output: number }) => void;
  /**
   * What to attribute this run's token usage to. The loop writes a
   * `token_usage` row per provider call regardless; this only labels it.
   *
   * Defaults to `"loop"`, which covers chat, room wakes, cron and delegation —
   * everything that previously recorded nothing at all, leaving the table a
   * ledger of autopilot and exploratory only and no way to ask what the rest
   * cost. Callers that own a more specific budget pass their own label.
   */
  usageSource?: import("../db/autopilot-queries.js").TokenUsageSource;
  /** Task to attribute usage to, for callers that run a loop per task. */
  usageTaskId?: string;
  /**
   * Fires exactly once when the loop ends, reporting WHY out-of-band.
   *
   * Callers previously had to infer this by string-matching the returned text
   * for `"[Agent stopped: ...]"`, which cannot distinguish an abort the caller
   * itself requested (a budget cap) from the agent genuinely getting stuck —
   * and misses a stall entirely when the model returned prose alongside it.
   * Branch on this, not on the returned string.
   */
  onStop?: (stop: LoopStop) => void;
  /**
   * Fires with each assistant text fragment as it generates, when the
   * active provider implements `chatStream`. Providers without streaming
   * fall back to blocking `chat()` silently — consumers must still handle
   * the full response (which always supersedes streamed deltas).
   */
  onTextDelta?: (text: string) => void;
  /**
   * Fires with each reasoning/thinking fragment as it generates (#254), when
   * the active provider streams a reasoning trace. Reasoning is a separate
   * channel from {@link onTextDelta}; it's also persisted on the assistant
   * message regardless of streaming.
   */
  onReasoningDelta?: (text: string) => void;
  /**
   * Reasoning effort for this run (#254). Resolved per-agent by
   * `buildLoopOptions` and forwarded to the provider on every chat call, which
   * maps it to its own wire format. Undefined leaves the provider on its
   * configured default.
   */
  thinking?: import("../providers/interface.js").ThinkingLevel;
  /**
   * Cap on generated tokens per chat call. Resolved per-agent by
   * `buildLoopOptions` and forwarded on every call. Undefined omits the field,
   * leaving the provider on its own default — which on a metered provider can
   * mean reserving the model's full output window per request.
   */
  maxTokens?: number;
  /**
   * Provider-specific request fields for the generation call, forwarded
   * untouched as {@link ChatParams.extra}. Resolved per-agent by
   * `buildLoopOptions`; a model chain rung may replace it wholesale.
   *
   * Core sends `temperature` and `max_tokens` and models nothing else, so this
   * is how a deployment reaches sampling controls that only some providers
   * have — vLLM's `repetition_penalty`, `top_k`, `min_p`. Deliberately opaque:
   * core neither validates nor interprets the keys.
   */
  providerExtra?: Record<string, unknown>;
  /** Extra fields merged into the ToolContext passed to every tool execution. */
  toolContextExtras?: Partial<import("../tools/interface.js").ToolContext>;
  permissions?: PermissionsConfig;
  approvalHandler?: ApprovalHandler;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onApprovalResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void;
  /** Sandbox to route shell/file tool ops through. Prepared on loop entry, cleaned up on exit. */
  sandbox?: import("../sandboxes/interface.js").Sandbox;
  /**
   * Extra mounts to pass to `sandbox.prepare()`. Used by the task-watcher
   * to bind-mount the parent repo's `.git/` directory at the same path
   * inside the container so git operations on a linked worktree can
   * follow the `.git` pointer to the parent repo's metadata.
   */
  sandboxMounts?: import("../sandboxes/interface.js").Mount[];
  /** Working directory for tool execution. Defaults to `process.cwd()`. Set by the runtime to an active project's path. */
  cwd?: string;
  /**
   * Progressive-skill catalog. When non-empty, an `Available skills` block is
   * injected into the system prompt and tool calls outside the active skill's
   * allowed-tools list (when one is active) are rejected.
   */
  skillCatalog?: import("./agents.js").SkillCatalogEntry[];
  /**
   * Enable tiered-memory injection (M3 in docs/memory-tiers.md). When true,
   * the loop runs `recallQuery` over the user message and prepends a
   * `[Relevant memory]` block to the system prompt, capped at
   * `memoryInjectBudgetTokens`. Defaults to false to keep behavior unchanged
   * for callers that don't opt in.
   */
  injectMemory?: boolean;
  memoryInjectBudgetTokens?: number;
  memoryInjectLimit?: number;
  /**
   * Lazy accessor for the active memory backend. Wired by
   * `runtime.buildLoopOptions()` from the active `memory.backend.provider`.
   * Resolved once per turn when `injectMemory` is true. Modelled as a
   * thunk so `buildLoopOptions` stays sync (the backend factory may be
   * async).
   */
  getMemoryBackend?: () => Promise<import("../memory/interface.js").MemoryBackend>;
  /** Embedder forwarded to the memory injection's relevance tier so the
   *  backend can run hybrid keyword + semantic recall. Optional. */
  memoryInjectEmbedder?: import("../providers/embedding.js").EmbeddingProvider;
  /**
   * When true, inject `[System: …budget…]` reminders at 50% and 80% of
   * `maxToolRounds` so the model can decide to commit progress before
   * running out of budget. Off by default — opt in per agent via
   * `AgentDefinition.budgetWarnings`.
   */
  budgetWarnings?: boolean;
  /** Fires once per turn when memory injection ran. `pinned` is always-injected preferences; `sources` is the relevance-ranked tier. */
  onMemoryRecalled?: (info: { count: number; sources: string[]; pinned: string[] }) => void;
  /**
   * Customize the system-prompt composition. When undefined the seven built-in
   * layers (base, instructions, context, skill_catalog, core_memory,
   * chat_live_state, recall_memory) render in their default order.
   */
  systemPrompt?: SystemPromptOverride;
  /**
   * Slots declared in `prompt.slots`. Passed in rather than read from config
   * here so the loop keeps knowing nothing about config shape; the runtime
   * re-reads it per turn, so an edit lands without a restart.
   */
  promptSlots?: ConfigDeclaredSlot[];
}

/**
 * What the tool definitions cost on the wire.
 *
 * They ride in their own request field rather than in a message, which is why
 * they were never measured — `estimateTokens` walks messages, and nothing
 * walked these. The model still reads every byte of them.
 *
 * Measured on a production deployment: 42 tools serialise to ~10,857 tokens, so
 * a budget that ignored them overshot by about 10%. Nothing overflowed, because
 * the primary model's window was twice the configured budget; the cost is paid
 * on every request, and the overshoot is inherited by each fallback rung, which
 * re-fits history against a window that is often much tighter.
 *
 * Same 4-chars-per-token approximation as `estimateTokens`, for the same
 * reason: it is provider-independent and errs high on JSON, which is the safe
 * direction for a budget.
 */
export function estimateToolSchemaTokens(schemas: ToolSchema[] | undefined): number {
  if (!schemas?.length) return 0;
  return Math.ceil(JSON.stringify(schemas).length / 4);
}

export function estimateTokens(msg: Message): number {
  // `msg.reasoning` is intentionally excluded: it's display-only and stripped
  // from every outgoing request (#254), so it costs no wire/history budget.
  let length = (msg.content ?? "").length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      length += tc.name.length + JSON.stringify(tc.arguments).length;
    }
  }
  return Math.ceil(length / 4);
}

/**
 * Drop `role: "tool"` messages that aren't answering an open tool call. Trimming
 * the front of the history can leave a tool result whose `assistant` +
 * `tool_calls` parent was dropped; lenient providers (vLLM/qwen) ignore it, but
 * strict ones (OpenAI / Anthropic / Bedrock / DeepSeek) reject the request with
 * "Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'". A tool message is kept only when a preceding assistant turn
 * opened a matching `tool_call` id (a non-tool message closes the group).
 */
export function stripOrphanedToolMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let openIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      result.push(msg);
      openIds = new Set((msg.toolCalls ?? []).map((tc) => tc.id));
    } else if (msg.role === "tool") {
      if (msg.toolCallId && openIds.has(msg.toolCallId)) {
        result.push(msg);
        openIds.delete(msg.toolCallId); // answered — a duplicate would be orphaned
      }
      // else: orphaned tool result — drop it
    } else {
      result.push(msg);
      openIds = new Set(); // user/system message closes any open tool-call group
    }
  }
  return dropUnansweredToolCalls(result);
}

/**
 * The mirror of the pass above: an assistant `tool_calls` with no `tool_result`
 * after it.
 *
 * Every strict provider rejects this outright — DeepSeek "must be followed by
 * tool messages", OpenAI "no tool output found for function call", Anthropic
 * "`tool_use` ids were found without `tool_result` blocks" — so one such pair
 * anywhere in the window fails the whole request, and the fallback chain then
 * fails it again on every rung. Observed in production as three provider errors
 * and 26 retries for a single turn.
 *
 * Only the *forward* direction was handled, on the reasoning that the reverse
 * was unreachable: results are dropped from the front, where their parent goes
 * too. That is true of trimming alone, and it stops being true the moment
 * anything else edits the window — the pass above already resets `openIds` on a
 * user or system message, so a user turn landing between a call and its result
 * drops the result and leaves the call unanswered.
 *
 * "Unreachable, but nothing enforces it" is not a property worth relying on
 * when the failure mode is every provider refusing the request.
 *
 * The unanswered *calls* are removed rather than the whole message, so the
 * assistant's text survives; a message left with neither text nor calls is
 * dropped, since it would carry nothing.
 */
export function dropUnansweredToolCalls(messages: Message[]): Message[] {
  const answered = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) answered.add(msg.toolCallId);
  }

  const out: Message[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.toolCalls?.length) {
      out.push(msg);
      continue;
    }
    const kept = msg.toolCalls.filter((tc) => answered.has(tc.id));
    if (kept.length === msg.toolCalls.length) {
      out.push(msg);
      continue;
    }
    if (kept.length === 0 && !msg.content) continue;
    out.push({ ...msg, toolCalls: kept.length > 0 ? kept : undefined });
  }
  return out;
}

export function trimHistory(messages: Message[], maxTokens: number): Message[] {
  let total = 0;
  for (const msg of messages) total += estimateTokens(msg);

  if (total <= maxTokens) return stripOrphanedToolMessages(messages);

  let start = 0;
  while (start < messages.length - 1 && total > maxTokens) {
    total -= estimateTokens(messages[start]);
    start++;
    // Skip past orphaned tool messages to keep tool-call groups intact
    while (start < messages.length - 1 && messages[start].role === "tool") {
      total -= estimateTokens(messages[start]);
      start++;
    }
  }
  return stripOrphanedToolMessages(ensureUserMessagePresent(messages.slice(start), messages));
}

/** Roughly what `markDroppedHistory`'s line costs, reserved before trimming. */
const DROP_MARKER_TOKENS = 32;

/**
 * Say that the conversation does not start where it appears to.
 *
 * `trimHistory` drops the oldest messages and returns the rest, so the model
 * was handed a conversation beginning mid-thought with nothing to indicate
 * anything preceded it. It cannot distinguish "this is where we began" from
 * "the beginning was evicted", and it answers as though the former.
 *
 * The mechanism for saying so already existed — `summarizeOnTrim` inserts
 * `[Earlier conversation summary: …]` — but it has no default, so the silent
 * path is the one nearly every deployment runs.
 *
 * Deliberately a statement of fact and not an instruction. Telling the model to
 * "ask if you need anything from earlier" is the shape of instruction that gets
 * taken up far more often than intended, and an agent that opens every turn by
 * asking about its own trimmed history is worse than one that does not know.
 */
export function markDroppedHistory(history: Message[], trimmed: Message[]): Message[] {
  const dropped = history.length - trimmed.length;
  if (dropped <= 0) return trimmed;
  const noun = dropped === 1 ? "message" : "messages";
  return [
    {
      role: "user",
      content: `[System: ${dropped} earlier ${noun} in this conversation are no longer shown. It continues from here.]`,
    },
    ...trimmed,
  ];
}

/**
 * Safety net: if trimming dropped every user-role message, splice the
 * first one back in. Providers (vLLM, OpenAI, Anthropic) all reject
 * requests with no user message — we'd rather show a stale task prompt
 * than crash with "No user query found in messages." See Phase 7
 * (docs/agent-unification.md).
 */
function ensureUserMessagePresent(trimmed: Message[], original: Message[]): Message[] {
  if (trimmed.some((m) => m.role === "user")) return trimmed;
  const firstUser = original.find((m) => m.role === "user");
  if (!firstUser) return trimmed;
  // Insert after any leading system summary block so the chronology is
  // [system summary?, original task, ...kept turns].
  const insertAt = trimmed.findIndex((m) => m.role !== "system");
  if (insertAt === -1) return [...trimmed, firstUser];
  return [...trimmed.slice(0, insertAt), firstUser, ...trimmed.slice(insertAt)];
}

/** Validate tool arguments against the tool's parameter schema. Returns an error string or null if valid. */
function validateToolArgs(tool: Tool, args: Record<string, unknown>): string | null {
  const schema = tool.parameters as {
    required?: string[];
    properties?: Record<string, { type?: string }>;
  };
  if (!schema) return null;

  // Check required parameters
  const required = schema.required ?? [];
  const missing = required.filter((name) => args[name] === undefined && args[name] !== null);
  if (missing.length > 0) {
    return `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`;
  }

  // Basic type checks for provided parameters
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    const prop = properties[key];
    if (!prop?.type) continue;

    const actual = typeof value;
    if (prop.type === "string" && actual !== "string") {
      return `Parameter "${key}" should be a string, got ${actual}`;
    }
    if (prop.type === "number" && actual !== "number") {
      return `Parameter "${key}" should be a number, got ${actual}`;
    }
    if (prop.type === "boolean" && actual !== "boolean") {
      return `Parameter "${key}" should be a boolean, got ${actual}`;
    }
    if (prop.type === "array" && !Array.isArray(value)) {
      return `Parameter "${key}" should be an array, got ${actual}`;
    }
  }

  return null;
}

/** Summarize messages that would be dropped during trimming. Exported so the
 * end-of-session summarizer (M4) can reuse the same renderer + prompt. */
export async function summarizeMessages(messages: Message[], provider: AIProvider, model: string): Promise<string> {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.content) {
      lines.push(`[${msg.role}]: ${msg.content.slice(0, 300)}`);
    } else if (msg.toolCalls) {
      lines.push(`[${msg.role}]: called ${msg.toolCalls.map((tc) => tc.name).join(", ")}`);
    }
  }
  const transcript = lines.join("\n").slice(0, 3000);

  try {
    const response = await provider.chat({
      model,
      messages: [
        {
          role: "system",
          content:
            "Summarize this conversation excerpt in 2-3 sentences. Preserve key facts, decisions, and any pending tasks. Be concise.",
        },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
    });
    return response.content ?? "";
  } catch {
    // If summarization fails, fall back to silent trimming
    return "";
  }
}

/**
 * Trim history with optional summarization of dropped messages.
 * Returns the trimmed message array and an optional summary of what was dropped.
 */
export async function trimHistoryWithSummary(
  messages: Message[],
  maxTokens: number,
  provider?: AIProvider,
  model?: string,
  existingSummary?: string,
): Promise<{ messages: Message[]; summary?: string }> {
  let total = 0;
  for (const msg of messages) total += estimateTokens(msg);

  if (total <= maxTokens) return { messages: stripOrphanedToolMessages(messages), summary: existingSummary };

  // Figure out which messages will be dropped
  let start = 0;
  let dropTotal = total;
  while (start < messages.length - 1 && dropTotal > maxTokens) {
    dropTotal -= estimateTokens(messages[start]);
    start++;
    while (start < messages.length - 1 && messages[start].role === "tool") {
      dropTotal -= estimateTokens(messages[start]);
      start++;
    }
  }

  const dropped = messages.slice(0, start);
  const kept = messages.slice(start);

  // Summarize dropped messages if provider is available and we're actually dropping content
  if (provider && model && dropped.length > 0 && !existingSummary) {
    const summary = await summarizeMessages(dropped, provider, model);
    if (summary) {
      const summaryMsg: Message = {
        role: "system",
        content: `[Earlier conversation summary: ${summary}]`,
      };
      return {
        messages: stripOrphanedToolMessages(ensureUserMessagePresent([summaryMsg, ...kept], messages)),
        summary,
      };
    }
  } else if (existingSummary) {
    // Re-use cached summary from a previous round
    const summaryMsg: Message = {
      role: "system",
      content: `[Earlier conversation summary: ${existingSummary}]`,
    };
    return {
      messages: stripOrphanedToolMessages(ensureUserMessagePresent([summaryMsg, ...kept], messages)),
      summary: existingSummary,
    };
  }

  return { messages: stripOrphanedToolMessages(ensureUserMessagePresent(kept, messages)) };
}

/** Request approval with timeout handling. */
async function requestApprovalWithTimeout(
  handler: ApprovalHandler,
  request: ApprovalRequest,
  permissions: PermissionsConfig,
): Promise<ApprovalResponse> {
  const timeoutMs = permissions.timeoutMs ?? 300000;
  if (timeoutMs <= 0) {
    return handler.requestApproval(request);
  }

  const _startTime = Date.now();
  const result = await Promise.race([
    handler.requestApproval(request),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  if (result === null) {
    // Timeout
    if (permissions.timeoutAction === "auto_approve") {
      return { approved: true, reason: "auto-approved on timeout", responseTimeMs: timeoutMs };
    }
    return { approved: false, reason: `approval timed out after ${timeoutMs}ms`, responseTimeMs: timeoutMs };
  }
  return result;
}

/**
 * What one tool call produced: the string that becomes history, plus whether
 * the tool asked to end the turn. Only a tool that actually ran can end one —
 * every rejection path below returns output alone, so a call the loop refused
 * cannot stop it.
 */
interface ToolCallOutcome {
  output: string;
  endsTurn?: boolean;
  endsTurnReason?: string;
}

/** Execute a single tool call with approval gate, validation, and timing. */
async function executeToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  currentToolNames: string[],
  context: ToolContext,
  opts: AgentLoopOptions,
): Promise<ToolCallOutcome> {
  const tool = toolMap.get(call.name);

  if (!tool) {
    return { output: `Error: Unknown tool "${call.name}". Available tools: ${currentToolNames.join(", ")}` };
  }

  // --- Active-skill allowed-tools gate ---
  // When a skill is active and declares an `allowed-tools` list, every tool
  // call outside that list is rejected. `load_skill` is always permitted so
  // the agent can deactivate or swap skills.
  const active = context.activeSkill?.current;
  if (
    active &&
    active.allowedTools.length > 0 &&
    call.name !== "load_skill" &&
    !active.allowedTools.includes(call.name)
  ) {
    return {
      output: `Error: tool "${call.name}" is not in skill "${active.id}"'s allowed-tools list (${active.allowedTools.join(", ")}). Deactivate the skill with load_skill(name: "__deactivate__") to access other tools.`,
    };
  }

  const validationError = validateToolArgs(tool, call.arguments);
  if (validationError) {
    return {
      output: `Error: ${validationError}. Expected parameters: ${JSON.stringify(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}))}`,
    };
  }

  // --- Approval gate ---
  let approvalTimeMs: number | undefined;
  const permission = evaluatePermission(call.name, call.arguments, opts.permissions);
  if (permission === "approve") {
    if (!opts.approvalHandler) {
      // Nothing can ask: cron, rooms, the task watcher, webhooks — every path
      // with no human attached. This used to be an empty block with a comment,
      // so a policy of "approve" quietly became "auto" precisely where nobody
      // was watching, and the config said one thing while the deployment did
      // another.
      //
      // Still permissive by default, on purpose. Flipping it would stop
      // autonomous runs that have worked for months, and a guard that breaks
      // what it protects is the shape this codebase keeps hitting. What
      // changes is that it says so.
      if ((opts.permissions?.noHandlerAction ?? "auto") === "reject") {
        return {
          output: `Tool call rejected: "${call.name}" needs approval and no approver is available on this path. Ask the owner directly, or do the part that does not need approval.`,
        };
      }
      warnNoApprover(call.name);
    } else {
      const request: ApprovalRequest = {
        requestId: createApprovalRequestId(),
        toolName: call.name,
        toolArgs: call.arguments,
        sessionId: opts.session.id,
        description: formatApprovalDescription(call.name, call.arguments),
      };

      opts.onApprovalRequest?.(request);
      const response = await requestApprovalWithTimeout(opts.approvalHandler, request, opts.permissions!);
      opts.onApprovalResponse?.(request, response);

      if (!response.approved) {
        const reason = response.reason ? ` Reason: ${response.reason}` : "";
        return { output: `Tool call rejected by user.${reason}\n[user responded in ${response.responseTimeMs}ms]` };
      }
      approvalTimeMs = response.responseTimeMs;
    }
  }

  // --- Execute tool ---
  const startTime = Date.now();
  const result = await tool.execute(call.arguments, context);
  const durationMs = Date.now() - startTime;
  const rawOutput = result.success ? result.output : `Error: ${result.error ?? "Unknown error"}`;
  // Capped here, at the one conversion from ToolResult to the string that
  // becomes history. Every tool — builtin, custom, plugin, MCP — funnels
  // through this call, and it sits upstream of onToolResult, the tool
  // Message, saveMessage and the repeat detector, so all of them see the
  // same bounded string.
  let resultOutput = await capToolOutput(rawOutput, {
    toolName: call.name,
    limit: resolveToolOutputLimit(call.name, opts.toolOutputLimits, opts.maxToolOutputChars),
    sessionId: opts.session.id,
    scratchDir: opts.toolOutputDir,
  });
  if (approvalTimeMs !== undefined) {
    resultOutput += `\n[approved in ${approvalTimeMs}ms, tool completed in ${durationMs}ms]`;
  } else if (durationMs >= 100) {
    resultOutput += `\n[completed in ${durationMs}ms]`;
  }
  // Read from the same place the output is: a tool that failed can still mean
  // to end the turn, so this is deliberately not gated on `result.success`.
  return { output: resultOutput, endsTurn: result.endsTurn, endsTurnReason: result.endsTurnReason };
}

function toolsToSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runAgentLoop(userMessage: string, opts: AgentLoopOptions): Promise<string> {
  try {
    return await _runAgentLoopInner(userMessage, opts);
  } finally {
    opts.onActivity?.(null);
  }
}

/**
 * Say something when the context block gets big.
 *
 * The `<context>` layer is the one part of the system prompt with no cap: it is
 * every `.md` in the global directory plus every `.md` in the agent's, read
 * whole, from disk, on every turn. When it grows, nothing truncates it —
 * `historyBudget = maxHistoryTokens - systemPromptTokens`, so it quietly eats
 * the conversation instead, and the symptom is an agent that forgets rather
 * than an agent with a big prompt.
 *
 * Observed before this existed: 4.6 KB of global context, of which 2.4 KB was a
 * stale question queue belonging to one agent, injected into all 27 — roughly
 * 2.3× the "keep preambles under ~500 tokens" guideline in CLAUDE.md, spent
 * before any agent said anything.
 *
 * Warned rather than truncated. Cutting a context file mid-sentence would be a
 * silent, confusing loss, and which file to drop is a judgement this code
 * cannot make. Once per agent per process, because it is a property of the
 * configuration, not of the turn.
 */
/**
 * A call that needed approval ran because nothing could ask.
 *
 * Once per tool per process: this is a property of how the deployment is
 * wired, not of the turn, and repeating it every time would bury it. Say
 * `noHandlerAction: reject` to make the policy real on these paths.
 */
const _warnedNoApprover = new Set<string>();
function warnNoApprover(toolName: string): void {
  if (_warnedNoApprover.has(toolName)) return;
  _warnedNoApprover.add(toolName);
  console.warn(
    `[permissions] "${toolName}" is configured to need approval, but this path has no approver ` +
      `(cron, rooms, task watcher or webhook) — running it anyway. ` +
      `Set permissions.noHandlerAction: reject to refuse instead.`,
  );
}

/**
 * Say when the history budget has been spent before any history is counted.
 *
 * `historyBudget = maxHistoryTokens − systemPrompt − tail − toolSchemas`, and
 * since tool schemas started counting (#421) they are the largest term by an
 * order of magnitude: 24 tools measure ~5,500 tokens, the reference deployment's
 * 41 measure ~10,900. `DEFAULT_CONFIG.maxHistoryTokens` is **2,000**. So a
 * deployment that never tuned it has a budget of zero, drops the entire
 * conversation on every turn, and looks — from the outside — like a model with
 * no memory rather than a configuration that cannot hold one.
 *
 * Found by the scenario benchmark: with the default and a 24-tool set, a fact
 * stated two messages earlier never reached the model at all; with the same
 * scenario at 20,000 it did, every time.
 *
 * Warned rather than silently floored. Raising the budget behind the operator's
 * back would build a request the model's context may not accept, and which
 * number is right depends on the model — a judgement this code cannot make. Once
 * per agent per process, because it is a property of the configuration and not
 * of the turn.
 */
const _warnedNoHistoryBudget = new Set<string>();

export function warnIfNoHistoryFits(
  m: {
    maxHistoryTokens: number;
    systemPromptTokens: number;
    tailTokens: number;
    toolSchemaTokens: number;
    historyBudget: number;
    historyLength: number;
  },
  agentName?: string,
): void {
  // Only when there is something to lose: a first turn has no history, and
  // warning there would fire for every fresh session in a healthy deployment.
  if (m.historyBudget > 0 || m.historyLength <= 1) return;
  const key = agentName ?? "(unnamed)";
  if (_warnedNoHistoryBudget.has(key)) return;
  _warnedNoHistoryBudget.add(key);
  const overhead = m.systemPromptTokens + m.tailTokens + m.toolSchemaTokens;
  console.warn(
    `[context] ${key}: agent.maxHistoryTokens is ${m.maxHistoryTokens}, but the system prompt, tail and ` +
      `tool schemas already cost ~${overhead} tokens (~${m.toolSchemaTokens} of that is tool schemas). ` +
      `That leaves nothing for the conversation, so all ${m.historyLength} messages are dropped every turn and ` +
      `the agent cannot remember what was said a moment ago. Raise agent.maxHistoryTokens above ~${overhead}, ` +
      `or give this agent fewer tools.`,
  );
}

/** Test seam: the warning fires once per agent per process. */
export function resetHistoryBudgetWarnings(): void {
  _warnedNoHistoryBudget.clear();
}

export const DEFAULT_CONTEXT_WARN_TOKENS = 4000;
const _warnedContextAgents = new Set<string>();

export function warnIfContextIsLarge(contextContent: string, agentName?: string, threshold?: number): void {
  if (!contextContent) return;
  const limit = threshold ?? DEFAULT_CONTEXT_WARN_TOKENS;
  if (limit <= 0) return;
  const tokens = estimateTokens({ role: "system", content: contextContent });
  if (tokens <= limit) return;

  const key = agentName ?? "(unnamed)";
  if (_warnedContextAgents.has(key)) return;
  _warnedContextAgents.add(key);
  console.warn(
    `[context] ${key}: context files are ~${tokens} tokens and are injected on every turn. ` +
      `Nothing truncates them — they come out of the history budget instead. If that is deliberate, ` +
      `raise or disable context.warnTokens; otherwise check for agent-specific material in the ` +
      `global directory, or content that has gone stale.`,
  );
}

async function _runAgentLoopInner(userMessage: string, opts: AgentLoopOptions): Promise<string> {
  const { session, db, extraInstructions, contextDir, agentContextDir } = opts;

  let contextContent = "";
  if (opts.skipGlobalContext && agentContextDir) {
    // Load only agent-specific context files (skip global context to reduce prompt size)
    contextContent = await loadContextFiles(agentContextDir);
  } else if (contextDir) {
    contextContent = await loadAllContext(contextDir, agentContextDir);
  }
  warnIfContextIsLarge(contextContent, opts.toolContextExtras?.agentName as string | undefined, opts.contextWarnTokens);
  const catalogBlock = renderSkillCatalog(opts.skillCatalog);

  // Core memory: always-injected identity layer (docs/agent-unification.md).
  // Read fresh from DB at the start of every turn so updates from other
  // sessions (chat, tick, delegate) are visible immediately on the next turn.
  // No bloat-on-stack concern: this is the system prompt, rebuilt each call.
  // agentName comes through toolContextExtras (set by every entry point
  // that runs a named agent — chat, tick worker, delegate, workflow).
  let coreMemoryBlock = "";
  let chatLiveBlock = "";
  const agentNameForCore = opts.toolContextExtras?.agentName as string | undefined;
  const isExploratoryTick = !!opts.toolContextExtras?.exploratoryRunId;
  if (agentNameForCore) {
    const rows = getCoreMemory(db, {
      agent: agentNameForCore,
      project_id: session.projectId ?? null,
    });
    if (rows.length > 0) {
      const rendered = renderCoreMemory(rows, { maxBytes: 8192 });
      if (rendered) coreMemoryBlock = `\n\n# Core memory (your identity across sessions)\n\n${rendered}`;
    }
    // Chat live_state: recent ticks + in-flight + pending. Only for chat
    // sessions (not ticks — ticks get the TickContext Situation block,
    // built and prepended by the exploratory worker; not delegates —
    // they see the parent task only). Heuristic: no exploratoryRunId.
    if (!isExploratoryTick) {
      const state = buildChatLiveState(db, agentNameForCore, session.projectId ?? null);
      const rendered = renderChatLiveState(state);
      if (rendered) chatLiveBlock = `\n\n${rendered}`;
    }
  }

  let memoryBlock = "";
  if (opts.injectMemory && opts.getMemoryBackend) {
    const backend = await opts.getMemoryBackend();
    const meta = await buildMemoryBlockWithMeta(backend, {
      userMessage,
      projectId: session.projectId ?? null,
      budgetTokens: opts.memoryInjectBudgetTokens,
      limit: opts.memoryInjectLimit,
      embedder: opts.memoryInjectEmbedder,
      // Same source core memory uses. Undefined for an unnamed session, which
      // then keeps the old cross-agent view rather than seeing nothing.
      agent: agentNameForCore,
    });
    memoryBlock = meta.block;
    const total = meta.included.length + meta.pinned.length;
    if (total > 0) {
      opts.onMemoryRecalled?.({
        count: total,
        sources: meta.included.map((h) => h.source),
        pinned: meta.pinned.map((p) => p.noteId),
      });
    }
  }
  // Composition runs through composeSystemPrompt (agent/system-prompt.ts).
  // Default order: base + instructions + context + skill_catalog + core_memory
  // + chat_live_state + recall_memory. Identity (core) first, then live_state,
  // then recall. live_state only appears in chat; ticks build their own
  // Situation block in the worker. Agents can override via systemPrompt config.
  // The self-modification paragraph is told only to agents that hold a tool
  // which can carry it out. Read from the resolved tool set rather than config,
  // so it tracks what the agent can actually do this turn — including a skill's
  // narrowing and any per-call extras.
  // Plugin- and config-contributed blocks. Rendered here, placed by core: the
  // contributor said only whether its content changes between turns.
  const slotBlocks = renderContextSlots(
    {
      agent: agentNameForCore,
      projectId: session.projectId ?? null,
      sessionId: session.id,
      userMessage,
    },
    // Registered slots plus whatever config declares. Config ones are rebuilt
    // per turn so a `file:` edit lands without a restart.
    [...listContextSlots(), ...slotsFromConfig(opts.promptSlots, (path) => readFileSync(path, "utf8"))],
  );

  const resolvedBase = resolveBase(opts.systemPrompt, { selfModifying: opts.selfModifying });
  const customLayers = resolveCustomLayers(opts.systemPrompt?.custom);
  const builtInLayers = {
    instructions: extraInstructions,
    context: contextContent,
    skill_catalog: catalogBlock,
    core_memory: coreMemoryBlock,
    chat_live_state: chatLiveBlock,
    recall_memory: memoryBlock,
    slots_standing: slotBlocks.reload,
    slots_state: slotBlocks.turn,
  };
  const fullSystemPrompt = composeSystemPrompt(resolvedBase, builtInLayers, opts.systemPrompt, customLayers);
  const systemPromptTokens = estimateTokens({ role: "system", content: fullSystemPrompt });

  // Layers that change every turn ride behind the history instead of in front
  // of it, so the prompt and the history stay a cacheable prefix. Role "user"
  // rather than "system" for the same reason the tool-update notice below is:
  // vLLM in strict OpenAI mode rejects mid-history system messages.
  const tailBlock = composeTailBlock(builtInLayers, opts.systemPrompt, customLayers);
  const tailMsg: Message | undefined = tailBlock
    ? { role: "user", content: `[System: current context, refreshed each turn]\n\n${tailBlock}` }
    : undefined;

  const history = getSessionMessages(db, session.id);

  const userMsg: Message = { role: "user", content: userMessage };
  saveMessage(db, session.id, userMsg);
  history.push(userMsg);

  const workingDirectory = opts.cwd ?? process.cwd();
  const sandboxHandle = opts.sandbox
    ? await opts.sandbox.prepare({ cwd: workingDirectory, mounts: opts.sandboxMounts })
    : undefined;
  const cleanupSandbox = async () => {
    if (opts.sandbox && sandboxHandle) {
      try {
        await opts.sandbox.cleanup(sandboxHandle);
      } catch (err) {
        console.error("[loop] sandbox cleanup failed:", (err as Error).message);
      }
    }
  };

  const activeSkill: ActiveSkillState = createActiveSkillState();
  const workingMemory = new Map<string, string>();
  const context: ToolContext = {
    sessionId: session.id,
    workingDirectory,
    env: {},
    agentContextDir,
    kbDir: opts.kbDir,
    agentKbDir: opts.agentKbDir,
    approvalHandler: opts.approvalHandler,
    permissions: opts.permissions,
    db,
    sandbox: opts.sandbox,
    sandboxHandle,
    activeSkill,
    workingMemory,
    projectId: session.projectId ?? null,
    ...opts.toolContextExtras,
  };

  try {
    return await _runAgentLoopBody(userMessage, opts, context, fullSystemPrompt, systemPromptTokens, history, tailMsg);
  } finally {
    await cleanupSandbox();
  }
}

async function _runAgentLoopBody(
  _userMessage: string,
  opts: AgentLoopOptions,
  context: ToolContext,
  fullSystemPrompt: string,
  systemPromptTokens: number,
  history: Message[],
  tailMsg?: Message,
): Promise<string> {
  const { provider, session, db, tools, maxToolRounds, maxHistoryTokens, temperature } = opts;
  const tailTokens = tailMsg ? estimateTokens(tailMsg) : 0;
  // Same source the core-memory lookup uses: every entry point that runs a
  // named agent sets it. Undefined for the default/unnamed session.
  const usageAgent = opts.toolContextExtras?.agentName as string | undefined;

  let rounds = 0;
  let prevToolNames: string[] | undefined;
  let nudgesRemaining = opts.nudgeOnText ?? 0;
  let lastCallSignature = "";
  let lastResultSignature = "";
  let repeatCount = 0;
  let cachedSummary: string | undefined;
  const MAX_REPEATED_CALLS = 3;
  // Tracks which budget warnings have already fired so we inject each at
  // most once per loop. Without this the warning would replay every round
  // past the threshold.
  const firedBudgetWarnings = new Set<"half" | "near-end">();
  const halfBudget = Math.max(1, Math.floor(maxToolRounds * 0.5));
  const nearEndBudget = Math.max(halfBudget + 1, Math.floor(maxToolRounds * 0.8));

  while (rounds < maxToolRounds) {
    if (opts.signal?.aborted) {
      // `reason` is whatever the caller passed to AbortController.abort(). It
      // is how a caller-imposed stop (budget, shutdown) is told apart from a
      // stall — see LoopStop.
      const reason = opts.signal.reason;
      opts.onStop?.({
        kind: "aborted",
        requestedByCaller: true,
        reason: typeof reason === "string" ? reason : undefined,
      });
      return "[Agent stopped: shutdown requested]";
    }
    rounds++;

    // Budget warnings: nudge the model toward committing progress before
    // it runs out of rounds. Off by default; opt in per agent. Critical
    // for coder/reviewer where the failure mode is "burn 60 rounds reading,
    // never write or commit."
    if (opts.budgetWarnings) {
      if (rounds === halfBudget && !firedBudgetWarnings.has("half")) {
        firedBudgetWarnings.add("half");
        history.push({
          role: "user",
          content:
            `[System: tool-budget check — ${rounds}/${maxToolRounds} rounds used. ` +
            `If you've made progress, prefer committing it now over more exploration. ` +
            `A small commit you can hand off is better than no commit.]`,
        });
      }
      if (rounds === nearEndBudget && !firedBudgetWarnings.has("near-end")) {
        firedBudgetWarnings.add("near-end");
        const remaining = maxToolRounds - rounds;
        history.push({
          role: "user",
          content:
            `[System: only ${remaining} rounds left of ${maxToolRounds}. ` +
            `Either commit what you have and hand off, or post a status comment on the task ` +
            `(what you found, what's blocking) and stop. Do NOT keep exploring.]`,
        });
      }
    }

    const currentTools = opts.getTools ? opts.getTools() : tools;
    const currentProvider = opts.getProvider ? opts.getProvider() : provider;
    const toolSchemas = currentTools.length > 0 ? toolsToSchemas(currentTools) : undefined;
    const toolMap = new Map(currentTools.map((t) => [t.name, t]));

    const currentToolNames = currentTools.map((t) => t.name);
    if (
      prevToolNames &&
      (prevToolNames.length !== currentToolNames.length || prevToolNames.some((n, i) => n !== currentToolNames[i]))
    ) {
      // Use role "user" so providers like vLLM (strict OpenAI mode) that
      // reject mid-history system messages still accept it. The [System: ...]
      // prefix keeps the semantic cue for the model.
      history.push({
        role: "user",
        content: `[System: available tools have been updated. Current tools: ${currentToolNames.join(", ")}]`,
      });
    }
    prevToolNames = currentToolNames;

    // Reserve token budget for the system prompt so history + prompt fits in
    // context. The tail costs the same whichever side of the history it sits
    // on, so it is reserved too, and so do the tool schemas — they are a
    // separate request field rather than a message, which is how they went
    // uncounted, not a sign that they are free.
    //
    // Recomputed per round rather than hoisted: `getTools()` re-resolves every
    // round, so a turn that gains or loses tools mid-flight changes this. One
    // number computed once would be wrong for the rest of the turn.
    const toolSchemaTokens = estimateToolSchemaTokens(toolSchemas);
    const historyBudget = Math.max(0, maxHistoryTokens - systemPromptTokens - tailTokens - toolSchemaTokens);
    warnIfNoHistoryFits(
      {
        maxHistoryTokens,
        systemPromptTokens,
        tailTokens,
        toolSchemaTokens,
        historyBudget,
        historyLength: history.length,
      },
      opts.toolContextExtras?.agentName as string | undefined,
    );
    let trimmed: Message[];
    if (opts.summarizeOnTrim) {
      const currentProvider = opts.getProvider ? opts.getProvider() : provider;
      const result = await trimHistoryWithSummary(
        history,
        historyBudget,
        currentProvider,
        session.model,
        cachedSummary,
      );
      trimmed = result.messages;
      if (result.summary) cachedSummary = result.summary;
    } else {
      // Reserve room for the marker before trimming rather than prepending it
      // afterwards, which would push the request back over the budget it was
      // just trimmed to fit.
      const historyTokens = history.reduce((n, m) => n + estimateTokens(m), 0);
      const overBudget = historyTokens > historyBudget;
      trimmed = trimHistory(history, overBudget ? Math.max(0, historyBudget - DROP_MARKER_TOKENS) : historyBudget);
      trimmed = markDroppedHistory(history, trimmed);
    }
    const messages: Message[] = [{ role: "system", content: fullSystemPrompt }, ...trimmed];
    if (tailMsg) messages.push(tailMsg);

    const chain = opts.getModelChain?.() ?? [];
    const candidates: ModelCandidate[] =
      chain.length > 0 ? chain : [{ provider: currentProvider, model: session.model, label: currentProvider.id }];

    /**
     * The history above was sized from `maxHistoryTokens`, which is a
     * deployment-wide number, not this rung's window. A chain that mixes window
     * sizes would otherwise build a request the head can accept and the
     * fallback cannot — and if every remaining rung is smaller, the turn fails
     * looking like an outage rather than a budget mistake.
     *
     * Re-trimmed only when the rung is actually smaller, so the common case
     * (every rung roomy, or a chain of one) reuses the array untouched and pays
     * nothing. `maxContextTokens` is the whole request, so the system prompt
     * comes out of it too.
     *
     * The re-trim is the plain one even under `summarizeOnTrim`: summarising is
     * an async model call, and spending one on the degraded path to produce a
     * prettier request the rung might still reject is the wrong trade. A
     * request the fallback accepts beats a well-summarised one it does not.
     */
    const paramsFor = (candidate: ModelCandidate): Omit<ChatParams, "model"> => {
      const base = {
        tools: toolSchemas,
        temperature,
        thinking: opts.thinking,
        maxTokens: opts.maxTokens,
        extra: opts.providerExtra,
      };
      const window = candidate.maxContextTokens;
      if (window === undefined || window >= maxHistoryTokens) return { ...base, messages };

      // Same subtraction as the main budget, and it matters more here: this
      // window is usually the tight one, and `base.tools` sends the identical
      // schemas to a rung with far less room for them.
      const rungBudget = Math.max(0, window - systemPromptTokens - tailTokens - toolSchemaTokens);
      const refitted = trimHistory(history, rungBudget);
      if (refitted.length < trimmed.length) {
        console.warn(
          `[agent] ${candidate.label} (${candidate.model}) has a ${window}-token window against a ` +
            `${maxHistoryTokens}-token budget — trimming ${trimmed.length - refitted.length} more message(s) for it.`,
        );
      }
      // The volatile tail rides behind the history and must survive the refit:
      // rebuilding the array from the system prompt alone would drop the live
      // state and recall the model is meant to read this turn.
      const refittedMessages: Message[] = [{ role: "system", content: fullSystemPrompt }, ...refitted];
      if (tailMsg) refittedMessages.push(tailMsg);
      return { ...base, messages: refittedMessages };
    };

    const { response, candidate: answeredBy } = await chatWithFallback(
      candidates,
      paramsFor,
      opts.onTextDelta,
      opts.onReasoningDelta,
    );

    if (response.usage) {
      // Record before the callback: a throwing consumer must not cost us the
      // accounting row, which is the whole point of measuring here rather than
      // leaving it to each caller (only two of which ever did).
      try {
        recordTokenUsage(db, {
          sessionId: session.id,
          taskId: opts.usageTaskId,
          agent: usageAgent,
          source: opts.usageSource ?? "loop",
          promptTokens: response.usage.input,
          completionTokens: response.usage.output,
          cacheReadTokens: response.usage.cacheRead,
          cacheWriteTokens: response.usage.cacheWrite,
        });
      } catch (e) {
        console.error("[agent] token usage recording failed:", (e as Error).message);
      }

      if (opts.onUsage) {
        try {
          opts.onUsage(response.usage);
        } catch (e) {
          console.error("[agent] onUsage callback error:", (e as Error).message);
        }
      }
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
      // Persisted for display only — stripped from every outgoing request by
      // the message→wire converters, so it never re-enters the model (#254).
      reasoning: response.reasoning,
    };
    saveMessage(db, session.id, assistantMsg);
    history.push(assistantMsg);

    // Truncation is checked before the nudge and before the complete path: a
    // turn cut off mid-thought has not finished, and nudging a model that ran
    // out of budget just spends another round arriving at the same place.
    if (response.finishReason === "length") {
      const noOutput = !(response.content ?? "").trim() && !response.toolCalls?.length;
      // The rung that answered may carry its own cap, so report the one that
      // actually bit. Naming the deployment default when a fallback's override
      // is what truncated the turn sends the operator to the wrong setting.
      const effectiveMaxTokens = answeredBy.maxTokens ?? opts.maxTokens;
      const stop = {
        kind: "truncated" as const,
        model: answeredBy.model,
        maxTokens: effectiveMaxTokens,
        outputTokens: response.usage?.output,
        spentOnReasoning: noOutput && !!response.reasoning,
      };
      if (noOutput) {
        const explanation = describeTruncation(stop);
        console.warn(`[agent] ${explanation}`);
        opts.onStop?.(stop);
        // Returned rather than logged only: an empty string here reads as "the
        // model had nothing to say", which is the misdiagnosis this exists to
        // prevent.
        return explanation;
      }
      // Answered, but cut off mid-sentence. Worth a line; not worth discarding.
      console.warn(
        `[agent] ${answeredBy.model} hit its output limit mid-reply (maxTokens ${effectiveMaxTokens ?? "unset"})`,
      );
    }

    if (response.finishReason === "stop" || !response.toolCalls?.length) {
      // Nudge: if the model stopped with text but hasn't completed its task, re-prompt
      if (nudgesRemaining > 0) {
        nudgesRemaining--;
        console.log(
          `  [nudge ${opts.nudgeOnText! - nudgesRemaining}/${opts.nudgeOnText}] model said: "${(response.content ?? "").slice(0, 100)}"`,
        );
        // Use custom nudge message only on the final nudge; earlier nudges push the model to keep working
        const isLastNudge = nudgesRemaining === 0;
        const nudgeMsg: Message = {
          role: "user",
          content:
            isLastNudge && opts.nudgeMessage
              ? opts.nudgeMessage
              : "Good. Now continue with the next step. What tool call should you make next?",
        };
        saveMessage(db, session.id, nudgeMsg);
        history.push(nudgeMsg);
        continue;
      }
      opts.onStop?.({ kind: "complete" });
      return response.content ?? "";
    }

    // Fire onActivity with the agent's reasoning text (if any) before executing tool calls
    const reasoningText = (response.content as string | undefined)?.trim() ?? "";
    if (reasoningText && opts.onActivity) {
      const firstSentence = reasoningText.split(/[.!?\n]/)[0].trim();
      opts.onActivity(firstSentence || reasoningText.slice(0, 100));
    }

    const callSignature = response.toolCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join("|");

    // Execute all tool calls in parallel (with approval gate per call)
    const results = await Promise.all(
      response.toolCalls.map(async (call) => {
        opts.onToolCall?.(call.name, call.arguments);
        const outcome = await executeToolCall(call, toolMap, currentToolNames, context, opts);
        opts.onToolResult?.(call.name, outcome.output);
        return { call, ...outcome };
      }),
    );

    // Add all tool results to history in original order
    for (const { call, output } of results) {
      const toolMsg: Message = {
        role: "tool",
        content: output,
        toolCallId: call.id,
      };
      saveMessage(db, session.id, toolMsg);
      history.push(toolMsg);
    }

    // A tool asked to end the turn — see ToolResult.endsTurn.
    //
    // After the history writes above, so the record of what the tool did is
    // complete even though nothing will read it back. Before the repeat
    // detector below, because a tool that ends the turn on every call looks
    // exactly like a model stuck in a loop, and reaching the detector would
    // report the most deliberate stop there is as a stall.
    //
    // First writer wins when several calls in one round end the turn. They all
    // ran and all recorded; picking between their reasons would be inventing a
    // rule for a case no tool set has a meaningful answer to.
    const ender = results.find((r) => r.endsTurn);
    if (ender) {
      opts.onStop?.({ kind: "tool-ended", tool: ender.call.name, reason: ender.endsTurnReason });
      return ender.endsTurnReason ?? response.content ?? "";
    }

    // Detect a stuck model: same call AND same result, repeated. We use the
    // result too so legitimate polling (e.g. task_status running → running →
    // completed) doesn't trip the detector — only genuine "no progress"
    // loops do.
    const resultSignature = results.map((r) => r.output).join("|");
    if (callSignature === lastCallSignature && resultSignature === lastResultSignature) {
      repeatCount++;
    } else {
      repeatCount = 1;
    }
    lastCallSignature = callSignature;
    lastResultSignature = resultSignature;

    if (repeatCount >= MAX_REPEATED_CALLS) {
      // Fires even when the model produced prose alongside the loop — that is
      // precisely the case a string-matching caller cannot see.
      opts.onStop?.({ kind: "repeated-calls" });
      return response.content || "[Agent stopped: repeated identical tool calls detected]";
    }
  }

  opts.onStop?.({ kind: "max-rounds", rounds });
  return "[Agent stopped: max tool rounds reached]";
}

/**
 * Render the agentskills.io progressive-disclosure catalog into a system-prompt
 * suffix. Empty / undefined input returns an empty string so back-compat
 * (eager-merged or skill-less agents) carries no extra prompt overhead.
 */
function renderSkillCatalog(catalog: SkillCatalogEntry[] | undefined): string {
  if (!catalog || catalog.length === 0) return "";
  const lines: string[] = [
    "",
    "",
    "## Available skills",
    "**These are not loaded.** Below is one line per skill — a label, not the instructions.",
    "The instructions are not in this prompt until you call `load_skill(name: <id>)`.",
    "",
    "Load a skill before starting a task it covers — **including when you already know how**.",
    "A skill is the current shared instructions and gets corrected over time; your recollection",
    "of a tool is whatever happened to work last time, which may since have changed or may",
    "never have been right.",
    "",
  ];
  for (const s of catalog) {
    const desc = s.description ? `: ${s.description}` : "";
    lines.push(`- ${s.id}${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}
