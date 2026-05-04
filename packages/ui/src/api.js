async function jsonFetch(url, init) {
    const res = await fetch(url, init);
    if (!res.ok)
        throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
}
export function fetchHealth() {
    return jsonFetch("/api/health");
}
export function fetchSessions() {
    return jsonFetch("/api/sessions");
}
export function fetchMessages(sessionId) {
    return jsonFetch(`/api/sessions/${sessionId}/messages`);
}
export function fetchConfig() {
    return jsonFetch("/api/config");
}
export function saveConfig(content) {
    return jsonFetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
    });
}
export function fetchTools() {
    return jsonFetch("/api/tools");
}
export function fetchAgents() {
    return jsonFetch("/api/agents");
}
/** @deprecated Use fetchAgents */
export const fetchProfiles = fetchAgents;
export function fetchCron() {
    return jsonFetch("/api/cron");
}
export function toggleCronJob(name, enabled) {
    return jsonFetch(`/api/cron/${encodeURIComponent(name)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}
export function triggerCronJob(name) {
    return jsonFetch(`/api/cron/${encodeURIComponent(name)}/run`, { method: "POST" });
}
export function fetchBackgroundTasks() {
    return jsonFetch("/api/background-tasks");
}
export function fetchProjectTasks(params) {
    const qs = new URLSearchParams();
    if (params?.status)
        qs.set("status", params.status);
    if (params?.author)
        qs.set("author", params.author);
    if (params?.assignee)
        qs.set("assignee", params.assignee);
    if (params?.tags)
        qs.set("tags", params.tags);
    if (params?.search)
        qs.set("search", params.search);
    if (params?.project_id)
        qs.set("project_id", params.project_id);
    if (params?.order_by)
        qs.set("order_by", params.order_by);
    if (params?.limit)
        qs.set("limit", String(params.limit));
    if (params?.offset)
        qs.set("offset", String(params.offset));
    const q = qs.toString();
    return jsonFetch(`/api/project-tasks${q ? `?${q}` : ""}`);
}
export function fetchProjectTask(id) {
    return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`);
}
export function createProjectTask(data) {
    return jsonFetch("/api/project-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function updateProjectTask(id, data) {
    return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function deleteProjectTask(id) {
    return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function addProjectTaskComment(taskId, data) {
    return jsonFetch(`/api/project-tasks/${encodeURIComponent(taskId)}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function fetchProjects(params) {
    const qs = new URLSearchParams();
    if (params?.status)
        qs.set("status", params.status);
    if (params?.search)
        qs.set("search", params.search);
    if (params?.limit)
        qs.set("limit", String(params.limit));
    if (params?.offset)
        qs.set("offset", String(params.offset));
    const q = qs.toString();
    return jsonFetch(`/api/projects${q ? `?${q}` : ""}`);
}
export function fetchProject(id) {
    return jsonFetch(`/api/projects/${encodeURIComponent(id)}`);
}
export function createProject(data) {
    return jsonFetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function updateProject(id, data) {
    return jsonFetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function deleteProject(id) {
    return jsonFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function fetchDefaultProjectId() {
    return jsonFetch("/api/projects/default");
}
export function fetchDocuments(projectId, search) {
    const qs = new URLSearchParams();
    if (search)
        qs.set("search", search);
    const q = qs.toString();
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents${q ? `?${q}` : ""}`);
}
export function fetchDocument(projectId, docId) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`);
}
export function createDocumentApi(projectId, data) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function updateDocumentApi(projectId, docId, data) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function deleteDocumentApi(projectId, docId) {
    return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`, {
        method: "DELETE",
    });
}
export function fetchContext() {
    return jsonFetch("/api/context");
}
export function fetchContextFile(name, scope = "global") {
    return jsonFetch(`/api/context/file?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`);
}
export function fetchProviders() {
    return jsonFetch("/api/config/providers");
}
export function saveProviders(data) {
    return jsonFetch("/api/config/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function fetchModels(provider) {
    return jsonFetch(`/api/config/providers/${encodeURIComponent(provider)}/models`);
}
export function fetchConfigSection(key) {
    return jsonFetch(`/api/config/section/${encodeURIComponent(key)}`);
}
export function saveConfigSection(key, data) {
    return jsonFetch(`/api/config/section/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
    });
}
export function fetchActivity() {
    return jsonFetch("/api/activity");
}
export function fetchAutopilotSettings() {
    return jsonFetch("/api/autopilot/settings");
}
export function updateAutopilotSettings(data) {
    return jsonFetch("/api/autopilot/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function fetchAutopilotActivity() {
    return jsonFetch("/api/autopilot/activity");
}
export function runAutopilotDigest() {
    return jsonFetch("/api/autopilot/digest/run", { method: "POST" });
}
export function fetchAutopilotUsage() {
    return jsonFetch("/api/autopilot/usage");
}
export function fetchWorkflows() {
    return jsonFetch("/api/workflows");
}
export function fetchWorkflow(name) {
    return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`);
}
export function fetchWorkflowSource(name) {
    return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/source`);
}
export function saveWorkflow(name, data) {
    return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
}
export function deleteWorkflow(name) {
    return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
}
export function runWorkflow(name, input) {
    return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: input ?? {} }),
    });
}
export function fetchWorkflowRuns(params) {
    const qs = new URLSearchParams();
    if (params?.workflow)
        qs.set("workflow", params.workflow);
    if (params?.status)
        qs.set("status", params.status);
    if (params?.limit)
        qs.set("limit", String(params.limit));
    const q = qs.toString();
    return jsonFetch(`/api/workflow-runs${q ? `?${q}` : ""}`);
}
export function fetchWorkflowRun(id) {
    return jsonFetch(`/api/workflow-runs/${encodeURIComponent(id)}`);
}
export function cancelWorkflowRun(id) {
    return jsonFetch(`/api/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}
export function fetchWorkflowStepLog(runId, step) {
    return jsonFetch(`/api/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/log`);
}
export function fetchSandboxes() {
    return jsonFetch("/api/sandboxes");
}
export function killSandbox(id) {
    return jsonFetch(`/api/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function sendChat(message, sessionKey, onEvent, agent) {
    const controller = new AbortController();
    const body = { message, sessionKey };
    if (agent)
        body.agent = agent;
    fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
    })
        .then(async (res) => {
        const reader = res.body?.getReader();
        if (!reader)
            return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            let currentEvent = "";
            for (const line of lines) {
                if (line.startsWith("event: ")) {
                    currentEvent = line.slice(7);
                }
                else if (line.startsWith("data: ") && currentEvent) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        onEvent({ type: currentEvent, data });
                    }
                    catch {
                        // skip malformed data
                    }
                    currentEvent = "";
                }
            }
        }
    })
        .catch((err) => {
        if (err.name !== "AbortError") {
            onEvent({ type: "error", data: { message: err.message } });
        }
    });
    return controller;
}
