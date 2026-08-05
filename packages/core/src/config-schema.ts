/**
 * Runtime shape validation for the parts of `config.yaml` core owns.
 *
 * `validateConfig` has always been a *semantic* checker: it knows that
 * `web_search` needs an api key, that an agent must not reference a tool
 * nobody enabled, that a subscription must name a room that exists. None of
 * that is expressible as a schema and none of it goes away. What was missing
 * is the layer in front of it — nothing checked that a value was the type the
 * interface said it was. `AgentConfig` is a TypeScript interface, so it is
 * erased at runtime; after `YAML.parse` there was nothing left to compare a
 * value against.
 *
 * The failure mode that produces is the worst kind: the file parses, it reads
 * correctly to a human, and the setting does nothing.
 *
 *   cron:
 *     jobs:
 *       - name: nightly-sweep
 *         enabled: "false"     # quoted
 *
 * `scheduler.ts` asks `job.enabled !== false`, and `"false" !== false`, so the
 * job stayed scheduled. An agent had been asked to disable it, wrote exactly
 * that, and reported "Done". It ran four more times over the next six hours
 * while the log dutifully said "Skipping disabled job" for the four jobs whose
 * flags happened to be real booleans.
 *
 *   tools:
 *     exec:
 *       allowedCommands: [true, false]   # meant the shell builtins
 *
 * Unquoted, YAML makes those booleans; the allowlist compares strings, so both
 * entries matched nothing. That one fails closed, so it was harmless — and
 * equally invisible.
 *
 * ## Why a schema and not more hand-written checks
 *
 * The stronger reason is drift. `KNOWN_AGENT_KEYS` here and
 * `AGENT_DEFINITION_FIELDS` in `resources/agent.ts` were two hand-written
 * copies of the same field list, kept in sync by a docstring asking you to.
 * When they were not, per the record already in `resources/agent.ts`:
 * `fileBoundary` never reached `toolContextExtras`, so three agents holding
 * `write` and `edit` ran with a declared filesystem confinement that did
 * nothing, and thirteen agents set `injectMemory: true` and never got a single
 * injected memory. A declared security boundary that silently no-ops is worse
 * than no field at all. Both lists now derive from {@link AgentDefinitionSchema}.
 *
 * ## Why the interfaces stay
 *
 * The obvious move is `type AgentDefinition = z.infer<typeof Schema>` and
 * delete the interface. That would throw away every doc comment on it, and
 * those comments are the only place the *why* of a field is written down — the
 * OpenRouter reservation behind `maxTokens`, the eleven agents that reported
 * each other's work behind `roomSessionScope`. So the interface stays as the
 * documentation and the schema is checked against it by
 * {@link Identical}, which fails the build if either side gains, loses, or
 * retypes a field. Drift is a compile error either way; this way the prose
 * survives.
 *
 * ## Scope
 *
 * `AgentDefinition` and `CronJobConfig` are closed records core fully owns, so
 * they are validated field by field. `tools.*`, `channels.*` and
 * `mcp.servers.*` are open bags by design — a plugin's config shape is the
 * plugin's business, and per CLAUDE.md core must never know it — so only the
 * one field every entry in them shares is checked: `enabled` is a boolean
 * everywhere it appears, and a quoted `"false"` there enables the thing it
 * claims to disable, exactly as it did for cron.
 */

import { z } from "zod";
import type { CustomLayer, SystemPromptOverride } from "./agent/system-prompt.js";
import type {
  AgentConfig,
  AgentDefinition,
  AgentHook,
  CronJobConfig,
  ModelEntry,
  OnlineAgentConfig,
} from "./config.js";
import type { CommandRules } from "./tools/command-allowlist.js";

/**
 * True only when two types are identical, not merely mutually assignable.
 *
 * Two-way `extends` is not enough here: an optional field present on one side
 * and absent from the other passes it in both directions, and an optional
 * field going missing is precisely the drift this guards against. The
 * conditional-type identity trick below distinguishes them.
 */
type Identical<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** Fails the build with "Type 'false' does not satisfy the constraint 'true'". */
type AssertTrue<T extends true> = T;

const ModelEntrySchema = z.object({
  provider: z.string(),
  model: z.string(),
  maxContextTokens: z.number().optional(),
});
type _ModelEntryMatches = AssertTrue<Identical<z.infer<typeof ModelEntrySchema>, ModelEntry>>;

const AgentHookSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).optional(),
  skipIf: z.string().optional(),
  onError: z.enum(["abort", "continue"]).optional(),
});
type _AgentHookMatches = AssertTrue<Identical<z.infer<typeof AgentHookSchema>, AgentHook>>;

/** `beforeRun: {…}` and `beforeRun: [{…}]` are both accepted, as they always were. */
const HookSlotSchema = z.union([AgentHookSchema, z.array(AgentHookSchema)]);

const HooksSchema = z.object({
  beforeRun: HookSlotSchema.optional(),
  afterRun: HookSlotSchema.optional(),
});

const CommandRulesSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});
type _CommandRulesMatches = AssertTrue<Identical<z.infer<typeof CommandRulesSchema>, CommandRules>>;

const OnlineAgentConfigSchema = z.object({
  enabled: z.boolean().optional(),
  cadence: z
    .object({
      interval_minutes: z.number().optional(),
      idle_backoff_multiplier: z.number().optional(),
      max_interval_minutes: z.number().optional(),
      window: z.object({ start: z.string(), end: z.string() }).optional(),
    })
    .optional(),
  goals_file: z.string().optional(),
  budgets: z
    .object({
      tokens_per_tick: z.number().optional(),
      tokens_per_day: z.number().optional(),
      tool_calls_per_tick: z.number().optional(),
      stop_after_runs_per_day: z.number().optional(),
    })
    .optional(),
  output: z
    .object({
      notes: z.boolean().optional(),
      facts: z.boolean().optional(),
      tasks: z.boolean().optional(),
      notify_owner: z.boolean().optional(),
    })
    .optional(),
  tools: z.array(z.string()).optional(),
});
type _OnlineAgentConfigMatches = AssertTrue<Identical<z.infer<typeof OnlineAgentConfigSchema>, OnlineAgentConfig>>;

const CustomLayerSchema = z.object({
  name: z.string(),
  content: z.string().optional(),
  file: z.string().optional(),
});
type _CustomLayerMatches = AssertTrue<Identical<z.infer<typeof CustomLayerSchema>, CustomLayer>>;

const SystemPromptOverrideSchema = z.object({
  base: z.string().optional(),
  baseFile: z.string().optional(),
  order: z.array(z.string()).optional(),
  tail: z.array(z.string()).optional(),
  custom: z.array(CustomLayerSchema).optional(),
});
type _SystemPromptOverrideMatches = AssertTrue<
  Identical<z.infer<typeof SystemPromptOverrideSchema>, SystemPromptOverride>
>;

/**
 * The global `agent:` block — the deployment-wide defaults every agent
 * inherits. Anchored to `AgentConfig["agent"]` rather than a named interface
 * because that block is declared inline; the drift assertion works the same.
 *
 * Validated `.partial()` at the call site. Presence is not this checker's
 * business — `DEFAULT_CONFIG` supplies anything missing, and reporting
 * "required" for a field the loader fills in would be noise. What matters is
 * that a value which *is* written is the type it is declared to be.
 */
const AgentSettingsSchema = z.object({
  defaultProvider: z.string(),
  models: z.array(ModelEntrySchema).optional(),
  extraInstructions: z.string(),
  maxHistoryTokens: z.number(),
  maxToolOutputChars: z.number(),
  maxContextTokens: z.number(),
  temperature: z.number(),
  maxTokens: z.number().optional(),
  maxToolRounds: z.number(),
  sandbox: z.string().optional(),
  systemPrompt: SystemPromptOverrideSchema.optional(),
});
type _AgentSettingsMatches = AssertTrue<Identical<z.infer<typeof AgentSettingsSchema>, AgentConfig["agent"]>>;

/** `tasks.backend` selects a registered backend; `options` is the backend's own opaque bag. */
const TasksConfigSchema = z.object({
  backend: z.string().optional(),
  options: z.record(z.unknown()).optional(),
});
type _TasksConfigMatches = AssertTrue<Identical<z.infer<typeof TasksConfigSchema>, NonNullable<AgentConfig["tasks"]>>>;

/**
 * Two closed sub-blocks of `memory:`. Not the whole block — the rest is larger
 * and can follow — but these are all scalars, which is where a quoted number
 * hides best.
 */
const MemoryEmbeddingsSchema = z.object({
  enabled: z.boolean().optional(),
  type: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  dim: z.number().optional(),
  maxInputChars: z.number().optional(),
});
type _MemoryEmbeddingsMatches = AssertTrue<
  Identical<z.infer<typeof MemoryEmbeddingsSchema>, NonNullable<NonNullable<AgentConfig["memory"]>["embeddings"]>>
>;

const MemoryChunksSchema = z.object({
  maxChunkChars: z.number().optional(),
  overlap: z.number().optional(),
});
type _MemoryChunksMatches = AssertTrue<
  Identical<z.infer<typeof MemoryChunksSchema>, NonNullable<NonNullable<AgentConfig["memory"]>["chunks"]>>
>;

/**
 * One agent block. Every field on {@link AgentDefinition}, in the same order,
 * so the two read side by side.
 *
 * Not `.strict()`: unknown keys are already reported by `unknownAgentKeysFor`
 * with a "did you mean" suggestion that beats anything a schema would say, and
 * it derives its key set from this shape.
 */
export const AgentDefinitionSchema = z.object({
  description: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  models: z.array(ModelEntrySchema).optional(),
  instructions: z.string().optional(),
  tools: z.array(z.string()).optional(),
  temperature: z.number().optional(),
  thinking: z.enum(["off", "auto", "low", "medium", "high"]).optional(),
  maxTokens: z.number().optional(),
  maxToolRounds: z.number().optional(),
  fileBoundary: z.string().optional(),
  exec: CommandRulesSchema.optional(),
  roomSessionScope: z.enum(["room", "shared"]).optional(),
  contextDir: z.string().optional(),
  nudgeOnText: z.number().optional(),
  nudgeMessage: z.string().optional(),
  skipGlobalContext: z.boolean().optional(),
  summarizeOnTrim: z.boolean().optional(),
  worktree: z.boolean().optional(),
  taskPreamble: z.string().optional(),
  injectMemory: z.boolean().optional(),
  budgetWarnings: z.boolean().optional(),
  memoryInjectBudgetTokens: z.number().optional(),
  memoryInjectLimit: z.number().optional(),
  hooks: HooksSchema.optional(),
  // Open on purpose: plugins register sandbox kinds core has never heard of.
  sandbox: z.string().optional(),
  skills: z.array(z.string()).optional(),
  skillLoading: z.enum(["eager", "progressive"]).optional(),
  online: OnlineAgentConfigSchema.optional(),
  systemPrompt: SystemPromptOverrideSchema.optional(),
});
type _AgentDefinitionMatches = AssertTrue<Identical<z.infer<typeof AgentDefinitionSchema>, AgentDefinition>>;

/**
 * Every key an agent block may carry, derived rather than retyped.
 *
 * This is the whole point of the exercise: adding a field to
 * {@link AgentDefinition} without adding it here used to be a silent no-op, and
 * is now impossible — the schema has to gain the field for the build to pass,
 * and this set is the schema's keys.
 */
export const AGENT_DEFINITION_KEYS: ReadonlySet<string> = new Set(Object.keys(AgentDefinitionSchema.shape));

export const CronJobConfigSchema = z.object({
  name: z.string(),
  schedule: z.string(),
  prompt: z.string(),
  sessionKey: z.string().optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
  profile: z.string().optional(),
  workflow: z.string().optional(),
  enabled: z.boolean().optional(),
  delivery: z
    .object({
      channel: z.string().optional(),
      mode: z.enum(["channel", "dm"]).optional(),
      target: z.string().optional(),
    })
    .optional(),
  wakeAgent: z.boolean().optional(),
  newSession: z.boolean().optional(),
  hooks: HooksSchema.optional(),
  project: z.string().optional(),
});
type _CronJobConfigMatches = AssertTrue<Identical<z.infer<typeof CronJobConfigSchema>, CronJobConfig>>;

/**
 * The core-owned fields of `tools.exec`.
 *
 * Hand-written and not checked against an interface, because there is no
 * closed interface to check against: `tools` is an open bag whose index
 * signature swallows any key, so `keyof` tells us nothing. The fields below
 * are core's own and the list is short; a plugin key landing here passes
 * through untouched.
 */
const ExecToolConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowedCommands: z.array(z.string()).optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    mode: z.enum(["intersect", "override"]).optional(),
  })
  .passthrough();

/** The one field every entry in an open bag shares. */
const EnabledFlagSchema = z.object({ enabled: z.boolean().optional() }).passthrough();

/** Follow a zod issue path back to the value that caused it, for the message. */
function valueAt(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur = root;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

function describe(value: unknown): string {
  if (value === null) return "null (an empty key)";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (typeof value === "object") return "a map";
  return `the ${typeof value} \`${String(value)}\``;
}

/**
 * The extra sentence for the case this module exists for: a value that is the
 * right thing wearing quotes.
 *
 * Worth spelling out because the consequence is counter-intuitive and, for a
 * flag, inverted — `"false"` is a non-empty string, every truthiness check
 * reads it as on, and the setting does the opposite of what it says.
 */
function quotingHint(expected: string, value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (expected === "boolean" && /^(true|false)$/i.test(text)) {
    const inverted =
      text.toLowerCase() === "false" ? " A non-empty string is truthy, so this currently reads as `true`." : "";
    return ` The quotes make it text.${inverted} Write \`${text.toLowerCase()}\` without them.`;
  }
  if (expected === "number" && text !== "" && Number.isFinite(Number(text))) {
    return ` The quotes make it text. Write \`${text}\` without them.`;
  }
  return "";
}

/** Turn one zod issue into a line a person — or the model that wrote the config — can act on. */
function formatIssue(scope: string, pathPrefix: string, issue: z.ZodIssue, root: unknown): string {
  const path = [...(pathPrefix ? [pathPrefix] : []), ...issue.path].join(".");
  const where = path ? `${scope}: \`${path}\`` : scope;
  const actual = valueAt(root, issue.path);

  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === "undefined") return `${where} is required but missing.`;
    return `${where} must be ${aOrAn(issue.expected)}, got ${describe(actual)}.${quotingHint(issue.expected, actual)}`;
  }
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return `${where} must be one of ${issue.options.map((o) => `\`${String(o)}\``).join(", ")}, got ${describe(actual)}.`;
  }
  if (issue.code === z.ZodIssueCode.invalid_union) {
    // `hooks.beforeRun` takes one hook or a list of them. Reporting "matches
    // no accepted shape" for `{tool: 5}` buries the only useful fact — that
    // `tool` has to be a string. The branch that got furthest before failing
    // is the one the author was aiming at, so report its complaint instead.
    const best = deepestIssue(issue.unionErrors.flatMap((e) => e.issues));
    if (best && best.path.length > issue.path.length) return formatIssue(scope, pathPrefix, best, root);
    return `${where} does not match any accepted shape — got ${describe(actual)}.`;
  }
  return `${where}: ${issue.message}`;
}

function deepestIssue(issues: z.ZodIssue[]): z.ZodIssue | undefined {
  return issues.reduce<z.ZodIssue | undefined>(
    (best, issue) => (!best || issue.path.length > best.path.length ? issue : best),
    undefined,
  );
}

function aOrAn(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * `undefined` means "the key is absent", which every optional field already
 * tolerates. Stripping it keeps an explicitly-undefined key from being
 * reported as a type error. `null` is deliberately *not* stripped: `key:` with
 * nothing after it is a key that will never be read, which is the whole class
 * this module reports on.
 */
function withoutUndefined(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Run one schema over one value and render whatever it rejects.
 *
 * `pathPrefix` is prepended to every reported path, for callers whose value
 * sits under a wrapper the schema does not see — a resource manifest nests the
 * agent block under `data`, and an error naming `temperature` when the file
 * says `data.temperature` sends the reader to the wrong line.
 */
export function shapeIssues(scope: string, schema: z.ZodTypeAny, value: unknown, pathPrefix = ""): string[] {
  const subject = withoutUndefined(value);
  const result = schema.safeParse(subject);
  if (result.success) return [];
  return result.error.issues.map((issue) => formatIssue(scope, pathPrefix, issue, subject));
}

/**
 * Every place a config value is not the type it is declared to be.
 *
 * Returned as strings rather than thrown, and joined to the same stream
 * `validateConfig` already produces, so the existing consumers work unchanged:
 * printed at startup, and — via `findInertConfig` — enough to refuse a runtime
 * write that would introduce one. Refusing the write is the half that matters.
 * A warning at startup is a warning nobody reads six hours later; a rejected
 * write answers the agent that got it wrong, while it is still holding the pen.
 */
export function findShapeIssues(config: AgentConfig): string[] {
  const found: string[] = [];

  // The deployment-wide defaults. Checked `.partial()`: this is a type
  // checker, not a required-fields checker, and `DEFAULT_CONFIG` fills the
  // gaps. `agent.maxTokens: "8192"` is the case that motivated it — a
  // non-empty string is truthy, so the loop's `if (params.maxTokens)` guard
  // does not catch it and the quoted value goes out on the wire.
  if (config.agent != null) {
    found.push(...shapeIssues("agent", AgentSettingsSchema.partial(), config.agent));
  }

  if (config.tasks != null) {
    found.push(...shapeIssues("tasks", TasksConfigSchema, config.tasks));
  }

  if (config.memory?.embeddings != null) {
    found.push(...shapeIssues("memory.embeddings", MemoryEmbeddingsSchema, config.memory.embeddings));
  }
  if (config.memory?.chunks != null) {
    found.push(...shapeIssues("memory.chunks", MemoryChunksSchema, config.memory.chunks));
  }

  for (const [name, agent] of Object.entries(config.agents ?? {})) {
    if (agent == null) continue;
    found.push(...shapeIssues(`Agent "${name}"`, AgentDefinitionSchema, agent));
  }

  for (const [index, job] of (config.cron?.jobs ?? []).entries()) {
    if (job == null) continue;
    // Jobs are addressed by name in the log and by index in the file; a job
    // whose `name` is the broken field still needs to be findable.
    const label = typeof job.name === "string" && job.name ? `Cron job "${job.name}"` : `Cron job #${index + 1}`;
    found.push(...shapeIssues(label, CronJobConfigSchema, job));
  }

  if (config.tools?.exec != null) {
    found.push(...shapeIssues("tools.exec", ExecToolConfigSchema, config.tools.exec));
  }

  // Open bags: only `enabled` is core's to judge.
  for (const [bag, entries] of [
    ["tools", config.tools],
    ["channels", config.channels],
    ["mcp.servers", config.mcp?.servers],
  ] as const) {
    for (const [id, entry] of Object.entries(entries ?? {})) {
      if (entry == null || typeof entry !== "object") continue;
      if (bag === "tools" && id === "exec") continue; // already checked in full
      found.push(...shapeIssues(`${bag}.${id}`, EnabledFlagSchema, entry));
    }
  }

  return found;
}
