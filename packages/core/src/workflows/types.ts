export type StepType =
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

export type OnErrorPolicy = "fail" | "continue" | "retry";

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
}

/**
 * Optional contract metadata on a step's input or output. Used by the UI to
 * validate edges between steps; the engine does not enforce these for v1.
 *
 * - `raw_text`: plain string
 * - `number`: numeric value
 * - `choice`: one of a fixed enum
 * - `json_schema`: structured object validated against a JSON Schema
 */
export type StepContract =
  | { kind: "raw_text" }
  | { kind: "number" }
  | { kind: "choice"; choices: string[] }
  | { kind: "json_schema"; schema: Record<string, unknown> };

export interface BaseStep {
  name: string;
  type: StepType;
  deadlineMs?: number;
  onError?: OnErrorPolicy;
  retry?: RetryPolicy;
  /** Optional contract for what this step expects from its predecessor. */
  inputContract?: StepContract;
  /** Optional contract for what this step produces for successors. */
  outputContract?: StepContract;
}

export interface AgentRunStep extends BaseStep {
  type: "agent_run";
  agent: string;
  prompt: string;
  maxToolRounds?: number;
  modelOverride?: string;
  /**
   * When "json", the agent's final response is parsed as JSON before being
   * stored as the step's output — so downstream `loop.over` / `condition`
   * steps see the structured value (array / object) instead of a string.
   * Tolerates ```json fenced blocks and leading/trailing prose.
   */
  parseAs?: "json" | "text";
}

export interface ToolCallStep extends BaseStep {
  type: "tool_call";
  tool: string;
  args?: Record<string, unknown>;
}

export interface ShellStep extends BaseStep {
  type: "shell";
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ConditionStep extends BaseStep {
  type: "condition";
  if: string;
  then?: string[];
  else?: string[];
}

export interface LoopStep extends BaseStep {
  type: "loop";
  over: string;
  as: string;
  body: WorkflowStepDef[];
  parallel?: boolean;
  maxConcurrency?: number;
}

export interface ParallelStep extends BaseStep {
  type: "parallel";
  steps: WorkflowStepDef[];
}

/**
 * Send a Discord message. Reuses the configured Discord channel; the target
 * defaults to the owner DM when neither `channelId` nor `userId` is provided.
 */
export interface DiscordMessageStep extends BaseStep {
  type: "discord_message";
  /** Message body. Supports `${steps.X.output}` / `${input.field}` expressions. */
  message: string;
  /** Optional override: post to a specific channel ID. */
  channelId?: string;
  /** Optional override: DM a specific user ID. */
  userId?: string;
}

/**
 * Run another registered workflow as a child step. The child's final output
 * becomes this step's output, so it composes with the rest of the pipeline.
 */
export interface TriggerWorkflowStep extends BaseStep {
  type: "trigger_workflow";
  /** Name of the workflow to invoke. */
  workflow: string;
  /** Optional input bundle passed to the child workflow's `input` scope. */
  input?: Record<string, unknown>;
  /** When true, fires the child without awaiting its result. Output is `{ runId }`. */
  fireAndForget?: boolean;
}

/**
 * Generic HTTP request. Templated url/headers/body via `${...}`. Used for
 * integrating with arbitrary REST APIs (Plaid, weather, Home Assistant, Stripe,
 * etc.) without writing a bespoke tool.
 *
 * Output shape: `{ status: number, headers: Record<string, string>, body: unknown }`.
 * `body` is parsed JSON when `parseAs: "json"` (default when response Content-Type
 * is application/json), otherwise the raw response text.
 */
export interface HttpRequestStep extends BaseStep {
  type: "http_request";
  /** Target URL. Supports `${...}` interpolation. */
  url: string;
  /** HTTP method. Defaults to `GET`. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  /** Request headers. Values support `${...}` interpolation. */
  headers?: Record<string, string>;
  /**
   * Request body. If an object, JSON-encoded and `Content-Type: application/json`
   * is set when not overridden. If a string, sent verbatim. Values support
   * `${...}` interpolation.
   */
  body?: unknown;
  /** When set, response body is force-parsed as this kind. Default: auto. */
  parseAs?: "json" | "text" | "raw";
  /** Per-step timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Treat any of these status codes as success. Default: 2xx. */
  expectStatus?: number[];
}

/**
 * Multi-channel notification. Generalizes `discord_message` to also support
 * email and a log channel, with web-push to follow once the VAPID surface
 * lands. The shape is intentionally flat — the `channel` discriminator
 * selects which optional target field is consulted.
 *
 * `discord_message` remains as a legacy alias; the engine routes both to the
 * same underlying notify executor.
 */
export type NotifyChannel = "discord" | "email" | "log";

export interface NotifyStep extends BaseStep {
  type: "notify";
  /** Which channel to dispatch the message through. */
  channel: NotifyChannel;
  /** Message body. Supports `${...}` interpolation. */
  message: string;
  /** Optional subject line. Used by `email`; ignored by other channels. */
  subject?: string;
  /** Optional Discord channel ID (channel: "discord"). */
  channelId?: string;
  /** Optional Discord user ID for DM (channel: "discord"). */
  userId?: string;
  /** Optional comma-separated email recipients (channel: "email"). */
  to?: string;
}

/**
 * Pause the workflow and ask a human for structured input. The run waits
 * in-process for a submission via `POST /api/workflow-runs/:id/forms/:stepName`
 * (or any equivalent transport). Once submitted, the step's output is
 * `{ fields: Record<string, unknown> }` and the workflow resumes.
 *
 * If `notify` is set, the engine fires a notification when the form goes
 * pending so the user knows to fill it out. Without `notify`, the form
 * still appears in the UI's pending-forms list but no proactive ping is sent.
 *
 * On server restart, in-flight forms are cancelled and the run is marked
 * `interrupted` — same posture as any other in-flight step. Re-running the
 * workflow starts fresh.
 */
export interface FormStep extends BaseStep {
  type: "form";
  /** Prompt rendered above the form. Supports `${...}` interpolation. */
  prompt: string;
  /** Reuses the workflow inputs schema shape for parity. */
  fields: WorkflowInputsSchema;
  /** Optional notification fired when the form goes pending. */
  notify?: {
    /** Notification channel. Only `discord` and `log` supported today. */
    channel: "discord" | "log";
    /** Optional Discord channel/user override. */
    channelId?: string;
    userId?: string;
    /** Overrides the default "Form '<name>' needs your input" message. */
    message?: string;
  };
  /**
   * How long to wait before treating the form as expired and failing the
   * step. Defaults to 24h (86_400_000 ms).
   */
  timeoutMs?: number;
}

/**
 * Branch-aware coding step. Creates a git worktree, runs nested steps with
 * `${worktree.path}` exposed in scope, then optionally merges back into HEAD.
 *
 * Body steps that need to operate on the worktree files should use
 * `cwd: ${worktree.path}` (shell) or rely on the executor's worktree
 * awareness (agent_run reads `scope.vars.worktree.path` as its cwd
 * automatically). The worktree is always cleaned up on completion; dirty
 * worktrees are preserved on disk and the path is returned in the step output.
 *
 * Output shape: `{ path, branch, merged, mergeError?, preservedPath? }`.
 */
export interface WorktreeStep extends BaseStep {
  type: "worktree";
  /**
   * Branch strategy. See `packages/core/src/worktree.ts` for semantics.
   * - `head`: no worktree, runs body in the current repo dir (debug pass-through).
   * - `branch`: fresh worktree on a named branch; no merge.
   * - `merge-to-head`: same as `branch` plus a post-body `git merge --no-ff` back to HEAD.
   */
  strategy: "head" | "branch" | "merge-to-head";
  /** Branch name. Required for `branch` strategy; optional otherwise (auto-generated). */
  branch?: string;
  /** Repo dir. Defaults to the workflow runtime cwd. Supports `${...}` interpolation. */
  repoDir?: string;
  /** Explicit worktree path. Defaults to `<repoDir>/.worktrees/<branch>`. */
  worktreePath?: string;
  /** Nested step list executed inside the worktree. */
  body: WorkflowStepDef[];
  /**
   * For `merge-to-head` only: merge after the body completes successfully.
   * Defaults to true. Set false to keep the branch around for a follow-up PR.
   */
  mergeOnSuccess?: boolean;
}

export type WorkflowStepDef =
  | AgentRunStep
  | ToolCallStep
  | ShellStep
  | ConditionStep
  | LoopStep
  | ParallelStep
  | DiscordMessageStep
  | TriggerWorkflowStep
  | HttpRequestStep
  | NotifyStep
  | FormStep
  | WorktreeStep;

/**
 * How a workflow gets fired. Extensible discriminated union — add new variants
 * as integrations land (e.g. "tool_called" when a specific tool is invoked,
 * "document_event" when a document is created/updated, "config_event" when
 * a config field changes).
 */
export type WorkflowTriggerDef =
  | { kind: "manual" }
  | { kind: "cron"; schedule: string }
  | { kind: "tool_called"; tool: string }
  | { kind: "document_event"; events: ("created" | "updated" | "deleted")[] }
  | { kind: "config_event"; path?: string }
  | {
      kind: "file_drop";
      /** Directory to watch. Relative paths resolve against the workflow runtime cwd. */
      path: string;
      /**
       * Optional file-extension filter ("pdf", "jpg", or comma-separated list).
       * When unset, every newly-stable file in the directory fires the workflow.
       */
      extensions?: string;
      /**
       * Debounce window: a file must remain unchanged for this many ms before
       * firing. Defaults to 1500 — enough to skip an interrupted upload.
       */
      stableForMs?: number;
    }
  | {
      kind: "fs_watch";
      /**
       * Glob-aware file watcher. Supports:
       *   - `config.paths`: one or more paths/globs to watch
       *   - `config.events`: which events to fire on (default: create, modify)
       *   - `config.debounceMs`: debounce window in ms (default: 500)
       *   - `config.ignored`: glob patterns to exclude
       *   - `config.deep`: when false, watch only top-level entries
       */
      config: {
        /** One or more paths or glob patterns to watch. */
        paths: string | string[];
        /** Which events to react to. Default: ["create", "modify"]. */
        events?: ("create" | "modify" | "delete")[];
        /** Debounce window in ms. Default: 500. */
        debounceMs?: number;
        /** Ignore patterns (glob). */
        ignored?: string | string[];
        /** When false, watch only top-level entries. Default: true (recursive). */
        deep?: boolean;
      };
    }
  | {
      kind: "webhook";
      /**
       * Optional bearer-style secret. When set, inbound webhook calls must
       * present this in an `Authorization: Bearer <token>` header. Unset =
       * anyone with the URL can fire the workflow.
       */
      token?: string;
    }
  | {
      kind: "email_message";
      /**
       * Gmail-style search query (e.g. `is:unread newer_than:1h from:billing@acme.com`).
       * The poller runs this every `intervalSeconds` seconds and fires the workflow
       * once per *new* message it hasn't seen before.
       */
      query: string;
      /** Poll interval in seconds. Default 300 (5 min). Min 30. */
      intervalSeconds?: number;
    }
  | {
      kind: "rss";
      /** Feed URL (RSS 2.0 or Atom). */
      url: string;
      /** Poll interval in seconds. Default 600 (10 min). Min 60. */
      intervalSeconds?: number;
      /**
       * Optional case-insensitive substring filter against entry titles. When
       * unset, every new entry fires the workflow.
       */
      matchTitle?: string;
    }
  | {
      kind: "calendar_event";
      /**
       * Fire the workflow this many minutes before a matching event starts.
       * Default 15. Useful for meeting-prep reminders.
       */
      beforeMinutes?: number;
      /**
       * Optional substring filter against event titles. When unset, every
       * event in the polled window fires.
       */
      titleContains?: string;
      /** Calendar id (e.g. "primary" or an email). */
      calendarId?: string;
      /** Poll interval in seconds. Default 300. Min 60. */
      intervalSeconds?: number;
    }
  | {
      kind: "geofence";
      /** URL returning `{lat, lng, accuracy?}` as JSON. */
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
      /** Open-Meteo `current` field (e.g. "temperature_2m", "precipitation"). */
      field: string;
      op: "gt" | "lt" | "gte" | "lte" | "eq";
      threshold: number;
      intervalSeconds?: number;
      apiBaseUrl?: string;
    }
  | {
      kind: "sensor";
      /** URL returning JSON. */
      url: string;
      /** Dot/bracket path to a numeric value (e.g. "data.temperature"). */
      valuePath: string;
      op: "gt" | "lt" | "gte" | "lte" | "eq";
      threshold: number;
      intervalSeconds?: number;
      headers?: Record<string, string>;
    }
  | {
      kind: "finance";
      /** Stooq-style ticker (e.g. "aapl.us", "eurusd"). */
      symbol: string;
      cross: "above" | "below";
      threshold: number;
      intervalSeconds?: number;
      apiBaseUrl?: string;
    }
  | {
      kind: "home_assistant";
      /** Home Assistant base URL (e.g. "http://homeassistant.local:8123"). */
      baseUrl: string;
      /** Long-lived access token. */
      token: string;
      /** Entity id to watch (e.g. "binary_sensor.front_door"). */
      entityId: string;
      stateEquals?: string;
      numericAbove?: number;
      numericBelow?: number;
      onAnyChange?: boolean;
      intervalSeconds?: number;
    };

/**
 * 2D graph layout metadata. Optional — when present the UI uses these
 * positions; when absent it lays out `steps[]` in a column automatically.
 * The runtime engine ignores this entirely and executes `steps[]` in order.
 */
export interface WorkflowGraphNode {
  /** Matches `BaseStep.name`. */
  stepName: string;
  position: { x: number; y: number };
}

export interface WorkflowGraphEdge {
  /** Source step name (or "__trigger__" for the workflow entry point). */
  from: string;
  /** Target step name. */
  to: string;
  /**
   * Optional named source handle. Today only `condition` steps emit named
   * handles ("true" / "false") so callers can wire each branch independently.
   * Most edges leave this unset.
   */
  sourceHandle?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
}

/**
 * How the engine walks the workflow's steps.
 *
 * - `"linear"` (default): execute `steps[]` in order, threading the previous
 *   step's output into the next as `prev`. Independent siblings run sequentially.
 * - `"graph"`: derive a dependency DAG from `graph.edges` and run independent
 *   nodes concurrently. Required for fan-out: the morning-digest template's
 *   `news` + `markets` only run in parallel when this is set.
 *
 * `"linear"` is the default for back-compat. New workflows created in the UI
 * should set `"graph"` so the visual fan-out matches runtime behavior.
 */
export type WorkflowExecutionMode = "linear" | "graph";

/**
 * Type of an `inputs[name]` field. Used to generate a UI run form and to
 * validate inbound payloads. Kept intentionally tiny — anything richer
 * (regex, oneOf, oneOf-with-labels) can be layered later without breaking
 * the existing shapes.
 */
export type WorkflowInputType = "string" | "number" | "boolean" | "date" | "file" | "json";

export interface WorkflowInputSchema {
  /** Field type. Drives both UI rendering and runtime validation. */
  type: WorkflowInputType;
  /** Human-readable label used in the Run dialog. */
  label?: string;
  /** Longer placeholder/description shown beside the field. */
  description?: string;
  /** Marks the field required. Default false. */
  required?: boolean;
  /** Default value when the caller doesn't supply one. */
  default?: unknown;
  /**
   * Restrict a `string` field to a fixed list of choices — renders as a
   * dropdown in the UI and rejects unknown values at runtime.
   */
  enum?: string[];
  /** Min/max numeric bounds (only meaningful for type: "number"). */
  min?: number;
  max?: number;
}

export type WorkflowInputsSchema = Record<string, WorkflowInputSchema>;

export interface WorkflowDefinition {
  name: string;
  description?: string;
  deadlineMs?: number;
  steps: WorkflowStepDef[];
  /** Optional declarative triggers — additive to the existing cron/webhook bindings. */
  triggers?: WorkflowTriggerDef[];
  /** Optional 2D layout used by the visual editor. Does not affect runtime semantics. */
  graph?: WorkflowGraph;
  /**
   * Execution strategy. Defaults to "linear" when omitted. Set to "graph" to
   * unlock real parallel fan-out based on `graph.edges`.
   */
  executionMode?: WorkflowExecutionMode;
  /**
   * Declarative input schema. Drives the UI's "Run" dialog and is enforced on
   * inbound HTTP runs. Optional — workflows that already grab arbitrary input
   * via `${input.foo}` stay backwards-compatible by omitting this.
   */
  inputs?: WorkflowInputsSchema;
  /**
   * Optional run-level sandbox. When set, the engine prepares one sandbox
   * handle at the start of the run and threads it into every step's context.
   * `shell` and `worktree` steps route through this handle so artifacts persist
   * across steps (e.g. build outputs and node_modules survive between an
   * agent_run and a follow-up shell test step). Defaults to "host" (no
   * isolation) when omitted.
   */
  sandbox?: "host" | "docker" | "podman";
}

export interface RegisteredWorkflow {
  definition: WorkflowDefinition;
  /** Source path (when loaded from disk) or "programmatic". */
  source: string;
  /** Runtime generation when registered. */
  generation: number;
}

/**
 * Typed identity function for declaring workflows in TypeScript. The runtime
 * doesn't need this — but TS callers get autocomplete + step-type checking
 * by going through it instead of building a plain object.
 */
export function defineWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
  return workflow;
}
