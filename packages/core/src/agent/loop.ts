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
import { getCoreMemory, renderCoreMemory } from "../db/core-memory-queries.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import type { AIProvider, ChatParams, ChatResponse, Message, ToolCall, ToolSchema } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import { type ActiveSkillState, createActiveSkillState } from "./active-skill.js";
import type { SkillCatalogEntry } from "./agents.js";
import { buildChatLiveState, renderChatLiveState } from "./chat-live-state.js";
import { buildMemoryBlockWithMeta } from "./memory-inject.js";
import type { Session } from "./session.js";
import { composeSystemPrompt, resolveBase, resolveCustomLayers, type SystemPromptOverride } from "./system-prompt.js";

const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

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
): Promise<ChatResponse> {
  const stream = provider.chatStream?.bind(provider);
  if ((!onTextDelta && !onReasoningDelta) || !stream) {
    return withRetry(() => provider.chat(params));
  }
  let emitted = false;
  return withRetry(async () => {
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

export interface AgentLoopOptions {
  provider: AIProvider;
  session: Session;
  db: Database.Database;
  tools: Tool[];
  extraInstructions: string;
  maxToolRounds: number;
  maxHistoryTokens: number;
  temperature: number;
  contextDir?: string;
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
  getTools?: () => Tool[];
  getProvider?: () => AIProvider;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
  /** Fires with a short description when the agent emits reasoning text before tool calls. Fires null when the loop ends. */
  onActivity?: (description: string | null) => void;
  /** Fires after each provider.chat() with token counts from the response. */
  onUsage?: (usage: { input: number; output: number }) => void;
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
}

export function estimateTokens(msg: Message): number {
  let length = (msg.content ?? "").length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      length += tc.name.length + JSON.stringify(tc.arguments).length;
    }
  }
  return Math.ceil(length / 4);
}

export function trimHistory(messages: Message[], maxTokens: number): Message[] {
  let total = 0;
  for (const msg of messages) total += estimateTokens(msg);

  if (total <= maxTokens) return messages;

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
  return ensureUserMessagePresent(messages.slice(start), messages);
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

  if (total <= maxTokens) return { messages, summary: existingSummary };

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
      return { messages: ensureUserMessagePresent([summaryMsg, ...kept], messages), summary };
    }
  } else if (existingSummary) {
    // Re-use cached summary from a previous round
    const summaryMsg: Message = {
      role: "system",
      content: `[Earlier conversation summary: ${existingSummary}]`,
    };
    return {
      messages: ensureUserMessagePresent([summaryMsg, ...kept], messages),
      summary: existingSummary,
    };
  }

  return { messages: ensureUserMessagePresent(kept, messages) };
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

/** Execute a single tool call with approval gate, validation, and timing. */
async function executeToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  currentToolNames: string[],
  context: ToolContext,
  opts: AgentLoopOptions,
): Promise<string> {
  const tool = toolMap.get(call.name);

  if (!tool) {
    return `Error: Unknown tool "${call.name}". Available tools: ${currentToolNames.join(", ")}`;
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
    return `Error: tool "${call.name}" is not in skill "${active.id}"'s allowed-tools list (${active.allowedTools.join(", ")}). Deactivate the skill with load_skill(name: "__deactivate__") to access other tools.`;
  }

  const validationError = validateToolArgs(tool, call.arguments);
  if (validationError) {
    return `Error: ${validationError}. Expected parameters: ${JSON.stringify(Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}))}`;
  }

  // --- Approval gate ---
  let approvalTimeMs: number | undefined;
  const permission = evaluatePermission(call.name, call.arguments, opts.permissions);
  if (permission === "approve") {
    if (!opts.approvalHandler) {
      // No handler — auto-approve for backward compat (cron, webhooks, etc.)
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
        return `Tool call rejected by user.${reason}\n[user responded in ${response.responseTimeMs}ms]`;
      }
      approvalTimeMs = response.responseTimeMs;
    }
  }

  // --- Execute tool ---
  const startTime = Date.now();
  const result = await tool.execute(call.arguments, context);
  const durationMs = Date.now() - startTime;
  let resultOutput = result.success ? result.output : `Error: ${result.error ?? "Unknown error"}`;
  if (approvalTimeMs !== undefined) {
    resultOutput += `\n[approved in ${approvalTimeMs}ms, tool completed in ${durationMs}ms]`;
  } else if (durationMs >= 100) {
    resultOutput += `\n[completed in ${durationMs}ms]`;
  }
  return resultOutput;
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

async function _runAgentLoopInner(userMessage: string, opts: AgentLoopOptions): Promise<string> {
  const { session, db, extraInstructions, contextDir, agentContextDir } = opts;

  let contextContent = "";
  if (opts.skipGlobalContext && agentContextDir) {
    // Load only agent-specific context files (skip global context to reduce prompt size)
    contextContent = await loadContextFiles(agentContextDir);
  } else if (contextDir) {
    contextContent = await loadAllContext(contextDir, agentContextDir);
  }
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
  const resolvedBase = resolveBase(opts.systemPrompt);
  const customLayers = resolveCustomLayers(opts.systemPrompt?.custom);
  const fullSystemPrompt = composeSystemPrompt(
    resolvedBase,
    {
      instructions: extraInstructions,
      context: contextContent,
      skill_catalog: catalogBlock,
      core_memory: coreMemoryBlock,
      chat_live_state: chatLiveBlock,
      recall_memory: memoryBlock,
    },
    opts.systemPrompt,
    customLayers,
  );
  const systemPromptTokens = estimateTokens({ role: "system", content: fullSystemPrompt });

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
    return await _runAgentLoopBody(userMessage, opts, context, fullSystemPrompt, systemPromptTokens, history);
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
): Promise<string> {
  const { provider, session, db, tools, maxToolRounds, maxHistoryTokens, temperature } = opts;

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
      return "[Agent stopped: shutdown requested]";
    }
    // Sleep tool sets workingMemory["tick_done"] = "true" to terminate
    // the loop cleanly from inside a tool call. Models often ignore
    // "stop generating" instructions in tool results — this enforces it.
    if (context.workingMemory?.get("tick_done") === "true") {
      // Surface Sleep's reason as the loop's return value so chat
      // live_state and tick_log show what actually happened, not a
      // generic terminator. Falls back to a tag if the agent forgot
      // to provide a reason (shouldn't happen — Sleep requires one).
      const reason = context.workingMemory.get("tick_summary");
      return reason ? `[Sleep] ${reason}` : "[Tick concluded via Sleep]";
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

    // Reserve token budget for the system prompt so history + prompt fits in context
    const historyBudget = Math.max(0, maxHistoryTokens - systemPromptTokens);
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
      trimmed = trimHistory(history, historyBudget);
    }
    const messages: Message[] = [{ role: "system", content: fullSystemPrompt }, ...trimmed];

    const response = await chatOnce(
      currentProvider,
      {
        model: session.model,
        messages,
        tools: toolSchemas,
        temperature,
        thinking: opts.thinking,
      },
      opts.onTextDelta,
      opts.onReasoningDelta,
    );

    if (opts.onUsage && response.usage) {
      try {
        opts.onUsage(response.usage);
      } catch (e) {
        console.error("[agent] onUsage callback error:", (e as Error).message);
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
        const resultOutput = await executeToolCall(call, toolMap, currentToolNames, context, opts);
        opts.onToolResult?.(call.name, resultOutput);
        return { call, resultOutput };
      }),
    );

    // Add all tool results to history in original order
    for (const { call, resultOutput } of results) {
      const toolMsg: Message = {
        role: "tool",
        content: resultOutput,
        toolCallId: call.id,
      };
      saveMessage(db, session.id, toolMsg);
      history.push(toolMsg);
    }

    // Detect a stuck model: same call AND same result, repeated. We use the
    // result too so legitimate polling (e.g. task_status running → running →
    // completed) doesn't trip the detector — only genuine "no progress"
    // loops do.
    const resultSignature = results.map((r) => r.resultOutput).join("|");
    if (callSignature === lastCallSignature && resultSignature === lastResultSignature) {
      repeatCount++;
    } else {
      repeatCount = 1;
    }
    lastCallSignature = callSignature;
    lastResultSignature = resultSignature;

    if (repeatCount >= MAX_REPEATED_CALLS) {
      return response.content || "[Agent stopped: repeated identical tool calls detected]";
    }
  }

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
    "Activate one with `load_skill(name: <id>)`. The skill's full instructions and tool allowlist load only when activated.",
    "",
  ];
  for (const s of catalog) {
    const desc = s.description ? `: ${s.description}` : "";
    lines.push(`- ${s.id}${desc}`);
  }
  lines.push("");
  return lines.join("\n");
}
