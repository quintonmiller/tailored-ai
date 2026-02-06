export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
}

export interface HealthInfo {
  status: string;
  uptime: number;
  provider: string;
  model: string;
  tools: number;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/health');
  return res.json();
}

export async function fetchSessions(): Promise<SessionRow[]> {
  const res = await fetch('/api/sessions');
  return res.json();
}

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const res = await fetch(`/api/sessions/${sessionId}/messages`);
  return res.json();
}

export interface ConfigData {
  path: string;
  content: string;
}

export async function fetchConfig(): Promise<ConfigData> {
  const res = await fetch('/api/config');
  return res.json();
}

export async function saveConfig(content: string): Promise<{ ok?: boolean; message?: string; error?: string }> {
  const res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export interface ChatEvent {
  type: 'tool_call' | 'tool_result' | 'response' | 'error';
  data: Record<string, unknown>;
}

export function sendChat(
  message: string,
  sessionKey: string | undefined,
  onEvent: (event: ChatEvent) => void,
): AbortController {
  const controller = new AbortController();

  fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionKey }),
    signal: controller.signal,
  }).then(async (res) => {
    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7);
        } else if (line.startsWith('data: ') && currentEvent) {
          try {
            const data = JSON.parse(line.slice(6));
            onEvent({ type: currentEvent as ChatEvent['type'], data });
          } catch {
            // skip malformed data
          }
          currentEvent = '';
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') {
      onEvent({ type: 'error', data: { message: err.message } });
    }
  });

  return controller;
}
