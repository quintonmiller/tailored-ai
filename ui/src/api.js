async function jsonFetch(url, init) {
    const res = await fetch(url, init);
    if (!res.ok)
        throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}
export function fetchHealth() {
    return jsonFetch('/api/health');
}
export function fetchSessions() {
    return jsonFetch('/api/sessions');
}
export function fetchMessages(sessionId) {
    return jsonFetch(`/api/sessions/${sessionId}/messages`);
}
export function fetchConfig() {
    return jsonFetch('/api/config');
}
export function saveConfig(content) {
    return jsonFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
}
export function fetchTools() {
    return jsonFetch('/api/tools');
}
export function fetchProfiles() {
    return jsonFetch('/api/profiles');
}
export function fetchCron() {
    return jsonFetch('/api/cron');
}
export function toggleCronJob(name, enabled) {
    return jsonFetch(`/api/cron/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
    });
}
export function triggerCronJob(name) {
    return jsonFetch(`/api/cron/${encodeURIComponent(name)}/run`, { method: 'POST' });
}
export function fetchTasks() {
    return jsonFetch('/api/tasks');
}
export function fetchContext() {
    return jsonFetch('/api/context');
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
