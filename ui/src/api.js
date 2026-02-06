export async function fetchHealth() {
    const res = await fetch('/api/health');
    return res.json();
}
export async function fetchSessions() {
    const res = await fetch('/api/sessions');
    return res.json();
}
export async function fetchMessages(sessionId) {
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    return res.json();
}
export async function fetchConfig() {
    const res = await fetch('/api/config');
    return res.json();
}
export async function saveConfig(content) {
    const res = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    return res.json();
}
export function sendChat(message, sessionKey, onEvent) {
    const controller = new AbortController();
    fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, sessionKey }),
        signal: controller.signal,
    }).then(async (res) => {
        const reader = res.body?.getReader();
        if (!reader)
            return;
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            let currentEvent = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7);
                }
                else if (line.startsWith('data: ') && currentEvent) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        onEvent({ type: currentEvent, data });
                    }
                    catch {
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
