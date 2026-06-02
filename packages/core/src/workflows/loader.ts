import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import YAML from "yaml";
import { BUILTIN_TRIGGER_KINDS } from "../resources/trigger-registry.js";
import { validateInputsSchema } from "./inputs.js";
import type { OnErrorPolicy, StepType, WorkflowDefinition, WorkflowStepDef } from "./types.js";

const VALID_STEP_TYPES: StepType[] = [
  "agent_run",
  "tool_call",
  "shell",
  "condition",
  "loop",
  "parallel",
  "discord_message",
  "trigger_workflow",
  "http_request",
  "notify",
  "form",
  "worktree",
];

const VALID_WORKTREE_STRATEGIES = new Set(["head", "branch", "merge-to-head"]);

const VALID_FORM_NOTIFY_CHANNELS = new Set(["discord", "log"]);

const VALID_NOTIFY_CHANNELS = new Set(["discord", "email", "log"]);

const VALID_HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

const VALID_HTTP_PARSE_AS = new Set(["json", "text", "raw"]);
const VALID_AGENT_PARSE_AS = new Set(["json", "text"]);

const VALID_ON_ERROR: OnErrorPolicy[] = ["fail", "continue", "retry"];

const VALID_SANDBOXES = new Set(["host", "docker", "podman"]);

export interface LoadResult {
  workflows: WorkflowDefinition[];
  errors: Array<{ path: string; error: string }>;
}

export function parseWorkflow(text: string): WorkflowDefinition {
  const parsed = YAML.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("workflow file must be a YAML mapping");
  }
  return parsed as WorkflowDefinition;
}

export interface ValidateWorkflowOptions {
  /**
   * Trigger kinds that are valid for this workflow's `triggers[].kind` field,
   * beyond the kinds the loader knows about by default. Useful when a plugin
   * has registered a custom trigger kind via the trigger registry — pass
   * `runtime.triggerKinds.list().map(m => m.kind)` to allow them.
   *
   * Built-in kinds (see `BUILTIN_TRIGGER_KINDS`) are always allowed.
   */
  allowedTriggerKinds?: Iterable<string>;
}

/**
 * Validate a workflow definition. Returns a list of error messages — empty
 * when valid. Errors are collected (not thrown) so the loader can report
 * many problems in one pass.
 */
export function validateWorkflow(wf: unknown, opts: ValidateWorkflowOptions = {}): string[] {
  const errors: string[] = [];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    return ["workflow must be an object"];
  }
  const def = wf as Partial<WorkflowDefinition>;

  if (!def.name || typeof def.name !== "string") {
    errors.push("workflow must have a string `name`");
  } else if (!/^[a-zA-Z0-9._-]+$/.test(def.name)) {
    errors.push(`workflow name "${def.name}" must contain only alphanumerics, "._-"`);
  }

  if (def.deadlineMs !== undefined) {
    if (typeof def.deadlineMs !== "number" || def.deadlineMs <= 0) {
      errors.push("workflow.deadlineMs must be a positive number");
    }
  }

  if (def.executionMode !== undefined && def.executionMode !== "linear" && def.executionMode !== "graph") {
    errors.push('workflow.executionMode must be either "linear" or "graph"');
  }

  if (def.sandbox !== undefined && !VALID_SANDBOXES.has(def.sandbox)) {
    errors.push(`workflow.sandbox must be one of: ${[...VALID_SANDBOXES].join(", ")}`);
  }

  if ((def as { inputs?: unknown }).inputs !== undefined) {
    errors.push(...validateInputsSchema((def as { inputs?: unknown }).inputs, "workflow.inputs"));
  }

  if (!Array.isArray(def.steps) || def.steps.length === 0) {
    errors.push("workflow must have a non-empty `steps` array");
    return errors;
  }

  const seenNames = new Set<string>();
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    validateStep(step, `steps[${i}]`, errors, seenNames);
  }

  if (def.triggers !== undefined) {
    if (!Array.isArray(def.triggers)) {
      errors.push("workflow.triggers must be an array");
    } else {
      const allowedKinds = new Set<string>([
        ...BUILTIN_TRIGGER_KINDS.map((m) => m.kind),
        ...(opts.allowedTriggerKinds ?? []),
      ]);
      for (let i = 0; i < def.triggers.length; i++) {
        validateTrigger(def.triggers[i], `triggers[${i}]`, allowedKinds, errors);
      }
    }
  }

  if (def.graph !== undefined) validateGraph(def.graph, seenNames, errors);

  return errors;
}

const VALID_DOCUMENT_EVENTS = new Set(["created", "updated", "deleted"]);

function validateTrigger(
  trigger: unknown,
  path: string,
  allowedKinds: Set<string>,
  errors: string[],
): void {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const t = trigger as Record<string, unknown>;
  if (typeof t.kind !== "string" || !allowedKinds.has(t.kind)) {
    errors.push(`${path}.kind must be one of: ${[...allowedKinds].sort().join(", ")}`);
    return;
  }
  switch (t.kind) {
    case "cron":
      if (typeof t.schedule !== "string" || !t.schedule) {
        errors.push(`${path}.schedule is required for cron triggers`);
      }
      break;
    case "tool_called":
      if (typeof t.tool !== "string" || !t.tool) {
        errors.push(`${path}.tool is required for tool_called triggers`);
      }
      break;
    case "document_event":
      if (!Array.isArray(t.events) || t.events.length === 0) {
        errors.push(`${path}.events must be a non-empty array`);
      } else {
        for (const ev of t.events) {
          if (typeof ev !== "string" || !VALID_DOCUMENT_EVENTS.has(ev)) {
            errors.push(`${path}.events item "${String(ev)}" must be one of: ${[...VALID_DOCUMENT_EVENTS].join(", ")}`);
          }
        }
      }
      break;
    case "config_event":
      if (t.path !== undefined && typeof t.path !== "string") {
        errors.push(`${path}.path must be a string`);
      }
      break;
    case "file_drop":
      if (typeof t.path !== "string" || !t.path) {
        errors.push(`${path}.path is required for file_drop triggers`);
      }
      if (t.extensions !== undefined && typeof t.extensions !== "string") {
        errors.push(`${path}.extensions must be a string (e.g. "pdf,jpg")`);
      }
      if (t.stableForMs !== undefined && typeof t.stableForMs !== "number") {
        errors.push(`${path}.stableForMs must be a number`);
      }
      break;
    case "webhook":
      if (t.token !== undefined && typeof t.token !== "string") {
        errors.push(`${path}.token must be a string`);
      }
      break;
    case "email_message":
      if (typeof t.query !== "string" || !t.query) {
        errors.push(`${path}.query is required for email_message triggers`);
      }
      if (t.intervalSeconds !== undefined && typeof t.intervalSeconds !== "number") {
        errors.push(`${path}.intervalSeconds must be a number`);
      }
      break;
    case "rss":
      if (typeof t.url !== "string" || !t.url) {
        errors.push(`${path}.url is required for rss triggers`);
      }
      if (t.intervalSeconds !== undefined && typeof t.intervalSeconds !== "number") {
        errors.push(`${path}.intervalSeconds must be a number`);
      }
      if (t.matchTitle !== undefined && typeof t.matchTitle !== "string") {
        errors.push(`${path}.matchTitle must be a string`);
      }
      break;
    case "calendar_event":
      if (t.beforeMinutes !== undefined && typeof t.beforeMinutes !== "number") {
        errors.push(`${path}.beforeMinutes must be a number`);
      }
      if (t.titleContains !== undefined && typeof t.titleContains !== "string") {
        errors.push(`${path}.titleContains must be a string`);
      }
      if (t.calendarId !== undefined && typeof t.calendarId !== "string") {
        errors.push(`${path}.calendarId must be a string`);
      }
      if (t.intervalSeconds !== undefined && typeof t.intervalSeconds !== "number") {
        errors.push(`${path}.intervalSeconds must be a number`);
      }
      break;
  }
}

function validateGraph(graph: unknown, stepNames: Set<string>, errors: string[]): void {
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    errors.push("workflow.graph must be an object");
    return;
  }
  const g = graph as Record<string, unknown>;
  if (!Array.isArray(g.nodes)) errors.push("workflow.graph.nodes must be an array");
  if (!Array.isArray(g.edges)) errors.push("workflow.graph.edges must be an array");
  // Don't error on edges referencing unknown steps — the UI may be saving
  // partial state while the user reshapes the graph. Treat as advisory.
  if (Array.isArray(g.nodes)) {
    for (let i = 0; i < g.nodes.length; i++) {
      const n = g.nodes[i] as Record<string, unknown>;
      if (typeof n?.stepName !== "string") {
        errors.push(`workflow.graph.nodes[${i}].stepName must be a string`);
      } else if (!stepNames.has(n.stepName)) {
        errors.push(`workflow.graph.nodes[${i}].stepName "${n.stepName}" does not match any step`);
      }
      const pos = n?.position as { x?: unknown; y?: unknown } | undefined;
      if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
        errors.push(`workflow.graph.nodes[${i}].position must be { x: number, y: number }`);
      }
    }
  }
}

function validateStep(step: unknown, path: string, errors: string[], seenNames: Set<string>): void {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const s = step as Partial<WorkflowStepDef> & Record<string, unknown>;

  if (!s.name || typeof s.name !== "string") {
    errors.push(`${path}.name is required`);
  } else if (seenNames.has(s.name)) {
    errors.push(`${path}.name "${s.name}" is duplicated within this scope`);
  } else {
    seenNames.add(s.name);
  }

  if (!s.type || typeof s.type !== "string") {
    errors.push(`${path}.type is required`);
    return;
  }
  if (!VALID_STEP_TYPES.includes(s.type as StepType)) {
    errors.push(`${path}.type "${s.type}" is not valid (use ${VALID_STEP_TYPES.join(", ")})`);
    return;
  }

  if (s.onError !== undefined && !VALID_ON_ERROR.includes(s.onError as OnErrorPolicy)) {
    errors.push(`${path}.onError "${s.onError}" is not valid (use ${VALID_ON_ERROR.join(", ")})`);
  }

  if (s.deadlineMs !== undefined && (typeof s.deadlineMs !== "number" || s.deadlineMs <= 0)) {
    errors.push(`${path}.deadlineMs must be a positive number`);
  }

  if (s.retry !== undefined) {
    if (typeof s.retry !== "object" || s.retry === null) {
      errors.push(`${path}.retry must be an object`);
    } else {
      const r = s.retry as unknown as Record<string, unknown>;
      if (typeof r.maxAttempts !== "number" || r.maxAttempts < 1) {
        errors.push(`${path}.retry.maxAttempts must be a positive integer`);
      }
      if (r.backoffMs !== undefined && (typeof r.backoffMs !== "number" || r.backoffMs < 0)) {
        errors.push(`${path}.retry.backoffMs must be a non-negative number`);
      }
    }
  }

  switch (s.type) {
    case "agent_run":
      if (!s.agent || typeof s.agent !== "string") {
        errors.push(`${path}.agent is required for agent_run`);
      }
      if (!s.prompt || typeof s.prompt !== "string") {
        errors.push(`${path}.prompt is required for agent_run`);
      }
      if (s.parseAs !== undefined && !VALID_AGENT_PARSE_AS.has(String(s.parseAs))) {
        errors.push(`${path}.parseAs must be one of ${[...VALID_AGENT_PARSE_AS].join(", ")}`);
      }
      break;
    case "tool_call":
      if (!s.tool || typeof s.tool !== "string") {
        errors.push(`${path}.tool is required for tool_call`);
      }
      if (s.args !== undefined && (typeof s.args !== "object" || Array.isArray(s.args))) {
        errors.push(`${path}.args must be an object`);
      }
      break;
    case "shell":
      if (!s.command || typeof s.command !== "string") {
        errors.push(`${path}.command is required for shell`);
      }
      break;
    case "condition":
      if (!s.if || typeof s.if !== "string") {
        errors.push(`${path}.if is required for condition`);
      }
      if (s.then !== undefined && !Array.isArray(s.then)) {
        errors.push(`${path}.then must be an array of step names`);
      }
      if (s.else !== undefined && !Array.isArray(s.else)) {
        errors.push(`${path}.else must be an array of step names`);
      }
      break;
    case "loop": {
      if (!s.over || typeof s.over !== "string") {
        errors.push(`${path}.over is required for loop`);
      }
      if (!s.as || typeof s.as !== "string") {
        errors.push(`${path}.as is required for loop`);
      }
      if (!Array.isArray(s.body) || s.body.length === 0) {
        errors.push(`${path}.body must be a non-empty array`);
      } else {
        const childSeen = new Set<string>();
        for (let i = 0; i < (s.body as unknown[]).length; i++) {
          validateStep((s.body as unknown[])[i], `${path}.body[${i}]`, errors, childSeen);
        }
      }
      break;
    }
    case "parallel": {
      if (!Array.isArray(s.steps) || s.steps.length === 0) {
        errors.push(`${path}.steps must be a non-empty array`);
      } else {
        const childSeen = new Set<string>();
        for (let i = 0; i < (s.steps as unknown[]).length; i++) {
          validateStep((s.steps as unknown[])[i], `${path}.steps[${i}]`, errors, childSeen);
        }
      }
      break;
    }
    case "discord_message":
      if (!s.message || typeof s.message !== "string") {
        errors.push(`${path}.message is required for discord_message`);
      }
      if (s.channelId !== undefined && typeof s.channelId !== "string") {
        errors.push(`${path}.channelId must be a string`);
      }
      if (s.userId !== undefined && typeof s.userId !== "string") {
        errors.push(`${path}.userId must be a string`);
      }
      break;
    case "trigger_workflow":
      if (!s.workflow || typeof s.workflow !== "string") {
        errors.push(`${path}.workflow is required for trigger_workflow`);
      }
      if (s.input !== undefined && (typeof s.input !== "object" || Array.isArray(s.input))) {
        errors.push(`${path}.input must be an object`);
      }
      if (s.fireAndForget !== undefined && typeof s.fireAndForget !== "boolean") {
        errors.push(`${path}.fireAndForget must be a boolean`);
      }
      break;
    case "notify":
      if (typeof s.channel !== "string" || !VALID_NOTIFY_CHANNELS.has(String(s.channel))) {
        errors.push(`${path}.channel must be one of ${[...VALID_NOTIFY_CHANNELS].join(", ")}`);
      }
      if (!s.message || typeof s.message !== "string") {
        errors.push(`${path}.message is required for notify`);
      }
      break;
    case "http_request":
      if (!s.url || typeof s.url !== "string") {
        errors.push(`${path}.url is required for http_request`);
      }
      if (s.method !== undefined) {
        if (typeof s.method !== "string" || !VALID_HTTP_METHODS.has(String(s.method).toUpperCase())) {
          errors.push(`${path}.method must be one of ${[...VALID_HTTP_METHODS].join(", ")}`);
        }
      }
      if (s.headers !== undefined && (typeof s.headers !== "object" || Array.isArray(s.headers))) {
        errors.push(`${path}.headers must be an object of string keys to string values`);
      }
      if (s.parseAs !== undefined && !VALID_HTTP_PARSE_AS.has(String(s.parseAs))) {
        errors.push(`${path}.parseAs must be one of ${[...VALID_HTTP_PARSE_AS].join(", ")}`);
      }
      if (s.timeoutMs !== undefined && typeof s.timeoutMs !== "number") {
        errors.push(`${path}.timeoutMs must be a number`);
      }
      if (s.expectStatus !== undefined) {
        if (!Array.isArray(s.expectStatus) || s.expectStatus.some((n) => typeof n !== "number")) {
          errors.push(`${path}.expectStatus must be an array of numbers`);
        }
      }
      break;
    case "worktree": {
      if (typeof s.strategy !== "string" || !VALID_WORKTREE_STRATEGIES.has(s.strategy)) {
        errors.push(`${path}.strategy must be one of: ${[...VALID_WORKTREE_STRATEGIES].join(", ")}`);
      }
      if (s.strategy === "branch" && (typeof s.branch !== "string" || !s.branch)) {
        errors.push(`${path}.branch is required for worktree strategy "branch"`);
      }
      if (s.branch !== undefined && typeof s.branch !== "string") {
        errors.push(`${path}.branch must be a string`);
      }
      if (s.repoDir !== undefined && typeof s.repoDir !== "string") {
        errors.push(`${path}.repoDir must be a string`);
      }
      if (s.worktreePath !== undefined && typeof s.worktreePath !== "string") {
        errors.push(`${path}.worktreePath must be a string`);
      }
      if (s.mergeOnSuccess !== undefined && typeof s.mergeOnSuccess !== "boolean") {
        errors.push(`${path}.mergeOnSuccess must be a boolean`);
      }
      if (!Array.isArray(s.body) || s.body.length === 0) {
        errors.push(`${path}.body must be a non-empty array of steps`);
      } else {
        const childSeen = new Set<string>();
        for (let i = 0; i < (s.body as unknown[]).length; i++) {
          validateStep((s.body as unknown[])[i], `${path}.body[${i}]`, errors, childSeen);
        }
      }
      break;
    }
    case "form":
      if (!s.prompt || typeof s.prompt !== "string") {
        errors.push(`${path}.prompt is required for form`);
      }
      if (!s.fields || typeof s.fields !== "object" || Array.isArray(s.fields)) {
        errors.push(`${path}.fields must be an object mapping field name to schema`);
      } else {
        errors.push(...validateInputsSchema(s.fields, `${path}.fields`));
      }
      if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== "number" || s.timeoutMs <= 0)) {
        errors.push(`${path}.timeoutMs must be a positive number`);
      }
      if (s.notify !== undefined) {
        if (typeof s.notify !== "object" || s.notify === null || Array.isArray(s.notify)) {
          errors.push(`${path}.notify must be an object`);
        } else {
          const n = s.notify as Record<string, unknown>;
          if (typeof n.channel !== "string" || !VALID_FORM_NOTIFY_CHANNELS.has(n.channel)) {
            errors.push(`${path}.notify.channel must be one of: ${[...VALID_FORM_NOTIFY_CHANNELS].join(", ")}`);
          }
          if (n.channelId !== undefined && typeof n.channelId !== "string") {
            errors.push(`${path}.notify.channelId must be a string`);
          }
          if (n.userId !== undefined && typeof n.userId !== "string") {
            errors.push(`${path}.notify.userId must be a string`);
          }
          if (n.message !== undefined && typeof n.message !== "string") {
            errors.push(`${path}.notify.message must be a string`);
          }
        }
      }
      break;
  }
}

/**
 * Load all workflow YAML files from a directory. Returns parsed workflows
 * along with errors for files that failed to parse or validate.
 *
 * Files are discovered by extension (.yaml, .yml). Subdirectories are not
 * recursed.
 */
export function loadWorkflowsFromDir(dir: string, opts: ValidateWorkflowOptions = {}): LoadResult {
  const result: LoadResult = { workflows: [], errors: [] };
  if (!existsSync(dir)) return result;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    result.errors.push({ path: dir, error: (err as Error).message });
    return result;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = extname(entry).toLowerCase();
    if (ext !== ".yaml" && ext !== ".yml") continue;

    try {
      const text = readFileSync(full, "utf-8");
      const parsed = parseWorkflow(text);
      const validationErrors = validateWorkflow(parsed, opts);
      if (validationErrors.length > 0) {
        result.errors.push({
          path: full,
          error: validationErrors.join("; "),
        });
        continue;
      }
      result.workflows.push(parsed);
    } catch (err) {
      result.errors.push({ path: full, error: (err as Error).message });
    }
  }

  return result;
}

export function resolveWorkflowsDir(dir?: string): string {
  return resolve(process.cwd(), dir ?? "workflows");
}
