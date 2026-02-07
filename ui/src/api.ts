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

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function fetchHealth(): Promise<HealthInfo> {
  return jsonFetch('/api/health');
}

export function fetchSessions(): Promise<SessionRow[]> {
  return jsonFetch('/api/sessions');
}

export function fetchMessages(sessionId: string): Promise<Message[]> {
  return jsonFetch(`/api/sessions/${sessionId}/messages`);
}

export interface ConfigData {
  path: string;
  content: string;
}

export function fetchConfig(): Promise<ConfigData> {
  return jsonFetch('/api/config');
}

export function saveConfig(content: string): Promise<{ ok?: boolean; message?: string; error?: string }> {
  return jsonFetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProfileInfo {
  model?: string;
  provider?: string;
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
}

export interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  task: string;
  model: string | null;
  session_key: string | null;
  enabled: number;
  last_run: string | null;
}

export interface CronData {
  enabled: boolean;
  jobs: CronJobRow[];
}

export interface TaskInfo {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface ContextFile {
  name: string;
  content: string;
}

export interface ContextData {
  directory: string;
  files: ContextFile[];
}

export function fetchTools(): Promise<ToolInfo[]> {
  return jsonFetch('/api/tools');
}

export function fetchProfiles(): Promise<Record<string, ProfileInfo>> {
  return jsonFetch('/api/profiles');
}

export function fetchCron(): Promise<CronData> {
  return jsonFetch('/api/cron');
}

export function toggleCronJob(name: string, enabled: boolean): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/cron/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

export function triggerCronJob(name: string): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/cron/${encodeURIComponent(name)}/run`, { method: 'POST' });
}

export function fetchTasks(): Promise<TaskInfo[]> {
  return jsonFetch('/api/tasks');
}

export function fetchContext(): Promise<ContextData> {
  return jsonFetch('/api/context');
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
