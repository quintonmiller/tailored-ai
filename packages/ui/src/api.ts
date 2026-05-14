export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  project_id: string | null;
  title: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

const ACTIVE_PROJECT_KEY = "tai.activeProjectId";

/**
 * Currently-selected project id from the UI's localStorage. The string "global"
 * means "show only un-scoped data". null/undefined means "no filter".
 */
export function getActiveProjectId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setActiveProjectId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROJECT_KEY);
    else localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  } catch {
    // localStorage unavailable — ignore
  }
  // Notify listeners so subscribed components re-render.
  window.dispatchEvent(new CustomEvent("tai:active-project-change", { detail: id }));
}

export interface ToolLogToolEntry {
  kind?: "tool";
  id?: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
}

export interface ToolLogTextEntry {
  kind: "text";
  content: string;
}

export type ToolLogEntry = ToolLogToolEntry | ToolLogTextEntry;

export interface MemoryRecall {
  count: number;
  sources: string[];
  /** Pinned-tier note ids (always-inject lane). Empty if none. */
  pinned?: string[];
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  toolCallId?: string;
  // UI-only: collapsed log of tool calls + results that preceded this assistant
  // text message. Populated by groupTurns() when grouping historical messages,
  // and by the chat streaming loop when committing the final response.
  toolLog?: ToolLogEntry[];
  // UI-only: emitted by the loop when injectMemory ran and produced hits.
  // Rendered as a "Recalled N notes" chip above the bubble.
  recalled?: MemoryRecall;
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

export function fetchSessions(opts?: { project?: string | "global" | null }): Promise<SessionRow[]> {
  const project = opts?.project ?? getActiveProjectId();
  const qs = project ? `?project=${encodeURIComponent(project)}` : "";
  return jsonFetch(`/api/sessions${qs}`);
}

export function fetchMessages(sessionId: string): Promise<Message[]> {
  return jsonFetch(`/api/sessions/${sessionId}/messages`);
}

export function updateSession(
  sessionId: string,
  patch: { title?: string | null; pinned?: boolean },
): Promise<SessionRow> {
  return jsonFetch(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteSession(
  sessionId: string,
  opts?: { summarize?: boolean; force?: boolean },
): Promise<{ deleted: boolean; summaryNoteId: string | null }> {
  const params = new URLSearchParams();
  if (opts?.summarize === false) params.set("summarize", "0");
  if (opts?.force) params.set("force", "1");
  const qs = params.toString();
  return jsonFetch(`/api/sessions/${sessionId}${qs ? `?${qs}` : ""}`, {
    method: "DELETE",
  });
}

const ACTIVE_CHAT_SESSION_KEY = "tai.chat.activeSessionId";

export function getStoredChatSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CHAT_SESSION_KEY);
  } catch {
    return null;
  }
}

export function setStoredChatSessionId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_CHAT_SESSION_KEY);
    else localStorage.setItem(ACTIVE_CHAT_SESSION_KEY, id);
  } catch {
    // localStorage unavailable — ignore
  }
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
  injectMemory?: boolean;
  summarizeOnTrim?: boolean;
  maxHistoryTokens?: number;
  memoryInjectBudgetTokens?: number;
}

export interface AgentDefinitionPatch {
  description?: string;
  model?: string;
  provider?: string;
  instructions?: string;
  tools?: string[];
  temperature?: number;
  maxToolRounds?: number;
  injectMemory?: boolean;
  summarizeOnTrim?: boolean;
}

export function createAgent(name: string, definition: AgentDefinitionPatch): Promise<{ name: string; definition: AgentInfo }> {
  return jsonFetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, definition }),
  });
}

export function updateAgent(name: string, definition: AgentDefinitionPatch): Promise<{ name: string; definition: AgentInfo }> {
  return jsonFetch(`/api/agents/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definition }),
  });
}

export function deleteAgent(name: string): Promise<{ deleted: boolean }> {
  return jsonFetch(`/api/agents/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
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
  path: string | null;
  config_overlay_path: string | null;
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
  /** Optional per-model context window (tokens). Drives the `/context` display. */
  maxContextTokens?: number;
}

export interface ProviderConnection {
  baseUrl?: string;
  apiKey?: string;
  name?: string;
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

export interface ModelInfo {
  maxContextTokens?: number;
}

export function fetchModels(
  provider: string,
): Promise<{ provider: string; models: string[]; modelInfo?: Record<string, ModelInfo>; error?: string }> {
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
  | "parallel"
  | "discord_message"
  | "trigger_workflow"
  | "http_request"
  | "notify"
  | "form"
  | "worktree";

/** Contract for what flows between two steps. UI-enforced for v1. */
export type StepContract =
  | { kind: "raw_text" }
  | { kind: "number" }
  | { kind: "choice"; choices: string[] }
  | { kind: "json_schema"; schema: Record<string, unknown> };

export interface WorkflowStepDef {
  name: string;
  type: WorkflowStepType;
  deadlineMs?: number;
  onError?: "fail" | "continue" | "retry";
  retry?: { maxAttempts: number; backoffMs?: number };
  inputContract?: StepContract;
  outputContract?: StepContract;
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
  // loop  (also used by http_request as the request body — disambiguated by step.type)
  over?: string;
  as?: string;
  body?: unknown;
  parallel?: boolean;
  maxConcurrency?: number;
  // parallel
  steps?: WorkflowStepDef[];
  // discord_message
  message?: string;
  channelId?: string;
  userId?: string;
  // trigger_workflow
  workflow?: string;
  input?: Record<string, unknown>;
  fireAndForget?: boolean;
  // http_request  (body is shared with loop above — disambiguated by step.type)
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  parseAs?: "json" | "text" | "raw";
  expectStatus?: number[];
  // notify
  channel?: "discord" | "email" | "log";
  subject?: string;
  to?: string;
  // form
  fields?: Record<string, WorkflowInputSchema>;
  notify?: {
    channel: "discord" | "log";
    channelId?: string;
    userId?: string;
    message?: string;
  };
  // worktree
  strategy?: "head" | "branch" | "merge-to-head";
  branch?: string;
  repoDir?: string;
  worktreePath?: string;
  mergeOnSuccess?: boolean;
}

export type WorkflowTriggerDef =
  | { kind: "manual" }
  | { kind: "cron"; schedule: string }
  | { kind: "tool_called"; tool: string }
  | { kind: "document_event"; events: ("created" | "updated" | "deleted")[] }
  | { kind: "config_event"; path?: string }
  | { kind: "file_drop"; path: string; extensions?: string; stableForMs?: number }
  | { kind: "webhook"; token?: string }
  | { kind: "email_message"; query: string; intervalSeconds?: number }
  | {
      kind: "calendar_event";
      beforeMinutes?: number;
      titleContains?: string;
      calendarId?: string;
      intervalSeconds?: number;
    }
  | { kind: "rss"; url: string; intervalSeconds?: number; matchTitle?: string }
  | {
      kind: "geofence";
      locationUrl: string;
      center: { lat: number; lng: number };
      radiusMeters: number;
      direction?: "enter" | "exit" | "both";
      intervalSeconds?: number;
      authToken?: string;
    }
  | {
      kind: "weather";
      lat: number;
      lng: number;
      field: string;
      op: "gt" | "lt" | "gte" | "lte" | "eq";
      threshold: number;
      intervalSeconds?: number;
      apiBaseUrl?: string;
    }
  | {
      kind: "sensor";
      url: string;
      valuePath: string;
      op: "gt" | "lt" | "gte" | "lte" | "eq";
      threshold: number;
      intervalSeconds?: number;
      headers?: Record<string, string>;
    }
  | {
      kind: "finance";
      symbol: string;
      cross: "above" | "below";
      threshold: number;
      intervalSeconds?: number;
      apiBaseUrl?: string;
    }
  | {
      kind: "home_assistant";
      baseUrl: string;
      token: string;
      entityId: string;
      stateEquals?: string;
      numericAbove?: number;
      numericBelow?: number;
      onAnyChange?: boolean;
      intervalSeconds?: number;
    };

export interface WorkflowGraphNode {
  stepName: string;
  position: { x: number; y: number };
}

export interface WorkflowGraphEdge {
  from: string;
  to: string;
  /** "true" / "false" for branches off a condition step; unset otherwise. */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

export type WorkflowInputType = "string" | "number" | "boolean" | "date" | "file" | "json";

export interface WorkflowInputSchema {
  type: WorkflowInputType;
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: string[];
  min?: number;
  max?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  deadlineMs?: number;
  steps: WorkflowStepDef[];
  triggers?: WorkflowTriggerDef[];
  graph?: WorkflowGraph;
  /** "graph" enables real parallel fan-out via edges. Default "linear". */
  executionMode?: "linear" | "graph";
  /** Declarative inputs surfaced as a run-dialog form + payload validation. */
  inputs?: Record<string, WorkflowInputSchema>;
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

export interface SecretRecord {
  workflow_name: string;
  key: string;
  created_at: string;
  updated_at: string;
}

export function listWorkflowSecrets(name: string): Promise<{ secrets: SecretRecord[] }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/secrets`);
}

export function setWorkflowSecret(name: string, key: string, value: string): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
}

export function deleteWorkflowSecret(name: string, key: string): Promise<{ ok?: boolean; error?: string }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export interface WorkflowVersionSummary {
  version: number;
  saved_by: string | null;
  saved_at: string;
  bytes: number;
}

export function listWorkflowVersions(name: string): Promise<{ versions: WorkflowVersionSummary[] }> {
  return jsonFetch(`/api/workflows/${encodeURIComponent(name)}/versions`);
}

export function restoreWorkflowVersion(
  name: string,
  version: number,
): Promise<{ ok?: boolean; error?: string; restoredFrom?: number }> {
  return jsonFetch(
    `/api/workflows/${encodeURIComponent(name)}/versions/${version}/restore`,
    { method: "POST" },
  );
}

export function runWorkflow(
  name: string,
  input?: unknown,
  options: { dryRun?: boolean } = {},
): Promise<WorkflowRunRow> {
  return jsonFetch<WorkflowRunRow | { error: string; details?: string[] }>(
    `/api/workflows/${encodeURIComponent(name)}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input ?? {}, dryRun: options.dryRun === true }),
    },
  ).then((r) => {
    // Server returns { error, details } on 400 — surface to caller.
    const errBag = r as { error?: string; details?: string[] };
    if (errBag.error) {
      const details = errBag.details ?? [];
      throw new Error(details.length > 0 ? `${errBag.error}: ${details.join("; ")}` : errBag.error);
    }
    return r as WorkflowRunRow;
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

export interface WorkflowFormPendingRow {
  id: string;
  run_id: string;
  step_id: string;
  step_name: string;
  prompt: string;
  fields: Record<string, {
    type: "string" | "number" | "boolean" | "date" | "file" | "json";
    label?: string;
    description?: string;
    required?: boolean;
    default?: unknown;
    enum?: string[];
    min?: number;
    max?: number;
  }>;
  status: "pending" | "submitted" | "expired" | "cancelled";
  submitted: Record<string, unknown> | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchPendingForms(
  runId: string,
): Promise<{ forms: WorkflowFormPendingRow[] }> {
  return jsonFetch(`/api/workflow-runs/${encodeURIComponent(runId)}/forms`);
}

/** Global pending forms across every workflow run — used by the home dashboard. */
export function fetchAllPendingForms(): Promise<{ forms: WorkflowFormPendingRow[] }> {
  return jsonFetch("/api/workflow-forms");
}

export function submitWorkflowForm(
  runId: string,
  stepName: string,
  values: Record<string, unknown>,
): Promise<{ ok?: boolean; values?: Record<string, unknown>; error?: string; details?: string[] }> {
  return jsonFetch(
    `/api/workflow-runs/${encodeURIComponent(runId)}/forms/${encodeURIComponent(stepName)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    },
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

// --- Resources / federation (S10) ---

export interface ResourcePermissions {
  network?: string[];
  filesystem?: string[];
  tools?: string[];
  env?: string[];
}

export interface ResourceManifestSummary {
  kind: string;
  id: string;
  version: string;
  description?: string;
  permissions?: ResourcePermissions;
  trust?: { signedBy?: string; publisher?: string; signature?: string };
  data?: Record<string, unknown>;
}

export interface LockfileEntry {
  kind: string;
  id: string;
  version: string;
  manifestHash: string;
  uri: string;
  installedAt: string;
}

export interface TrustedPublisher {
  publicKey: string;
  publisher: string;
  trustedAt: string;
}

export interface TrustedResourceEntry {
  key: string;
  manifestHash: string;
  grantedPermissions: ResourcePermissions;
  trustedAt: string;
  origin: string;
}

export interface RegistryIndexEntry {
  kind: string;
  id: string;
  version: string;
  description?: string;
  source: string;
  tags?: string[];
}

export interface ResourceInstallResponse {
  ok: boolean;
  mode: "auto" | "cached" | "frozen" | "approved" | "needs_approval" | "denied";
  resource: { manifest: ResourceManifestSummary; origin: { scheme: string; uri: string } };
  decision?: { reason: string; cached: boolean };
  requestedPermissions?: ResourcePermissions;
  reason?: string;
  error?: string;
}

export interface ResourceDetail {
  entry: LockfileEntry;
  trusted: TrustedResourceEntry | null;
}

export function fetchResources(): Promise<{ resources: LockfileEntry[]; lockfilePath: string }> {
  return jsonFetch("/api/resources");
}

export function fetchResourceDetail(kind: string, id: string): Promise<ResourceDetail> {
  return jsonFetch(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
}

export async function installResource(
  uri: string,
  opts?: { approve?: boolean; frozen?: boolean; useApprovalQueue?: boolean },
): Promise<{ status: number; body: ResourceInstallResponse }> {
  const res = await fetch("/api/resources/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri, ...opts }),
  });
  const body = (await res.json()) as ResourceInstallResponse;
  return { status: res.status, body };
}

// --- Approvals queue (shared with tool approvals) ---

export interface PendingApprovalRequest {
  requestId: string;
  toolName: string;
  toolArgs?: Record<string, unknown>;
  sessionId?: string;
  description?: string;
}

export function fetchPendingApprovals(): Promise<PendingApprovalRequest[]> {
  return jsonFetch("/api/approvals");
}

export function resolveApproval(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/approvals/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved, reason }),
  });
}

export function uninstallResource(kind: string, id: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/resources/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function searchRegistry(query: string): Promise<{ results: RegistryIndexEntry[]; error?: string }> {
  return jsonFetch(`/api/registry/search?q=${encodeURIComponent(query)}`);
}

export function fetchTrust(): Promise<{ publishers: TrustedPublisher[]; resources: TrustedResourceEntry[] }> {
  return jsonFetch("/api/trust");
}

export function trustPublisher(publicKey: string, publisher: string): Promise<{ ok: boolean }> {
  return jsonFetch("/api/trust/publisher", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey, publisher }),
  });
}

export function revokePublisher(publicKey: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/trust/publisher/${encodeURIComponent(publicKey)}`, { method: "DELETE" });
}

// --- Authored resources (skills / prompts) ---

export interface AuthoredResource {
  kind: string;
  id: string;
  manifest: {
    kind: string;
    id: string;
    version: string;
    description?: string;
    data?: Record<string, unknown>;
  };
}

export function fetchAuthored(kind?: string): Promise<{ resources: AuthoredResource[]; supportedKinds: string[] }> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return jsonFetch(`/api/authored${qs}`);
}

export function saveAuthored(
  kind: string,
  body: {
    id: string;
    version?: string;
    description?: string;
    data?: Record<string, unknown>;
    // agentskills.io SKILL.md fields (skill kind only):
    instructions?: string;
    allowedTools?: string[];
    license?: unknown;
    compatibility?: unknown;
    metadata?: unknown;
  },
): Promise<{ ok: boolean; resource: AuthoredResource }> {
  return jsonFetch(`/api/authored/${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function deleteAuthored(kind: string, id: string): Promise<{ ok: boolean }> {
  return jsonFetch(`/api/authored/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function killSandbox(id: string): Promise<{ ok?: boolean }> {
  return jsonFetch(`/api/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export interface ChatEvent {
  type:
    | "tool_call"
    | "tool_result"
    | "response"
    | "error"
    | "activity"
    | "approval_request"
    | "memory_recalled";
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

// -----------------------------------------------------------------------------
// Memory (tiered memory M7)
// -----------------------------------------------------------------------------

export interface MemoryNote {
  id: string;
  session_id: string | null;
  project_id: string | null;
  agent: string | null;
  content: string;
  tags: string[];
  importance: number | null;
  ref_count: number;
  created_at: string;
  ttl_at: string | null;
}

export interface MemoryRecallHit {
  tier: "short" | "long";
  source: string;
  score: number;
  snippet: string;
  createdAt: string;
}

export interface MemoryStats {
  counts: { notes: number; facts: number; sessionSummaries: number; chunks: number };
  topReferenced: Array<{
    id: string;
    content: string;
    ref_count: number;
    importance: number | null;
    tags: string[];
  }>;
  embeddingsEnabled: boolean;
  embeddingModel: string | null;
}

export interface FactRow {
  id: string;
  category: string;
  entity: string;
  key: string;
  value: string;
  asof: string | null;
  source: string | null;
  confidence: number | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export function fetchFacts(params: {
  project_id?: string | null;
  category?: string;
  search?: string;
  limit?: number;
}): Promise<{ facts: FactRow[] }> {
  const qs = new URLSearchParams();
  if (params.project_id !== undefined && params.project_id !== null)
    qs.set("project_id", params.project_id);
  if (params.category) qs.set("category", params.category);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  return fetch(`/api/facts${qs.toString() ? `?${qs}` : ""}`).then((r) => r.json());
}

export function deleteFact(id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/facts/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) =>
    r.json(),
  );
}

export function fetchMemoryNotes(params: {
  project?: string | "global" | null;
  tag?: string;
  search?: string;
  agent?: string;
  limit?: number;
}): Promise<MemoryNote[]> {
  const qs = new URLSearchParams();
  if (params.project !== undefined && params.project !== null) qs.set("project", params.project);
  if (params.tag) qs.set("tag", params.tag);
  if (params.search) qs.set("search", params.search);
  if (params.agent) qs.set("agent", params.agent);
  if (params.limit) qs.set("limit", String(params.limit));
  return fetch(`/api/memory/notes?${qs}`).then((r) => r.json());
}

export function fetchMemoryStats(project?: string | "global" | null): Promise<MemoryStats> {
  const qs = new URLSearchParams();
  if (project !== undefined && project !== null) qs.set("project", project);
  return fetch(`/api/memory/stats?${qs}`).then((r) => r.json());
}

export function fetchMemoryRecall(params: {
  q: string;
  project?: string | "global" | null;
  tier?: "any" | "short" | "long";
  limit?: number;
}): Promise<{ hits: MemoryRecallHit[]; formatted: string }> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.project !== undefined && params.project !== null) qs.set("project", params.project);
  if (params.tier) qs.set("tier", params.tier);
  if (params.limit) qs.set("limit", String(params.limit));
  return fetch(`/api/memory/recall?${qs}`).then((r) => r.json());
}

export function updateMemoryNote(
  id: string,
  patch: { tags?: string[]; importance?: number | null; pinned?: boolean },
): Promise<MemoryNote> {
  return fetch(`/api/memory/notes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
}

export function createMemoryNote(input: {
  content: string;
  tags?: string[];
  importance?: number | null;
  project_id?: string | null;
  agent?: string | null;
}): Promise<MemoryNote> {
  return fetch(`/api/memory/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
}

export function fetchMemoryNote(id: string): Promise<MemoryNote> {
  return fetch(`/api/memory/notes/${encodeURIComponent(id)}`).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  });
}

export function deleteMemoryNote(id: string): Promise<{ deleted: boolean }> {
  return fetch(`/api/memory/notes/${id}`, { method: "DELETE" }).then((r) => r.json());
}

export function promoteMemoryNote(
  id: string,
  force = false,
): Promise<{ noteId: string; chunkCount: number; alreadyPromoted: boolean }> {
  return fetch(`/api/memory/notes/${id}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force }),
  }).then((r) => r.json());
}

export function runMemorySweepHttp(): Promise<{
  deletedExpired: number;
  extendedTtl: number;
  remainingNotes: number;
  totalChunks: number;
}> {
  return fetch(`/api/memory/sweep`, { method: "POST" }).then((r) => r.json());
}

export interface ExploratoryAgent {
  name: string;
  enabled_in_config: boolean;
  enabled_in_state: boolean;
  paused_until: string | null;
  last_tick_at: string | null;
  last_tick_status: string | null;
  current_interval_ms: number | null;
  tokens_today: number;
  runs_today: number;
  cadence: {
    interval_minutes?: number;
    idle_backoff_multiplier?: number;
    max_interval_minutes?: number;
    window?: { start: string; end: string };
  } | null;
  budgets: {
    tokens_per_tick?: number;
    tokens_per_day?: number;
    tool_calls_per_tick?: number;
    stop_after_runs_per_day?: number;
  } | null;
}

export interface ExploratoryActivity {
  agentName: string;
  runId: string;
  startedAt: string;
}

export interface ExploratoryRun {
  id: string;
  agent_name: string;
  project_id: string | null;
  started_at: string;
  ended_at: string | null;
  status: "running" | "ok" | "noop" | "budget" | "error";
  tokens_used: number | null;
  tool_calls: number | null;
  note_ids: string[];
  fact_ids: string[];
  task_ids: string[];
  notified_owner: boolean;
  summary: string | null;
  error: string | null;
}

export function fetchExploratoryAgents(): Promise<{
  enabled: boolean;
  activity: ExploratoryActivity | null;
  agents: ExploratoryAgent[];
}> {
  return fetch(`/api/exploratory/agents`).then((r) => r.json());
}

export function fetchExploratoryRuns(params: {
  agent?: string;
  limit?: number;
} = {}): Promise<{ runs: ExploratoryRun[] }> {
  const qs = new URLSearchParams();
  if (params.agent) qs.set("agent", params.agent);
  if (params.limit) qs.set("limit", String(params.limit));
  return fetch(`/api/exploratory/runs?${qs}`).then((r) => r.json());
}

export function fetchExploratoryRun(id: string): Promise<ExploratoryRun> {
  return fetch(`/api/exploratory/runs/${id}`).then((r) => r.json());
}

export function pauseExploratoryAgent(name: string, hours = 4): Promise<{ ok: boolean; paused_until: string }> {
  return fetch(`/api/exploratory/agents/${encodeURIComponent(name)}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hours }),
  }).then((r) => r.json());
}

export function resumeExploratoryAgent(name: string): Promise<{ ok: boolean }> {
  return fetch(`/api/exploratory/agents/${encodeURIComponent(name)}/resume`, {
    method: "POST",
  }).then((r) => r.json());
}

export function disableExploratoryAgent(name: string): Promise<{ ok: boolean }> {
  return fetch(`/api/exploratory/agents/${encodeURIComponent(name)}/disable`, {
    method: "POST",
  }).then((r) => r.json());
}

export function runExploratoryAgent(name: string): Promise<{ ok: boolean; run: ExploratoryRun }> {
  return fetch(`/api/exploratory/agents/${encodeURIComponent(name)}/run`, {
    method: "POST",
  }).then((r) => r.json());
}
