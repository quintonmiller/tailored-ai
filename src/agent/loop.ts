import type Database from 'better-sqlite3';
import type { AIProvider, Message, ToolSchema } from '../providers/interface.js';
import type { Tool, ToolContext } from '../tools/interface.js';
import type { Session } from './session.js';
import { getSessionMessages, saveMessage } from '../db/queries.js';
import { loadContextFiles } from '../context.js';
import { BASE_SYSTEM_PROMPT } from './prompt.js';

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

  const trimmed = [...messages];
  while (trimmed.length > 1 && total > maxTokens) {
    total -= estimateTokens(trimmed[0]);
    trimmed.shift();
    // Skip past orphaned tool messages to keep tool-call groups intact
    while (trimmed.length > 1 && trimmed[0].role === 'tool') {
      total -= estimateTokens(trimmed[0]);
      trimmed.shift();
    }
  }
  return trimmed;
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
  const { provider, session, db, tools, extraInstructions, maxToolRounds, maxHistoryTokens, temperature, contextDir } = opts;

  const contextContent = contextDir ? await loadContextFiles(contextDir) : '';
  const fullSystemPrompt = BASE_SYSTEM_PROMPT + extraInstructions + contextContent;

  const history = getSessionMessages(db, session.id);

  const userMsg: Message = { role: 'user', content: userMessage };
  saveMessage(db, session.id, userMsg);
  history.push(userMsg);

  const toolSchemas = tools.length > 0 ? toolsToSchemas(tools) : undefined;
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const context: ToolContext = {
    sessionId: session.id,
    workingDirectory: process.cwd(),
    env: {},
  };

  let rounds = 0;

  while (rounds < maxToolRounds) {
    rounds++;

    const trimmed = trimHistory(history, maxHistoryTokens);
    const messages: Message[] = [
      { role: 'system', content: fullSystemPrompt },
      ...trimmed,
    ];

    const response = await provider.chat({
      model: session.model,
      messages,
      tools: toolSchemas,
      temperature,
    });

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

    for (const call of response.toolCalls) {
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
