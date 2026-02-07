import type Database from 'better-sqlite3';
import type { AIProvider, Message, ToolSchema } from '../providers/interface.js';
import type { Tool, ToolContext } from '../tools/interface.js';
import type { Session } from './session.js';
import { getSessionMessages, saveMessage } from '../db/queries.js';
import { loadContextFiles, loadAllContext } from '../context.js';
import { BASE_SYSTEM_PROMPT } from './prompt.js';

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
        console.warn(`[agent] Provider call failed (attempt ${attempt + 1}), retrying in ${RETRY_DELAY_MS}ms: ${lastError.message}`);
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
  profileContextDir?: string;
  getTools?: () => Tool[];
  getProvider?: () => AIProvider;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
}

function estimateTokens(msg: Message): number {
  let length = (msg.content ?? '').length;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      length += tc.name.length + JSON.stringify(tc.arguments).length;
    }
  }
  return Math.ceil(length / 4);
}

function trimHistory(messages: Message[], maxTokens: number): Message[] {
  let total = 0;
  for (const msg of messages) total += estimateTokens(msg);

  if (total <= maxTokens) return messages;

  let start = 0;
  while (start < messages.length - 1 && total > maxTokens) {
    total -= estimateTokens(messages[start]);
    start++;
    // Skip past orphaned tool messages to keep tool-call groups intact
    while (start < messages.length - 1 && messages[start].role === 'tool') {
      total -= estimateTokens(messages[start]);
      start++;
    }
  }
  return messages.slice(start);
}

function toolsToSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runAgentLoop(
  userMessage: string,
  opts: AgentLoopOptions
): Promise<string> {
  const { provider, session, db, tools, extraInstructions, maxToolRounds, maxHistoryTokens, temperature, contextDir, profileContextDir } = opts;

  const contextContent = contextDir ? await loadAllContext(contextDir, profileContextDir) : '';
  const fullSystemPrompt = BASE_SYSTEM_PROMPT + extraInstructions + contextContent;
  const systemPromptTokens = estimateTokens({ role: 'system', content: fullSystemPrompt });

  const history = getSessionMessages(db, session.id);

  const userMsg: Message = { role: 'user', content: userMessage };
  saveMessage(db, session.id, userMsg);
  history.push(userMsg);

  const context: ToolContext = {
    sessionId: session.id,
    workingDirectory: process.cwd(),
    env: {},
    profileContextDir,
  };

  let rounds = 0;
  let prevToolNames: string[] | undefined;

  while (rounds < maxToolRounds) {
    rounds++;

    const currentTools = opts.getTools ? opts.getTools() : tools;
    const currentProvider = opts.getProvider ? opts.getProvider() : provider;
    const toolSchemas = currentTools.length > 0 ? toolsToSchemas(currentTools) : undefined;
    const toolMap = new Map(currentTools.map((t) => [t.name, t]));

    const currentToolNames = currentTools.map((t) => t.name);
    if (prevToolNames && (prevToolNames.length !== currentToolNames.length || prevToolNames.some((n, i) => n !== currentToolNames[i]))) {
      history.push({ role: 'system', content: `[System: available tools have been updated. Current tools: ${currentToolNames.join(', ')}]` });
    }
    prevToolNames = currentToolNames;

    // Reserve token budget for the system prompt so history + prompt fits in context
    const historyBudget = Math.max(0, maxHistoryTokens - systemPromptTokens);
    const trimmed = trimHistory(history, historyBudget);
    const messages: Message[] = [
      { role: 'system', content: fullSystemPrompt },
      ...trimmed,
    ];

    const response = await withRetry(() => currentProvider.chat({
      model: session.model,
      messages,
      tools: toolSchemas,
      temperature,
    }));

    const assistantMsg: Message = {
      role: 'assistant',
      content: response.content,
      toolCalls: response.toolCalls,
    };
    saveMessage(db, session.id, assistantMsg);
    history.push(assistantMsg);

    if (response.finishReason === 'stop' || !response.toolCalls?.length) {
      return response.content ?? '';
    }

    // Execute all tool calls in parallel
    const results = await Promise.all(
      response.toolCalls.map(async (call) => {
        opts.onToolCall?.(call.name, call.arguments);

        const tool = toolMap.get(call.name);
        let resultOutput: string;

        if (!tool) {
          resultOutput = `Error: Unknown tool "${call.name}"`;
        } else {
          const result = await tool.execute(call.arguments, context);
          resultOutput = result.success
            ? result.output
            : `Error: ${result.error ?? 'Unknown error'}`;
        }

        opts.onToolResult?.(call.name, resultOutput);
        return { call, resultOutput };
      })
    );

    // Add all tool results to history in original order
    for (const { call, resultOutput } of results) {
      const toolMsg: Message = {
        role: 'tool',
        content: resultOutput,
        toolCallId: call.id,
      };
      saveMessage(db, session.id, toolMsg);
      history.push(toolMsg);
    }
  }

  return '[Agent stopped: max tool rounds reached]';
}
