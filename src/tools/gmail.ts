import type { Tool, ToolContext, ToolResult } from './interface.js';
import { getAccessToken, type GoogleCredentials } from './google-auth.js';

const BASE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailTool implements Tool {
  name = 'gmail';
  description = 'Read and search Gmail. Actions: list_messages, read_message, search_messages.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action: list_messages, read_message, search_messages.',
      },
      query: {
        type: 'string',
        description: 'Search query for search_messages (Gmail search syntax).',
      },
      message_id: {
        type: 'string',
        description: 'Message ID for read_message.',
      },
      max_results: {
        type: 'number',
        description: 'Max results to return (default 5).',
      },
    },
    required: ['action'],
  };

  private creds: GoogleCredentials;

  constructor(creds: GoogleCredentials) {
    this.creds = creds;
  }

  private async request(path: string): Promise<{ ok: boolean; data: unknown; status: number }> {
    const token = await getAccessToken(this.creds);
    const resp = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    return { ok: resp.ok, data, status: resp.status };
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) {
      return { success: false, output: '', error: 'No action provided.' };
    }

    try {
      switch (action) {
        case 'list_messages':
          return this.listMessages(args.max_results as number | undefined);
        case 'search_messages':
          return this.searchMessages(args.query as string, args.max_results as number | undefined);
        case 'read_message':
          return this.readMessage(args.message_id as string);
        default:
          return { success: false, output: '', error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
  }

  private async listMessages(maxResults?: number): Promise<ToolResult> {
    const limit = maxResults ?? 5;
    const { ok, data, status } = await this.request(`/messages?maxResults=${limit}`);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const msgs = (data as { messages?: { id: string; threadId: string }[] }).messages ?? [];
    if (msgs.length === 0) return { success: true, output: 'No messages found.' };

    return this.fetchMessageSummaries(msgs.map((m) => m.id));
  }

  private async searchMessages(query: string, maxResults?: number): Promise<ToolResult> {
    if (!query) return { success: false, output: '', error: 'query is required for search_messages.' };

    const limit = maxResults ?? 5;
    const params = new URLSearchParams({ q: query, maxResults: String(limit) });
    const { ok, data, status } = await this.request(`/messages?${params}`);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const msgs = (data as { messages?: { id: string }[] }).messages ?? [];
    if (msgs.length === 0) return { success: true, output: `No messages found for "${query}".` };

    return this.fetchMessageSummaries(msgs.map((m) => m.id));
  }

  private async readMessage(messageId: string): Promise<ToolResult> {
    if (!messageId) return { success: false, output: '', error: 'message_id is required for read_message.' };

    const { ok, data, status } = await this.request(`/messages/${messageId}?format=full`);
    if (!ok) return { success: false, output: '', error: `API error ${status}: ${JSON.stringify(data)}` };

    const msg = data as GmailMessage;
    return { success: true, output: formatFullMessage(msg) };
  }

  private async fetchMessageSummaries(ids: string[]): Promise<ToolResult> {
    const summaries: string[] = [];

    for (const id of ids) {
      const { ok, data } = await this.request(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      if (!ok) continue;

      const msg = data as GmailMessage;
      const from = getHeader(msg, 'From') ?? 'Unknown';
      const subject = getHeader(msg, 'Subject') ?? '(no subject)';
      const date = getHeader(msg, 'Date') ?? '';

      summaries.push(`- ${subject}\n  From: ${from}\n  Date: ${date}\n  ID: ${id}`);
    }

    return { success: true, output: summaries.join('\n\n') || 'No messages.' };
  }
}

interface GmailMessage {
  id: string;
  payload: {
    headers: { name: string; value: string }[];
    mimeType: string;
    body?: { data?: string; size: number };
    parts?: GmailPart[];
  };
  snippet: string;
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string; size: number };
  parts?: GmailPart[];
}

function getHeader(msg: GmailMessage, name: string): string | undefined {
  return msg.payload.headers.find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  )?.value;
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function extractTextBody(part: GmailPart): string {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const sub of part.parts) {
      const text = extractTextBody(sub);
      if (text) return text;
    }
  }
  return '';
}

function formatFullMessage(msg: GmailMessage): string {
  const from = getHeader(msg, 'From') ?? 'Unknown';
  const to = getHeader(msg, 'To') ?? '';
  const subject = getHeader(msg, 'Subject') ?? '(no subject)';
  const date = getHeader(msg, 'Date') ?? '';

  let body = '';
  if (msg.payload.body?.data) {
    body = decodeBase64Url(msg.payload.body.data);
  } else if (msg.payload.parts) {
    for (const part of msg.payload.parts) {
      body = extractTextBody(part);
      if (body) break;
    }
  }

  if (!body) {
    body = msg.snippet ?? '(no body)';
  }

  // Truncate very long emails
  if (body.length > 4000) {
    body = body.slice(0, 4000) + '\n\n[Truncated]';
  }

  return `From: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\n${body}`;
}
