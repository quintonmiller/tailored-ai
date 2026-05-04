export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
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
  return jsonFetch("/api/health");
}

export function fetchSessions(): Promise<SessionRow[]> {
  return jsonFetch("/api/sessions");
}

export function fetchMessages(sessionId: string): Promise<Message[]> {
  return jsonFetch(`/api/sessions/${sessionId}/messages`);
}

export interface ConfigData {
  path: string;
  content: string;
}

export function fetchConfig(): Promise<ConfigData> {
  return jsonFetch("/api/config");
}

export function saveConfig(content: string): Promise<{ ok?: boolean; message?: string; error?: string }> {
  return jsonFetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentInfo {
  description?: string;
  model?: string;
  provider?: string;
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
}

/** @deprecated Use AgentInfo */
export type ProfileInfo = AgentInfo;

export interface CronJobRow {
  name: string;
  schedule: string;
  task: string;
  model: string | null;
  agent: string | null;
  enabled: number;
  last_run: string | null;
  delivery: { channel: string; target?: string } | null;
  in_db: boolean;
}

export interface CronData {
  enabled: boolean;
  jobs: CronJobRow[];
}

export interface TaskInfo {
  id: string;
  description: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export interface ContextData {
  directory: string;
  global: string[];
  agents: Record<string, string[]>;
}

export function fetchTools(): Promise<ToolInfo[]> {
  return jsonFetch("/api/tools");
}

export function fetchAgents(): Promise<Record<string, AgentInfo>> {
  return jsonFetch("/api/agents");
}

/** @deprecated Use fetchAgents */
export const fetchProfiles = fetchAgents;

export function fetchCron(): Promise<CronData> {
  return jsonFetch("/api/cron");
}

export function toggleCronJob(name: string, enabled: boolean): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/cron/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function triggerCronJob(name: string): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/cron/${encodeURIComponent(name)}/run`, { method: "POST" });
}

export function fetchBackgroundTasks(): Promise<TaskInfo[]> {
  return jsonFetch("/api/background-tasks");
}

// --- Project Tasks ---

export interface TaskComment {
  id: number;
  task_id: string;
  author: string;
  content: string;
  created_at: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: string;
  author: string;
  tags: string[];
  project_id: string | null;
  assignee: string | null;
  rank: number;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectTaskWithComments extends ProjectTask {
  comments: TaskComment[];
}

export interface ProjectTasksResponse {
  tasks: ProjectTask[];
  total: number;
}

export function fetchProjectTasks(params?: {
  status?: string;
  author?: string;
  assignee?: string;
  tags?: string;
  search?: string;
  project_id?: string;
  order_by?: "rank" | "updated_at";
  limit?: number;
  offset?: number;
}): Promise<ProjectTasksResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.author) qs.set("author", params.author);
  if (params?.assignee) qs.set("assignee", params.assignee);
  if (params?.tags) qs.set("tags", params.tags);
  if (params?.search) qs.set("search", params.search);
  if (params?.project_id) qs.set("project_id", params.project_id);
  if (params?.order_by) qs.set("order_by", params.order_by);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return jsonFetch(`/api/project-tasks${q ? `?${q}` : ""}`);
}

export function fetchProjectTask(id: string): Promise<ProjectTaskWithComments> {
  return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`);
}

export function createProjectTask(data: {
  title: string;
  description?: string;
  author?: string;
  tags?: string[];
  status?: string;
  project_id?: string;
  assignee?: string | null;
  rank?: number;
}): Promise<ProjectTask> {
  return jsonFetch("/api/project-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateProjectTask(
  id: string,
  data: {
    title?: string;
    description?: string;
    status?: string;
    author?: string;
    tags?: string[];
    assignee?: string | null;
    rank?: number;
    blocked_reason?: string | null;
  },
): Promise<ProjectTask> {
  return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteProjectTask(id: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/project-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function addProjectTaskComment(
  taskId: string,
  data: { content: string; author?: string },
): Promise<TaskComment> {
  return jsonFetch(`/api/project-tasks/${encodeURIComponent(taskId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// --- Projects ---

export interface Project {
  id: string;
  title: string;
  description: string;
  status: string;
  due_date: string | null;
  default_assignee: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectWithCounts extends Project {
  task_count: number;
  document_count: number;
}

export interface ProjectsResponse {
  projects: ProjectWithCounts[];
  total: number;
}

export interface DocumentMeta {
  id: string;
  project_id: string;
  title: string;
  filename: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentWithContent extends DocumentMeta {
  content: string;
}

export function fetchProjects(params?: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ProjectsResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.search) qs.set("search", params.search);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return jsonFetch(`/api/projects${q ? `?${q}` : ""}`);
}

export function fetchProject(id: string): Promise<ProjectWithCounts> {
  return jsonFetch(`/api/projects/${encodeURIComponent(id)}`);
}

export function createProject(data: {
  title: string;
  description?: string;
  due_date?: string;
  default_assignee?: string | null;
}): Promise<Project> {
  return jsonFetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateProject(
  id: string,
  data: {
    title?: string;
    description?: string;
    status?: string;
    due_date?: string | null;
    default_assignee?: string | null;
  },
): Promise<Project> {
  return jsonFetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchDefaultProjectId(): Promise<{ id: string }> {
  return jsonFetch("/api/projects/default");
}

export function fetchDocuments(projectId: string, search?: string): Promise<DocumentMeta[]> {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  const q = qs.toString();
  return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents${q ? `?${q}` : ""}`);
}

export function fetchDocument(projectId: string, docId: string): Promise<DocumentWithContent> {
  return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`);
}

export function createDocumentApi(
  projectId: string,
  data: { title: string; content?: string },
): Promise<DocumentMeta> {
  return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function updateDocumentApi(
  projectId: string,
  docId: string,
  data: { title?: string; content?: string },
): Promise<DocumentMeta> {
  return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteDocumentApi(projectId: string, docId: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(docId)}`, {
    method: "DELETE",
  });
}

export function fetchContext(): Promise<ContextData> {
  return jsonFetch("/api/context");
}

export function fetchContextFile(
  name: string,
  scope: string = "global",
): Promise<{ name: string; scope: string; content: string }> {
  return jsonFetch(`/api/context/file?name=${encodeURIComponent(name)}&scope=${encodeURIComponent(scope)}`);
}

export interface ModelEntry {
  provider: string;
  model: string;
}

export interface ProviderConnection {
  baseUrl?: string;
  apiKey?: string;
}

export interface ProvidersData {
  providers: Record<string, ProviderConnection>;
  defaultModels: ModelEntry[];
  agentModels: Record<string, ModelEntry[]>;
}

export function fetchProviders(): Promise<ProvidersData> {
  return jsonFetch("/api/config/providers");
}

export function saveProviders(data: ProvidersData): Promise<{ ok?: boolean; message?: string; error?: string }> {
  return jsonFetch("/api/config/providers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function fetchModels(provider: string): Promise<{ provider: string; models: string[]; error?: string }> {
  return jsonFetch(`/api/config/providers/${encodeURIComponent(provider)}/models`);
}

export function fetchConfigSection<T = unknown>(key: string): Promise<{ key: string; data: T }> {
  return jsonFetch(`/api/config/section/${encodeURIComponent(key)}`);
}

export function saveConfigSection(key: string, data: unknown): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/config/section/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
}

export interface SessionActivity {
  agentName: string | null;
  status: string;
  description?: string;
  lastActivity: string | null;
}

export function fetchActivity(): Promise<SessionActivity[]> {
  return jsonFetch("/api/activity");
}

// --- Autopilot ---

export interface AutopilotSettings {
  token_cap_1h: number | null;
  token_cap_5h: number | null;
  token_cap_24h: number | null;
  quiet_start: string | null;
  quiet_end: string | null;
  disabled_start: string | null;
  disabled_end: string | null;
  paused: boolean;
  digest_time: string | null;
  updated_at: string;
}

export interface AutopilotActivity {
  current: { taskId: string; title: string } | null;
}

export function fetchAutopilotSettings(): Promise<AutopilotSettings> {
  return jsonFetch("/api/autopilot/settings");
}

export function updateAutopilotSettings(
  data: Partial<AutopilotSettings>,
): Promise<AutopilotSettings> {
  return jsonFetch("/api/autopilot/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function fetchAutopilotActivity(): Promise<AutopilotActivity> {
  return jsonFetch("/api/autopilot/activity");
}

export function runAutopilotDigest(): Promise<{ ok: boolean }> {
  return jsonFetch("/api/autopilot/digest/run", { method: "POST" });
}

export interface AutopilotUsage {
  usage: { "1h": number; "5h": number; "24h": number };
  budget: {
    exceeded: boolean;
    window?: "1h" | "5h" | "24h";
    usage?: number;
    cap?: number;
    nextWindowRollAt?: string;
  };
}

export function fetchAutopilotUsage(): Promise<AutopilotUsage> {
  return jsonFetch("/api/autopilot/usage");
}

// --- Workflows ---

export type WorkflowStepType =
  | "agent_run"
  | "tool_call"
  | "shell"
  | "condition"
  | "loop"
  | "parallel";

export interface WorkflowStepDef {
  name: string;
  type: WorkflowStepType;
  deadlineMs?: number;
  onError?: "fail" | "continue" | "retry";
  retry?: { maxAttempts: number; backoffMs?: number };
  // agent_run
  agent?: string;
  prompt?: string;
  maxToolRounds?: number;
  modelOverride?: string;
  // tool_call
  tool?: string;
  args?: Record<string, unknown>;
  // shell
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  // condition
  if?: string;
  then?: string[];
  else?: string[];
  // loop
  over?: string;
  as?: string;
  body?: WorkflowStepDef[];
  parallel?: boolean;
  maxConcurrency?: number;
  // parallel
  steps?: WorkflowStepDef[];
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  deadlineMs?: number;
  steps: WorkflowStepDef[];
}

export interface WorkflowSummary {
  name: string;
  description?: string;
  source: string;
  stepCount: number;
}

export interface WorkflowsResponse {
  workflows: WorkflowSummary[];
  errors: Array<{ path: string; error: string }>;
}

export function fetchWorkflows(): Promise<WorkflowsResponse> {
  return jsonFetch("/api/workflows");
}

export function fetchWorkflow(name: string): Promise<WorkflowDefinition> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`);
}

export function fetchWorkflowSource(
  name: string,
): Promise<{ name: string; path: string | null; content: string }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/source`);
}

export function saveWorkflow(
  name: string,
  data: { content?: string; definition?: WorkflowDefinition },
): Promise<{ ok?: boolean; error?: string; details?: string[] }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function deleteWorkflow(name: string): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}`, { method: "DELETE" });
}

export function runWorkflow(
  name: string,
  input?: unknown,
): Promise<WorkflowRunRow> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: input ?? {} }),
  });
}

export interface WorkflowRunRow {
  id: string;
  workflow_name: string;
  status: "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  trigger?: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface WorkflowStepRow {
  id: string;
  run_id: string;
  step_name: string;
  step_type: string;
  status: string;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
  output: unknown;
  error: string | null;
}

export function fetchWorkflowRuns(params?: {
  workflow?: string;
  status?: string;
  limit?: number;
}): Promise<WorkflowRunRow[]> {
  const qs = new URLSearchParams();
  if (params?.workflow) qs.set("workflow", params.workflow);
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return jsonFetch(`/api/workflow-runs${q ? `?${q}` : ""}`);
}

export function fetchWorkflowRun(
  id: string,
): Promise<{ run: WorkflowRunRow; steps: WorkflowStepRow[] }> {
  return jsonFetch(`/api/workflow-runs/${encodeURIComponent(id)}`);
}

export function cancelWorkflowRun(id: string): Promise<{ ok?: boolean }> {
  return jsonFetch(`/api/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function fetchWorkflowStepLog(
  runId: string,
  step: string,
): Promise<{ runId: string; step: string; path: string; content: string }> {
  return jsonFetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(step)}/log`,
  );
}

// --- Sandboxes ---

export interface ActiveSandbox {
  id: string;
  kind: "host" | "docker" | "podman";
  cwd: string;
  agentName?: string;
  sessionId?: string;
  startedAt: string;
}

export function fetchSandboxes(): Promise<{ sandboxes: ActiveSandbox[] }> {
  return jsonFetch("/api/sandboxes");
}

export function killSandbox(id: string): Promise<{ ok?: boolean }> {
  return jsonFetch(`/api/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface ChatEvent {
  type: "tool_call" | "tool_result" | "response" | "error" | "activity";
  data: Record<string, unknown>;
}

export function sendChat(
  message: string,
  sessionKey: string | undefined,
  onEvent: (event: ChatEvent) => void,
  agent?: string,
): AbortController {
  const controller = new AbortController();
  const body: Record<string, unknown> = { message, sessionKey };
  if (agent) body.agent = agent;

  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ") && currentEvent) {
            try {
              const data = JSON.parse(line.slice(6));
              onEvent({ type: currentEvent as ChatEvent["type"], data });
            } catch {
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
