import type Database from "better-sqlite3";
import {
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type PermissionsConfig,
  createApprovalRequestId,
  evaluatePermission,
  formatApprovalDescription,
} from "../approval.js";
import { loadAllContext, loadContextFiles } from "../context.js";
import { getSessionMessages, saveMessage } from "../db/queries.js";
import type { AIProvider, Message, ToolCall, ToolSchema } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import { BASE_SYSTEM_PROMPT } from "./prompt.js";
import type { Session } from "./session.js";

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
  permissions?: PermissionsConfig;
  approvalHandler?: ApprovalHandler;
  onApprovalRequest?: (request: ApprovalRequest) => void;
  onApprovalResponse?: (request: ApprovalRequest, response: ApprovalResponse) => void;
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
  return messages.slice(start);
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

/** Summarize messages that would be dropped during trimming. */
async function summarizeMessages(
  messages: Message[],
  provider: AIProvider,
  model: string,
): Promise<string> {
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
      return { messages: [summaryMsg, ...kept], summary };
    }
  } else if (existingSummary) {
    // Re-use cached summary from a previous round
    const summaryMsg: Message = {
      role: "system",
      content: `[Earlier conversation summary: ${existingSummary}]`,
    };
    return { messages: [summaryMsg, ...kept], summary: existingSummary };
  }

  return { messages: kept };
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

  const startTime = Date.now();
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
      const response = await requestApprovalWithTimeout(
        opts.approvalHandler,
        request,
        opts.permissions!,
      );
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
  const {
    provider,
    session,
    db,
    tools,
    extraInstructions,
    maxToolRounds,
    maxHistoryTokens,
    temperature,
    contextDir,
    agentContextDir,
  } = opts;

  let contextContent = "";
  if (opts.skipGlobalContext && agentContextDir) {
    // Load only agent-specific context files (skip global context to reduce prompt size)
    contextContent = await loadContextFiles(agentContextDir);
  } else if (contextDir) {
    contextContent = await loadAllContext(contextDir, agentContextDir);
  }
  const fullSystemPrompt = BASE_SYSTEM_PROMPT + extraInstructions + contextContent;
  const systemPromptTokens = estimateTokens({ role: "system", content: fullSystemPrompt });

  const history = getSessionMessages(db, session.id);

  const userMsg: Message = { role: "user", content: userMessage };
  saveMessage(db, session.id, userMsg);
  history.push(userMsg);

  const context: ToolContext = {
    sessionId: session.id,
    workingDirectory: process.cwd(),
    env: {},
    agentContextDir,
    kbDir: opts.kbDir,
    agentKbDir: opts.agentKbDir,
    approvalHandler: opts.approvalHandler,
    permissions: opts.permissions,
  };

  let rounds = 0;
  let prevToolNames: string[] | undefined;
  let nudgesRemaining = opts.nudgeOnText ?? 0;
  let lastCallSignature = "";
  let repeatCount = 0;
  let cachedSummary: string | undefined;
  const MAX_REPEATED_CALLS = 3;

  while (rounds < maxToolRounds) {
    if (opts.signal?.aborted) {
      return "[Agent stopped: shutdown requested]";
    }
    rounds++;

    const currentTools = opts.getTools ? opts.getTools() : tools;
    const currentProvider = opts.getProvider ? opts.getProvider() : provider;
    const toolSchemas = currentTools.length > 0 ? toolsToSchemas(currentTools) : undefined;
    const toolMap = new Map(currentTools.map((t) => [t.name, t]));

    const currentToolNames = currentTools.map((t) => t.name);
    if (
      prevToolNames &&
      (prevToolNames.length !== currentToolNames.length || prevToolNames.some((n, i) => n !== currentToolNames[i]))
    ) {
      history.push({
        role: "system",
        content: `[System: available tools have been updated. Current tools: ${currentToolNames.join(", ")}]`,
      });
    }
    prevToolNames = currentToolNames;

    // Reserve token budget for the system prompt so history + prompt fits in context
    const historyBudget = Math.max(0, maxHistoryTokens - systemPromptTokens);
    let trimmed: Message[];
    if (opts.summarizeOnTrim) {
      const currentProvider = opts.getProvider ? opts.getProvider() : provider;
      const result = await trimHistoryWithSummary(history, historyBudget, currentProvider, session.model, cachedSummary);
      trimmed = result.messages;
      if (result.summary) cachedSummary = result.summary;
    } else {
      trimmed = trimHistory(history, historyBudget);
    }
    const messages: Message[] = [{ role: "system", content: fullSystemPrompt }, ...trimmed];

    const response = await withRetry(() =>
      currentProvider.chat({
        model: session.model,
        messages,
        tools: toolSchemas,
        temperature,
      }),
    );

    const assistantMsg: Message = {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
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

    // Detect repeated identical tool calls (model stuck in a loop)
    const callSignature = response.toolCalls.map((c) => `${c.name}:${JSON.stringify(c.arguments)}`).join("|");
    if (callSignature === lastCallSignature) {
      repeatCount++;
    } else {
      lastCallSignature = callSignature;
      repeatCount = 1;
    }

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

    if (repeatCount >= MAX_REPEATED_CALLS) {
      return response.content || "[Agent stopped: repeated identical tool calls detected]";
    }
  }

  return "[Agent stopped: max tool rounds reached]";
}
