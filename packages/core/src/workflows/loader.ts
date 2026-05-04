import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import YAML from "yaml";
import type {
  WorkflowDefinition,
  WorkflowStepDef,
  StepType,
  OnErrorPolicy,
} from "./types.js";

const VALID_STEP_TYPES: StepType[] = [
  "agent_run",
  "tool_call",
  "shell",
  "condition",
  "loop",
  "parallel",
];

const VALID_ON_ERROR: OnErrorPolicy[] = ["fail", "continue", "retry"];

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

/**
 * Validate a workflow definition. Returns a list of error messages — empty
 * when valid. Errors are collected (not thrown) so the loader can report
 * many problems in one pass.
 */
export function validateWorkflow(wf: unknown): string[] {
  const errors: string[] = [];
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    return ["workflow must be an object"];
  }
  const def = wf as Partial<WorkflowDefinition>;

  if (!def.name || typeof def.name !== "string") {
    errors.push("workflow must have a string `name`");
  } else if (!/^[a-zA-Z0-9._-]+$/.test(def.name)) {
    errors.push(
      `workflow name "${def.name}" must contain only alphanumerics, "._-"`,
    );
  }

  if (def.deadlineMs !== undefined) {
    if (typeof def.deadlineMs !== "number" || def.deadlineMs <= 0) {
      errors.push("workflow.deadlineMs must be a positive number");
    }
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

  return errors;
}

function validateStep(
  step: unknown,
  path: string,
  errors: string[],
  seenNames: Set<string>,
): void {
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
    errors.push(
      `${path}.type "${s.type}" is not valid (use ${VALID_STEP_TYPES.join(", ")})`,
    );
    return;
  }

  if (s.onError !== undefined && !VALID_ON_ERROR.includes(s.onError as OnErrorPolicy)) {
    errors.push(
      `${path}.onError "${s.onError}" is not valid (use ${VALID_ON_ERROR.join(", ")})`,
    );
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
  }
}

/**
 * Load all workflow YAML files from a directory. Returns parsed workflows
 * along with errors for files that failed to parse or validate.
 *
 * Files are discovered by extension (.yaml, .yml). Subdirectories are not
 * recursed.
 */
export function loadWorkflowsFromDir(dir: string): LoadResult {
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
    let stat;
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
      const validationErrors = validateWorkflow(parsed);
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
