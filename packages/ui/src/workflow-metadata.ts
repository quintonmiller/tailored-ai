import { useEffect, useState } from "react";
import {
  fetchAgents,
  fetchTools,
  fetchWorkflows,
  type WorkflowStepDef,
  type WorkflowStepType,
  type WorkflowTriggerDef,
} from "./api";

/**
 * One-shot metadata fetched once per page-load. Editors use this to populate
 * dropdowns instead of free-text fields. Falls back gracefully to empty lists
 * if any endpoint errors (the editor then renders a plain text input).
 */
export interface WorkflowMetadata {
  agents: string[];
  tools: string[];
  workflows: string[];
  loaded: boolean;
}

export function useWorkflowMetadata(): WorkflowMetadata {
  const [meta, setMeta] = useState<WorkflowMetadata>({
    agents: [],
    tools: [],
    workflows: [],
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAgents().catch(() => ({}) as Record<string, unknown>),
      fetchTools().catch(() => []),
      fetchWorkflows().catch(() => ({ workflows: [], errors: [] })),
    ]).then(([agents, tools, workflows]) => {
      if (cancelled) return;
      setMeta({
        agents: Object.keys(agents).sort(),
        tools: tools.map((t) => t.name).sort(),
        workflows: workflows.workflows.map((w) => w.name).sort(),
        loaded: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return meta;
}

/** Friendly labels for step type dropdowns. */
export const STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  agent_run: "Run agent",
  tool_call: "Call tool",
  shell: "Run shell command",
  condition: "Branch on condition",
  loop: "Loop over items",
  parallel: "Run in parallel",
  channel_message: "Send channel message",
  trigger_workflow: "Trigger another workflow",
  http_request: "HTTP request",
  notify: "Send notification",
  form: "Pause for human input",
  worktree: "Run in git worktree",
};

/** Friendly labels for trigger kinds. */
export const TRIGGER_KIND_LABELS: Record<WorkflowTriggerDef["kind"], string> = {
  manual: "Manual (run button)",
  cron: "Schedule (cron)",
  tool_called: "When a tool is called",
  document_event: "On document change",
  config_event: "On config change",
  file_drop: "When a file is dropped",
  webhook: "When a webhook is called",
  email_message: "When an email arrives",
  calendar_event: "Before a calendar event",
  rss: "When an RSS/Atom feed updates",
  geofence: "When crossing a geofence boundary",
  weather: "When a weather condition crosses a threshold",
  sensor: "When a sensor reading crosses a threshold",
  finance: "When a stock/forex price crosses a threshold",
  home_assistant: "When a Home Assistant entity changes",
};

export const ON_ERROR_LABELS: Record<"fail" | "continue" | "retry", string> = {
  fail: "Stop the workflow",
  continue: "Skip and continue",
  retry: "Retry the step",
};

/** Per-step-type human description, plus what the step takes in and produces. */
export interface StepHelp {
  summary: string;
  input: string;
  output: string;
}

export const STEP_HELP: Record<WorkflowStepType, StepHelp> = {
  agent_run: {
    summary: "Send a prompt to an agent and capture its final response.",
    input: "Prompt text. Use ${input.x} for trigger payload, ${steps.previous_name} to chain.",
    output: "The agent's final text response.",
  },
  tool_call: {
    summary: "Invoke a single tool directly, no LLM in the loop.",
    input: "Tool arguments as JSON. Supports ${input.x} / ${steps.name} interpolation in string values.",
    output: "Whatever the tool returns (string or structured value).",
  },
  shell: {
    summary: "Run a shell command via bash -c. Requires prompts.allowShellExpansion in config.",
    input: "Command line, optional working directory.",
    output: "Trimmed stdout from the command.",
  },
  condition: {
    summary: "Evaluate an expression and branch to the matching output.",
    input: "JS-style expression evaluated against scope (e.g. steps.classify === 'approve').",
    output: "Routes to the 'true' or 'false' handle; downstream steps run accordingly.",
  },
  loop: {
    summary: "Repeat an inner pipeline once per item in an array.",
    input: "An array expression (e.g. steps.fetch.items).",
    output: "Array of per-iteration body results.",
  },
  parallel: {
    summary: "Run a set of branches concurrently and wait for all of them.",
    input: "Triggered by the connected upstream step.",
    output: "Array of branch outputs in declaration order.",
  },
  channel_message: {
    summary: "Post a message to an outbound channel. Defaults to DMing the configured owner on the default channel.",
    input:
      "Message text (supports ${input.x} / ${steps.name}). Optional channel id, target channel/thread, or user ID.",
    output: "Confirmation that the message was sent.",
  },
  trigger_workflow: {
    summary: "Invoke another saved workflow as a child step.",
    input: "Target workflow name + optional input JSON.",
    output: "Child workflow's final output (or task ID if fire-and-forget).",
  },
  http_request: {
    summary: "Call any HTTP API. Templated URL/headers/body — no bespoke tool needed.",
    input: "Method, URL, headers, body. ${...} interpolation supported everywhere.",
    output: "{ status: number, headers: object, body: parsed JSON or text }.",
  },
  notify: {
    summary: "Send a notification through a channel, email, or a log line.",
    input: "Channel choice, message text, plus per-channel target (channel/thread or user id, email recipients).",
    output: "Delivery confirmation: { delivered, target, message }.",
  },
  form: {
    summary: "Pause the workflow until a human submits an input form.",
    input: "Prompt + field schema. Optional notification when the form goes pending.",
    output: "Submitted form values as a JSON object.",
  },
  worktree: {
    summary: "Create a git worktree, run nested steps inside it, optionally merge back.",
    input: "Strategy + branch + nested body steps. ${worktree.path} is exposed to children.",
    output: "{ path, branch, merged, mergeError?, preservedPath? }.",
  },
};

/** Fallback used when a step type is missing from STEP_HELP — defensive. */
export const FALLBACK_STEP_HELP: StepHelp = {
  summary: "Step details below — no detailed help available for this step type yet.",
  input: "See the workflow YAML for the available fields on this step.",
  output: "Step output is passed to the next step as ${steps.<name>}.",
};

export const TRIGGER_HELP: Record<WorkflowTriggerDef["kind"], StepHelp> = {
  manual: {
    summary: "This workflow only runs when you click Run or invoke it from code.",
    input: "Optional input object passed at run time.",
    output: "—",
  },
  cron: {
    summary: "Fires on a recurring schedule.",
    input: "A cron expression (minute hour day-of-month month day-of-week).",
    output: "Empty input payload — schedule fires the workflow with no data.",
  },
  tool_called: {
    summary: "Fires whenever a specific tool gets called anywhere in the system.",
    input: "The tool name to watch.",
    output: "Tool call args become ${input}.",
  },
  document_event: {
    summary: "Fires when a document is created, updated, or deleted.",
    input: "Which events to react to.",
    output: "${input.document} contains the changed document.",
  },
  config_event: {
    summary: "Fires when config.yaml changes (optionally filtered to one path).",
    input: "Optional dotted path to scope (e.g. agent.temperature).",
    output: "${input.path} and ${input.value} contain the change.",
  },
  file_drop: {
    summary: "Fires per newly-stable file in a watched directory.",
    input: 'Directory path and optional extension filter (e.g. "pdf,jpg").',
    output: "${input.file_path}, ${input.file_name}, ${input.file_ext}.",
  },
  webhook: {
    summary: "Fires when an external service POSTs to the workflow's inbound URL.",
    input: "Optional bearer token to require in Authorization header.",
    output: "Inbound payload becomes ${input}.",
  },
  email_message: {
    summary: "Fires per new email matching a Gmail-style search query.",
    input: 'Gmail search query (e.g. "is:unread from:billing@acme.com") + poll interval.',
    output: "${input.message_id}, ${input.message_body}, ${input.query}.",
  },
  calendar_event: {
    summary: "Fires N minutes before a matching calendar event starts.",
    input: "Lead-time in minutes, optional title filter, calendar id.",
    output: "${input.summary}, ${input.start}, ${input.minutes_until}, ${input.raw}.",
  },
  rss: {
    summary: "Fires per new entry in an RSS or Atom feed.",
    input: "Feed URL, optional title filter, poll interval.",
    output: "${input.title}, ${input.link}, ${input.summary}, ${input.published_at}.",
  },
  geofence: {
    summary: "Fires when a device's location crosses a fence boundary.",
    input: "URL returning {lat,lng}, fence center + radius, transition direction.",
    output: "${input.transition} ('enter'/'exit'), ${input.lat}, ${input.lng}, ${input.distance_meters}.",
  },
  weather: {
    summary: "Fires when a weather field at a location crosses a threshold.",
    input: "Lat/lng, Open-Meteo field name, op, threshold, poll interval.",
    output: "${input.field}, ${input.value}, ${input.units}, ${input.observed_at}.",
  },
  sensor: {
    summary: "Polls any JSON endpoint and fires on a numeric threshold cross.",
    input: "URL, JSON path to the value, op, threshold.",
    output: "${input.value}, ${input.path}, ${input.op}, ${input.threshold}.",
  },
  finance: {
    summary: "Fires when a stock/forex price crosses a threshold in the configured direction.",
    input: "Ticker symbol (stooq format), cross direction, threshold.",
    output: "${input.symbol}, ${input.price}, ${input.open}, ${input.high}, ${input.low}.",
  },
  home_assistant: {
    summary: "Polls a Home Assistant entity and fires on a state-change condition.",
    input: "Base URL, long-lived token, entity id, one of: stateEquals/numericAbove/numericBelow/onAnyChange.",
    output: "${input.entity_id}, ${input.state}, ${input.attributes}, ${input.previous_state}.",
  },
};

/**
 * Common cron presets surfaced as a dropdown. "custom" lets the user keep
 * their existing schedule and edit it freely.
 */
export interface CronPreset {
  id: string;
  label: string;
  schedule: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { id: "every-5m", label: "Every 5 minutes", schedule: "*/5 * * * *" },
  { id: "every-15m", label: "Every 15 minutes", schedule: "*/15 * * * *" },
  { id: "every-30m", label: "Every 30 minutes", schedule: "*/30 * * * *" },
  { id: "hourly", label: "Every hour (on the hour)", schedule: "0 * * * *" },
  { id: "daily-8am", label: "Every day at 8:00 AM", schedule: "0 8 * * *" },
  { id: "daily-9am", label: "Every day at 9:00 AM", schedule: "0 9 * * *" },
  { id: "daily-noon", label: "Every day at noon", schedule: "0 12 * * *" },
  { id: "daily-6pm", label: "Every day at 6:00 PM", schedule: "0 18 * * *" },
  { id: "weekdays-9am", label: "Weekdays at 9:00 AM", schedule: "0 9 * * 1-5" },
  { id: "weekly-monday-9am", label: "Mondays at 9:00 AM", schedule: "0 9 * * 1" },
];

export function presetIdForSchedule(schedule: string): string {
  return CRON_PRESETS.find((p) => p.schedule === schedule.trim())?.id ?? "custom";
}

/**
 * Best-effort plain-English description of a cron expression. Recognises the
 * common shapes we surface as presets plus a small handful of generic patterns,
 * and falls back to echoing the raw expression. Intentionally lightweight —
 * a full parser would be overkill for what this UI exposes.
 */
export function describeCron(schedule: string): string {
  const s = schedule.trim();
  const preset = CRON_PRESETS.find((p) => p.schedule === s);
  if (preset) return preset.label;
  const parts = s.split(/\s+/);
  if (parts.length !== 5) return s;
  const [min, hr, dom, mon, dow] = parts;
  if (min === "*" && hr === "*" && dom === "*" && mon === "*" && dow === "*") return "Every minute";
  const everyN = /^\*\/(\d+)$/;
  const minEvery = min.match(everyN);
  if (minEvery && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${minEvery[1]} minutes`;
  }
  const hrEvery = hr.match(everyN);
  if (min === "0" && hrEvery && dom === "*" && mon === "*" && dow === "*") {
    return `Every ${hrEvery[1]} hours (on the hour)`;
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hr) && dom === "*" && mon === "*") {
    const time = formatClock(Number(hr), Number(min));
    if (dow === "*") return `Every day at ${time}`;
    if (dow === "1-5") return `Weekdays at ${time}`;
    const dayName = DAY_NAMES[Number(dow)];
    if (dayName) return `Every ${dayName} at ${time}`;
  }
  return s;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatClock(hr: number, min: number): string {
  const period = hr >= 12 ? "PM" : "AM";
  const h = hr % 12 === 0 ? 12 : hr % 12;
  const m = String(min).padStart(2, "0");
  return `${h}:${m} ${period}`;
}

/**
 * Pick a sensible default agent name for new agent_run steps: prefer "primary"
 * if it exists, otherwise the first agent, otherwise the literal "primary"
 * so the field has *something* useful pre-filled even before metadata loads.
 */
export function defaultAgentName(meta: WorkflowMetadata): string {
  if (meta.agents.includes("primary")) return "primary";
  return meta.agents[0] ?? "primary";
}

/**
 * A `${...}` template variable surfaced in the variable-reference UI. The
 * `path` is the literal text inserted on click (without `${}` wrapping —
 * that's added by the UI). `description` explains where the value comes from.
 */
export interface TemplateVariable {
  path: string;
  description: string;
}

/**
 * Per-trigger input variables. These mirror what the engine seeds on the
 * `input` scope key when the workflow fires from that trigger. The shape of
 * `input` for `manual` is arbitrary (whatever the caller passes), so we
 * surface `input` itself as the entry point rather than guessing fields.
 */
export function triggerInputVariables(trigger: WorkflowTriggerDef | undefined): TemplateVariable[] {
  if (!trigger || trigger.kind === "manual") {
    return [
      {
        path: "input",
        description: "Whatever object was passed at run time (manual trigger).",
      },
    ];
  }
  switch (trigger.kind) {
    case "cron":
      return [];
    case "tool_called":
      return [
        {
          path: "input",
          description: `Arguments the ${trigger.tool || "tool"} was called with.`,
        },
      ];
    case "document_event":
      return [
        { path: "input.document", description: "The document that changed." },
        {
          path: "input.event",
          description: `Which event fired (${trigger.events.join(" / ") || "created/updated/deleted"}).`,
        },
      ];
    case "config_event":
      return [
        { path: "input.path", description: "Dotted config path that changed." },
        { path: "input.value", description: "New value at that path." },
      ];
    case "file_drop":
      return [
        { path: "input.file_path", description: "Absolute path of the dropped file." },
        { path: "input.file_name", description: "Basename of the dropped file." },
        { path: "input.file_ext", description: "Lowercase extension without the dot." },
      ];
    case "webhook":
      return [{ path: "input", description: "JSON body of the inbound POST." }];
    case "email_message":
      return [
        { path: "input.message_id", description: "Gmail message ID." },
        { path: "input.message_body", description: "Full message body (headers + plaintext)." },
        { path: "input.query", description: "The Gmail search query that matched." },
      ];
    case "calendar_event":
      return [
        { path: "input.event_id", description: "Calendar event ID." },
        { path: "input.summary", description: "Event title." },
        { path: "input.start", description: "Start time (ISO)." },
        { path: "input.end", description: "End time (ISO)." },
        { path: "input.minutes_until", description: "Minutes between now and event start." },
        { path: "input.raw", description: "Full raw event object." },
      ];
    case "rss":
      return [
        { path: "input.id", description: "Entry GUID (or link/title fallback)." },
        { path: "input.title", description: "Entry title." },
        { path: "input.link", description: "Entry link." },
        { path: "input.summary", description: "Entry summary / description body." },
        { path: "input.published_at", description: "Publish timestamp string from the feed." },
        { path: "input.author", description: "Entry author when present." },
        { path: "input.url", description: "Feed URL that produced this entry." },
      ];
    case "geofence":
      return [
        { path: "input.transition", description: "Either 'enter' or 'exit'." },
        { path: "input.lat", description: "Current device latitude." },
        { path: "input.lng", description: "Current device longitude." },
        { path: "input.accuracy", description: "Reported accuracy in meters (if any)." },
        { path: "input.distance_meters", description: "Distance from fence center at fire time." },
        { path: "input.center_lat", description: "Configured fence center latitude." },
        { path: "input.center_lng", description: "Configured fence center longitude." },
        { path: "input.radius_meters", description: "Configured fence radius." },
      ];
    case "weather":
      return [
        { path: "input.field", description: "Weather field that crossed (e.g. temperature_2m)." },
        { path: "input.value", description: "Current value." },
        { path: "input.units", description: "Units string from Open-Meteo (if any)." },
        { path: "input.op", description: "Comparison operator: gt/lt/gte/lte/eq." },
        { path: "input.threshold", description: "Configured threshold." },
        { path: "input.observed_at", description: "Timestamp string from Open-Meteo." },
        { path: "input.lat", description: "Configured latitude." },
        { path: "input.lng", description: "Configured longitude." },
      ];
    case "sensor":
      return [
        { path: "input.value", description: "Extracted numeric value." },
        { path: "input.path", description: "JSON path used to extract the value." },
        { path: "input.op", description: "Comparison operator: gt/lt/gte/lte/eq." },
        { path: "input.threshold", description: "Configured threshold." },
        { path: "input.url", description: "Sensor URL." },
      ];
    case "finance":
      return [
        { path: "input.symbol", description: "Ticker symbol." },
        { path: "input.cross", description: "Direction of cross: 'above' or 'below'." },
        { path: "input.threshold", description: "Configured threshold price." },
        { path: "input.price", description: "Close price at fire time." },
        { path: "input.open", description: "Open price." },
        { path: "input.high", description: "Day high." },
        { path: "input.low", description: "Day low." },
        { path: "input.volume", description: "Trading volume." },
        { path: "input.observed_at", description: "Date+time from the quote source." },
      ];
    case "home_assistant":
      return [
        { path: "input.entity_id", description: "Watched entity id." },
        { path: "input.state", description: "Current state value." },
        { path: "input.attributes", description: "Entity attributes object." },
        { path: "input.last_changed", description: "HA last_changed timestamp." },
        { path: "input.last_updated", description: "HA last_updated timestamp." },
        { path: "input.previous_state", description: "Previous state (onAnyChange only)." },
      ];
  }
  return [];
}

/**
 * Globals available in every step, independent of trigger or prior steps.
 * `${env.NAME}` is shown as a templated example since env vars vary.
 */
export const GLOBAL_VARIABLES: TemplateVariable[] = [
  { path: "prev", description: "Output of the step that ran immediately before this one." },
  { path: "env.NAME", description: "An environment variable (replace NAME)." },
];

/** Friendly summary of a step's current configuration, used in node titles. */
export function describeStep(step: WorkflowStepDef): string {
  switch (step.type) {
    case "agent_run":
      return step.agent ? `agent: ${step.agent}` : "agent: (none)";
    case "tool_call":
      return step.tool ? `tool: ${step.tool}` : "tool: (none)";
    case "shell":
      return (step.command ?? "").slice(0, 32) || "(no command)";
    case "channel_message":
      return (step.message ?? "").slice(0, 32) || "(no message)";
    case "trigger_workflow":
      return step.workflow ? `→ ${step.workflow}` : "(no workflow)";
    case "condition":
      return (step.if ?? "").slice(0, 32) || "(no expression)";
    case "loop":
      return step.over ? `over ${step.over}` : "(no array)";
    case "parallel":
      return `${step.steps?.length ?? 0} branches`;
    case "http_request":
      return `${(step.method ?? "GET").toUpperCase()} ${(step.url ?? "").slice(0, 32) || "(no url)"}`;
    case "notify":
      return `${step.channel ?? "?"}: ${(step.message ?? "").slice(0, 28) || "(no message)"}`;
    case "form":
      return (step.prompt ?? "").slice(0, 32) || "(no prompt)";
    case "worktree":
      return `${step.strategy ?? "branch"}${step.branch ? ` → ${step.branch}` : ""}`;
  }
}
