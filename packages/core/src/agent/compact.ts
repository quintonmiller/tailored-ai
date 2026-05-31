import type Database from "better-sqlite3";
import { deleteSessionMessages, getSessionMessages, saveMessage } from "../db/queries.js";
import type { AIProvider, Message } from "../providers/interface.js";
import { estimateTokens } from "./loop.js";

const MIN_MESSAGES = 4;

export interface CompactResult {
  skipped: boolean;
  reason?: string;
  beforeCount?: number;
  afterCount?: number;
  beforeTokens?: number;
  afterTokens?: number;
}

export async function compactSession(
  db: Database.Database,
  sessionId: string,
  provider: AIProvider,
  model: string,
): Promise<CompactResult> {
  const messages = getSessionMessages(db, sessionId);

  if (messages.length < MIN_MESSAGES) {
    return { skipped: true, reason: `Only ${messages.length} messages, need at least ${MIN_MESSAGES}` };
  }

  // Serialize messages for summarization
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.content) {
      lines.push(`[${msg.role}]: ${msg.content}`);
    }
  }
  const transcript = lines.join("\n");

  let beforeTokens = 0;
  for (const msg of messages) beforeTokens += estimateTokens(msg);

  // Summarize via provider
  const response = await provider.chat({
    model,
    messages: [
      {
        role: "system",
        content:
          "Summarize this conversation concisely. Preserve key facts, decisions, and pending tasks. Output only the summary.",
      },
      { role: "user", content: transcript },
    ],
    temperature: 0.3,
  });

  const summary = response.content ?? "";

  // Replace all messages with a single summary
  deleteSessionMessages(db, sessionId);
  const summaryMsg: Message = { role: "user", content: `[Conversation Summary]\n${summary}` };
  saveMessage(db, sessionId, summaryMsg);

  const afterTokens = estimateTokens(summaryMsg);

  return {
    skipped: false,
    beforeCount: messages.length,
    afterCount: 1,
    beforeTokens,
    afterTokens,
  };
}

export function formatCompactResult(result: CompactResult): string {
  if (result.skipped) {
    return result.reason ?? "Compact skipped";
  }
  return `Compacted: ${result.beforeCount} messages → ${result.afterCount}, ~${result.beforeTokens} tokens → ~${result.afterTokens} tokens`;
}
