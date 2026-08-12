/**
 * Run one scenario against a live model, through the real code.
 *
 * The whole value of this harness is that it does not hand-write an invocation
 * message. It stands up a genuine `AgentRuntime` on a throwaway home, seeds a
 * genuine session or a genuine set of rooms, and lets `runAgentLoop` /
 * `RoomWatcher` assemble the request exactly the way production does. A change
 * to prompt assembly therefore shows up here without anyone updating the
 * benchmark — which is the only way a benchmark stays honest.
 *
 * Three things are deliberately not real:
 *
 *   the home     — a fresh temp directory per run, so nothing reads or writes a
 *                  deployment's config, database or context files.
 *   the tools    — side-effecting tools keep their real name, description and
 *                  schema (the model must see what it sees in production) but
 *                  their `execute` is replaced by a canned result. Tool
 *                  *selection* is what is under test; tool *effects* are not.
 *   the streaming — the recording provider exposes `chat` only, so the loop
 *                  takes the blocking path. Same request body, no SSE.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider, ChatParams, ChatResponse, Tool } from "@tailored-ai/core";
import {
  AgentRuntime,
  createEmbedder,
  createMetaTools,
  createPluginContext,
  createProvider,
  createTools,
  findOrCreateSession,
  formatRoomRef,
  initDatabase,
  LocalRoomBackend,
  type LoopStop,
  loadConfig,
  loadPlugins,
  makeRoomSessionKey,
  newSession,
  parseEnvelope,
  RoomWatcher,
  runAgentLoop,
  saveMessage,
  TypedEventBus,
  unregisterRoomBackend,
} from "@tailored-ai/core";
import YAML from "yaml";
import { registerPinnedClock, timeConfigBlock } from "./clock.js";
import type {
  RecordedCall,
  RecordedExecution,
  RecordedRequest,
  RoomLine,
  RunOutcome,
  RunUsage,
  Scenario,
  ToolResults,
} from "./types.js";

export interface HarnessOptions {
  baseUrl: string;
  model: string;
  /** Literal key, or `${VAR}` for `loadConfig` to interpolate so it never hits disk. */
  apiKey: string;
  temperature: number;
  /**
   * Cap on generated tokens, or null to send no cap at all.
   *
   * Null is not a nicety: some hosted models reject `max_tokens` outright and
   * want `max_completion_tokens` instead, which reaches them through
   * `providerExtra`. There has to be a way to stop core emitting the field it
   * would otherwise always emit.
   */
  maxTokens: number | null;
  maxToolRounds: number;
  /** vLLM sampling controls, sent as `providerExtra`. Mirrors a deployment's own. */
  providerExtra: Record<string, unknown>;
  /** Per-run seed. Sent to the provider so a repeat is reproducible. */
  seed: number | null;
  timeoutMs: number;
  /**
   * Copied from the target deployment's provider block, because reasoning
   * changes both what the model produces and what a turn costs. Benchmarking a
   * thinking deployment with thinking off measures a model it does not run.
   */
  thinkingDialect?: string;
  thinking?: string;
  /**
   * Provider plugins to load before the runtime is built, e.g.
   * `@tailored-ai/provider-openai`.
   *
   * Without these the benchmark can only exercise core's generic
   * `openai_compatible` client — which is the right target for a vLLM
   * deployment and the wrong one for every fallback rung, since a plugin is
   * where vendor recovery lives. `provider-openai` already knows that
   * gpt-5.6 wants `max_completion_tokens` and that it refuses function tools
   * unless `reasoning_effort` is "none"; benchmarking without it measures a
   * client the deployment does not use.
   */
  plugins?: string[];
  /** Provider id the agent runs on. Defaults to `openai_compatible`. */
  providerId?: string;
  /**
   * Instant every scenario's civil-time reasoning resolves against, as an ISO
   * string. `null` runs on the host clock the way this used to.
   *
   * Pinned by default. Several scenarios book wakes against wall-clock phrases,
   * and on the host clock they only reproduce on a similar day — a published
   * baseline re-run on a Monday morning could differ for reasons the report
   * cannot show. See `clock.ts`.
   */
  pinnedAt?: string | null;
  /** IANA zone the pinned clock reports. Ignored when `pinnedAt` is null. */
  timeZone?: string;
}

const OWNER_ID = "owner-0000";
const OWNER_LABEL = "quinton";

/**
 * Tools whose real `execute` is replaced.
 *
 * The rule is "anything that reaches outside this process": the filesystem, the
 * network, another model, a real Discord account. `room`, `schedule`,
 * `core_memory`, `recall` and `tasks` are left real — they only touch the
 * throwaway database, and a scenario about scheduling that stubs `schedule`
 * would be testing nothing.
 */
const STUBBED = new Set([
  "exec",
  "read",
  "write",
  "edit",
  "web_fetch",
  "web_search",
  "browser",
  "browser_mediator",
  "claude_code",
  "md_to_pdf",
  "notify_owner",
  "delegate",
  "trusted_actions",
  "extract_document",
  "ask_user",
]);

const DEFAULT_STUB_RESULT = "(stubbed in the benchmark — assume it succeeded and continue)";

/**
 * What a stubbed tool returns for a given call.
 *
 * A bare string answers every call the same way, which is all a scenario needs
 * when the tool is scenery. A list of rules answers *this* call — and that is
 * what makes a witness test possible: a tool that emits the secret only when
 * handed the right input turns "did the agent combine the two keys correctly"
 * from a judgement into an observation.
 *
 *     toolResults:
 *       decode:
 *         - when: { code: "{{token:alpha}}{{token:beta}}" }
 *           then: "{{token:secret}}"
 *         - then: "no such code"          # no `when` — the fallback
 *
 * First matching rule wins, so order is the priority. A list with no matching
 * rule and no fallback returns the default stub text.
 */
function stubResult(tool: string, args: Record<string, unknown>, results: ToolResults): string {
  const rule = results[tool];
  if (rule === undefined) return DEFAULT_STUB_RESULT;
  if (typeof rule === "string") return rule;
  for (const candidate of rule) {
    if (!candidate.when) return candidate.then;
    if (Object.entries(candidate.when).every(([key, want]) => matchesStubArg(args[key], want))) return candidate.then;
  }
  return DEFAULT_STUB_RESULT;
}

/** Same matching a `tool_args` assertion uses, so a rule and a check agree on what "matches" means. */
function matchesStubArg(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === "string" && expected.startsWith("/") && expected.lastIndexOf("/") > 0) {
    const end = expected.lastIndexOf("/");
    return new RegExp(expected.slice(1, end), expected.slice(end + 1) || "i").test(String(actual ?? ""));
  }
  if (typeof actual === "string" && typeof expected === "string")
    return actual.toLowerCase() === expected.toLowerCase();
  return actual === expected;
}

/**
 * Wrap every tool so the run records what actually ran, and stub the ones that
 * reach outside this process.
 *
 * Two things the provider-level record cannot say, both of which have already
 * cost a wrong conclusion:
 *
 *   - **Who called it.** The recorder is shared across a room's agents, so a
 *     multi-agent scenario could assert that *somebody* called a tool and never
 *     that the right agent did.
 *   - **Whether it ran.** Provider records are what the model *asked* for. A
 *     call the loop refuses — the derivability gate declining an ambiguous
 *     delete — looks identical to one that executed, and a scenario asserting
 *     the delete did not happen failed a run where it was correctly blocked.
 *
 * Spread, then override: the previous version listed the fields it kept and so
 * silently dropped every declarative property added afterwards. `Tool.effect`
 * was the first, which made every stubbed tool read as harmless and meant the
 * derivability gate could not fire in the benchmark at all.
 */
function instrument(tool: Tool, recorder: Recorder, results: ToolResults): Tool {
  const stubbed = STUBBED.has(tool.name);
  return {
    ...tool,
    async execute(args, context) {
      recorder.executions.push({ name: tool.name, args, agent: context.agentName });
      if (!stubbed) return tool.execute(args, context);
      return { success: true, output: stubResult(tool.name, args, results) };
    },
  };
}

/**
 * Every request and every response, captured on the way past — and the only
 * thing standing between one wedged call and a benchmark that never ends.
 *
 * Core's OpenAI-compatible provider sets no request timeout, which is the right
 * default for an agent a person is watching and the wrong one for a batch of a
 * hundred and thirty turns. The race only abandons the call, it does not cancel
 * it; the worker exits after writing its result, which is what actually frees
 * the socket.
 */
class Recorder {
  readonly requests: RecordedRequest[] = [];
  readonly calls: RecordedCall[] = [];
  /** Calls that ran, attributed to the agent whose turn ran them. */
  readonly executions: RecordedExecution[] = [];
  /**
   * Provider calls that threw.
   *
   * Tracked because the room path swallows them: `runTurn` catches a failed
   * `runAgentLoop`, logs, advances the cursor and returns — deliberately, so one
   * unprocessable message cannot burn a room's whole hourly wake budget. The
   * harness therefore sees a turn that "completed" with no reply.
   *
   * Left ungraded, that made a benchmark pointed at a dead endpoint score 100%:
   * the request was assembled and recorded before the call failed, so every
   * `prompt_*` assertion passed and nothing noticed the model never answered.
   * Caught by a control run against a server that accepts and never replies.
   */
  readonly failures: string[] = [];
  responses = 0;
  /** Calls that only succeeded after a retry. Counted so throttling is visible, not silent. */
  retries = 0;
  usage: RunUsage = { input: 0, output: 0 };

  wrap(provider: AIProvider, timeoutMs: number, maxAttempts = 5): AIProvider {
    const recorder = this;
    return {
      id: provider.id,
      name: provider.name,
      supportsTools: provider.supportsTools,
      async chat(params: ChatParams): Promise<ChatResponse> {
        // Recorded once, outside the retry loop: the request is the same each
        // attempt, and counting it twice would make `prompt_occurrences` lie.
        recorder.requests.push(describeRequest(params));
        let last: Error | undefined;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const response = await Promise.race([
              provider.chat(params),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`model call exceeded ${timeoutMs}ms`)), timeoutMs);
              }),
            ]);
            recorder.responses++;
            if (attempt > 1) recorder.retries++;
            recorder.usage.input += response.usage.input;
            recorder.usage.output += response.usage.output;
            // Only recorded when the provider reports it. vLLM returns
            // `prompt_tokens_details: null`, and a 0 there would read as "the
            // cache is not working" rather than "nobody said".
            if (response.usage.cacheRead !== undefined) {
              recorder.usage.cacheRead = (recorder.usage.cacheRead ?? 0) + response.usage.cacheRead;
            }
            if (response.usage.cacheWrite !== undefined) {
              recorder.usage.cacheWrite = (recorder.usage.cacheWrite ?? 0) + response.usage.cacheWrite;
            }
            for (const call of response.toolCalls ?? []) {
              recorder.calls.push({ name: call.name, args: call.arguments ?? {} });
            }
            return response;
          } catch (err) {
            last = err as Error;
            const wait = retryDelayMs(last, attempt);
            if (wait === null || attempt === maxAttempts) break;
            await new Promise((r) => setTimeout(r, wait));
          } finally {
            if (timer) clearTimeout(timer);
          }
        }

        recorder.failures.push((last as Error).message);
        throw last;
      },
      listModels: provider.listModels?.bind(provider),
    };
  }
}

/**
 * How long to wait before trying this call again, or null if it should not be.
 *
 * Throttling is an infrastructure condition, not a property of the invocation
 * message, so a benchmark that scores it as a failure measures the wrong thing.
 * The first hosted run hit a 200k-tokens-per-minute org cap and lost 51 of 132
 * runs to HTTP 429 — a 58% score that said nothing about the code.
 *
 * Retried rather than hidden: `retries` is counted and surfaced, because a run
 * that needed forty retries to finish is worth knowing about even when it did
 * finish. Only throttling and transient server errors qualify — a 400 is a real
 * defect and must fail loudly on the first attempt.
 */
export function retryDelayMs(err: Error, attempt: number): number | null {
  const message = err.message ?? "";
  const throttled = /\b429\b|rate.?limit|too many requests/i.test(message);
  const transient = /\b(500|502|503|504)\b|overloaded/i.test(message);
  if (!throttled && !transient) return null;

  // Providers that say how long to wait are usually right; the backoff is the
  // floor, so a "try again in 124ms" does not turn into a 124ms hot loop.
  const suggested = /try again in (\d+(?:\.\d+)?)(ms|s)\b/i.exec(message);
  const hinted = suggested ? Number(suggested[1]) * (suggested[2].toLowerCase() === "s" ? 1000 : 1) : 0;
  return Math.max(hinted, 500 * 2 ** (attempt - 1));
}

/**
 * Did this turn get an answer at all?
 *
 * Not "did any call fail" — the loop legitimately recovers from one, and a
 * recovered turn is a passing turn. "Nothing came back at all" is the state
 * where a green score would be a lie, and it is reachable without an exception
 * escaping, because the room path catches a failed turn on purpose.
 */
export function turnFailed(responses: number, failures: string[]): { error: string } | undefined {
  if (responses > 0 || failures.length === 0) return undefined;
  return { error: `no model response: ${failures[0]}` };
}

/** ~4 chars per token. Same rough estimator core budgets with, and good enough to catch bloat. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * `system` and `messages` partition the request — they do not overlap.
 *
 * They did at first, and the first benchmark run reported the persona appearing
 * twice in a request that contained it once. An occurrence count over a
 * representation that double-counts is a benchmark measuring itself.
 */
export function describeRequest(params: ChatParams): RecordedRequest {
  const system = params.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n");
  const messages = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content ?? "" }));
  const toolText = JSON.stringify(params.tools ?? []);
  const body = [system, ...messages.map((m) => m.content)].join("\n");
  const toolNames = (params.tools ?? []).map((t) => t.function.name);
  return {
    system,
    messages,
    toolNames,
    estimatedTokens: estimateTokens(body) + estimateTokens(toolText),
    // A call with no tools is the runtime working on the agent's behalf, not a
    // turn the agent took — see `RecordedRequest.auxiliary`.
    ...(toolNames.length ? {} : { auxiliary: true }),
  };
}

/**
 * The invocation message: the first request the agent was actually asked to act
 * on, skipping anything the runtime did on its behalf.
 *
 * `requests[0]` was this until history summarisation became the default, at
 * which point the summariser's call landed in front of it on every scenario
 * that trims — and every `prompt_*` assertion on those scenarios quietly
 * changed what it was describing.
 */
export function invocationRequest(requests: RecordedRequest[]): RecordedRequest | undefined {
  return requests.find((r) => !r.auxiliary) ?? requests[0];
}

/** Turns the agent took. Excludes the runtime's own calls, which are not rounds. */
export function agentRounds(requests: RecordedRequest[]): number {
  return requests.filter((r) => !r.auxiliary).length;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

export function buildConfig(scenario: Scenario, opts: HarnessOptions): Record<string, unknown> {
  const agentName = scenario.agent?.name ?? "bench";
  const providerId = opts.providerId ?? "openai_compatible";
  const agent: Record<string, unknown> = {
    description: scenario.agent?.description ?? "Benchmark agent.",
    ...(scenario.agent?.instructions ? { instructions: scenario.agent.instructions } : {}),
    ...(scenario.agent?.tools ? { tools: scenario.agent.tools } : {}),
    ...(scenario.agent?.extra ?? {}),
  };

  const config: Record<string, unknown> = {
    server: { port: 3999, host: "127.0.0.1" },
    database: { path: "./agent.db" },
    providers: {
      [providerId]: {
        // A plugin provider talks to its vendor's own endpoint and rejects a
        // baseUrl it did not expect, so only pass one when it was asked for.
        ...(providerId === "openai_compatible" || opts.baseUrl !== DEFAULT_BASE_URL ? { baseUrl: opts.baseUrl } : {}),
        defaultModel: opts.model,
        apiKey: opts.apiKey,
        ...(opts.thinkingDialect ? { thinkingDialect: opts.thinkingDialect } : {}),
        ...(opts.thinking ? { thinking: opts.thinking } : {}),
      },
    },
    agent: {
      defaultProvider: providerId,
      extraInstructions: "",
      temperature: opts.temperature,
      ...(opts.maxTokens === null ? {} : { maxTokens: opts.maxTokens }),
      maxToolRounds: opts.maxToolRounds,
      maxHistoryTokens: 110000,
      providerExtra: {
        ...opts.providerExtra,
        ...(opts.seed !== null ? { seed: opts.seed } : {}),
      },
    },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    // A realistic tool surface: selection pressure is part of what is being
    // measured, so an agent that sees four tools here and forty in production
    // proves nothing. Side effects are handled by stubbing, not by disabling.
    tools: {
      memory: { enabled: true },
      exec: { enabled: true },
      read: { enabled: true },
      write: { enabled: true },
      web_fetch: { enabled: true },
      web_search: { enabled: true },
      tasks: { enabled: true },
      facts: { enabled: true },
      recall: { enabled: true },
      projects: { enabled: true },
      documents: { enabled: true },
      extract_document: { enabled: true },
    },
    custom_tools: {},
    commands: {},
    cron: { enabled: false, jobs: [] },
    webhooks: { enabled: false, routes: [] },
    schedules: { enabled: true },
    rooms: {
      enabled: true,
      ownerLabel: OWNER_LABEL,
      identities: { [OWNER_LABEL]: OWNER_ID },
      maxWakesPerHour: 1000,
      maxAgentTurns: 100,
    },
    agents: { [agentName]: agent },
  };

  return deepMerge(config, scenario.config ?? {});
}

/**
 * Scenario config over harness config, where `null` **removes** a key.
 *
 * The removal case is how a scenario tests a code default. The harness writes a
 * value for everything it cares about — `maxHistoryTokens: 110000`, so the long
 * session scenarios have room — which means a scenario can otherwise only ever
 * exercise a number it wrote down itself. `default-history-budget-keeps-the-conversation`
 * did exactly that, pinning `2000` and calling it "the default": the day the
 * default moved, the scenario would have gone on measuring the old one and
 * reporting it as current.
 *
 * `null` drops the key so `loadConfig` supplies `DEFAULT_CONFIG`'s value, which
 * is the only way the assertion tracks the code instead of restating it.
 */
function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) out[key] = deepMerge(existing, value);
    else out[key] = value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A room scenario's lines name identities; every one of them must be declared. */
function collectSpeakers(scenario: Scenario): string[] {
  const speakers = new Set<string>();
  for (const room of scenario.rooms ?? []) {
    for (const line of [...(room.seen ?? []), ...(room.incoming ?? [])]) speakers.add(line.speaker);
  }
  return [...speakers];
}

export async function runOnce(scenario: Scenario, opts: HarnessOptions): Promise<RunOutcome> {
  const home = mkdtempSync(join(tmpdir(), "tai-eval-"));
  const previousHome = process.env.TAI_HOME;
  process.env.TAI_HOME = home;

  const started = Date.now();
  const recorder = new Recorder();
  let db: import("better-sqlite3").Database | undefined;
  let roomsRegistered = false;

  try {
    const agentName = scenario.agent?.name ?? "bench";
    const configObject = buildConfig(scenario, opts);

    // Every speaker a room line uses has to resolve, or the wake policy reads
    // an unknown label as a person and the transcript loses attribution.
    const rooms = (configObject.rooms ?? {}) as Record<string, unknown>;
    const identities = { ...((rooms.identities ?? {}) as Record<string, unknown>) };
    const declaredAgents = Object.keys((configObject.agents ?? {}) as Record<string, unknown>);
    for (const speaker of collectSpeakers(scenario)) {
      // Agents resolve through `agents:` on their own and must not be given a
      // human id here — the wake policy branches on `kind`, so mislabelling one
      // agent as a person changes which messages wake anybody.
      if (identities[speaker] || declaredAgents.includes(speaker)) continue;
      identities[speaker] = `person-${speaker}`;
    }
    rooms.identities = identities;
    configObject.rooms = rooms;

    // A clock the run controls, so "tomorrow 9am" and "every monday at 8:30"
    // mean the same thing on every run rather than depending on the calendar.
    // Registered before `loadConfig`, for the same reason plugin providers are:
    // `time.provider` names a factory that has to already exist.
    const timeBlock = timeConfigBlock({ pinnedAt: opts.pinnedAt, timeZone: opts.timeZone });
    if (timeBlock) {
      registerPinnedClock();
      configObject.time = timeBlock;
    }

    // Before loadConfig: a plugin registers its provider factory on import, and
    // `validateConfig` rejects a `providers.<id>` block whose factory is not
    // registered yet.
    if (opts.plugins?.length) {
      const loaded = await loadPlugins({ plugins: opts.plugins } as never, (name) => import(name), {
        context: createPluginContext({}),
      });
      const failed = loaded.filter((l) => !l.ok);
      if (failed.length)
        throw new Error(`plugin load failed: ${failed.map((f) => `${f.module} (${f.error})`).join(", ")}`);
    }

    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, YAML.stringify(configObject));
    const config = loadConfig(configPath);

    db = initDatabase(join(home, "agent.db"));
    const contextDir = join(home, "data", "context");
    const kbDir = join(home, "data", "kb");
    for (const dir of [contextDir, join(contextDir, "global"), kbDir, join(kbDir, "global")]) {
      mkdirSync(dir, { recursive: true });
    }

    const toolFactory = (
      cfg: Parameters<typeof createTools>[0],
      ctxDir: string,
      cfgPath?: string,
      runtimeOpts?: Record<string, unknown>,
    ) => createTools(cfg, ctxDir, cfgPath, runtimeOpts).map((t) => instrument(t, recorder, scenario.toolResults ?? {}));

    const providerFactory = (cfg: Parameters<typeof createProvider>[0], providerId?: string) => {
      const built = createProvider(cfg, providerId);
      return { provider: recorder.wrap(built.provider, opts.timeoutMs), model: built.model };
    };

    const runtime = new AgentRuntime(
      {
        configPath,
        db,
        contextDir,
        kbDir,
        createTools: toolFactory,
        createProvider: providerFactory,
        createEmbedder,
        events: new TypedEventBus(),
      },
      (path) => loadConfig(path),
      config,
    );
    runtime.setMetaTools(
      createMetaTools(runtime, contextDir, kbDir).map((t) => instrument(t, recorder, scenario.toolResults ?? {})),
    );

    const outcome = scenario.rooms?.length
      ? await runRoomScenario(scenario, runtime, db, agentName, opts)
      : await runChatScenario(scenario, runtime, db, agentName, opts);
    roomsRegistered = !!scenario.rooms?.length;

    return {
      ...outcome,
      calls: recorder.calls,
      executions: recorder.executions,
      requests: recorder.requests,
      usage: recorder.usage,
      latencyMs: Date.now() - started,
      providerErrors: recorder.failures,
      retries: recorder.retries,
      ...(turnFailed(recorder.responses, recorder.failures) ?? {}),
    };
  } catch (err) {
    return {
      reply: "",
      calls: recorder.calls,
      executions: recorder.executions,
      posts: [],
      requests: recorder.requests,
      usage: recorder.usage,
      latencyMs: Date.now() - started,
      providerErrors: recorder.failures,
      error: (err as Error).message,
    };
  } finally {
    // The room backend registry is a module singleton keyed by backend id, so a
    // stale `local` backend would point the next run at a closed database. The
    // runner also isolates scenarios in separate processes; this keeps a single
    // process honest if that ever changes.
    if (roomsRegistered) unregisterRoomBackend("local");
    db?.close();
    if (previousHome === undefined) delete process.env.TAI_HOME;
    else process.env.TAI_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function runChatScenario(
  scenario: Scenario,
  runtime: AgentRuntime,
  db: import("better-sqlite3").Database,
  agentName: string,
  opts: HarnessOptions,
): Promise<Pick<RunOutcome, "reply" | "posts" | "stop">> {
  const session = newSession(db, opts.model, opts.providerId ?? "openai_compatible", `eval:${randomUUID()}`);
  for (const line of scenario.history ?? []) {
    saveMessage(db, session.id, { role: line.role, content: line.content });
  }

  const base = runtime.buildLoopOptions({ session, agentName });
  // Why the turn ended, taken structurally rather than read off the reply.
  //
  // A stalled turn used to be identifiable by its `[Agent stopped: …]` text, and
  // graders that looked for it are now wrong twice over: the marker is still
  // non-empty (so `replies: true` accepted it) and, since a turn that runs out
  // of rounds gets a tools-withheld retry, most stalls come back as ordinary
  // prose with no marker at all. `loop.ts` says as much and points callers at
  // the structured stop.
  let stop: LoopStop | undefined;
  const reply = await runAgentLoop(scenario.message ?? "", {
    ...base,
    onStop: (s) => {
      stop = s;
    },
  });
  return { reply, posts: [], stop };
}

/**
 * The turns a scenario runs, normalised.
 *
 * A bare object and a one-entry list mean the same thing; `agent` defaults to
 * the agent under test so a single-agent scenario never names it. With no
 * `wake:` at all, the last room carrying `incoming:` lines is the one that woke
 * somebody — the rule the schema already enforces.
 */
function wakeSteps(scenario: Scenario, agentName: string): Array<{ room: string; agent: string; kind?: string }> {
  const declared = scenario.wake ? (Array.isArray(scenario.wake) ? scenario.wake : [scenario.wake]) : [];
  if (declared.length) {
    return declared.map((step) => ({ room: step.room, agent: step.agent ?? agentName, kind: step.kind }));
  }
  const fallback = [...(scenario.rooms ?? [])].reverse().find((r) => r.incoming?.length)?.name;
  return fallback ? [{ room: fallback, agent: agentName }] : [];
}

/** Every agent that takes a turn, in order, without duplicates. */
function wakeAgents(scenario: Scenario, agentName: string): string[] {
  return [...new Set(wakeSteps(scenario, agentName).map((s) => s.agent))];
}

async function runRoomScenario(
  scenario: Scenario,
  runtime: AgentRuntime,
  db: import("better-sqlite3").Database,
  agentName: string,
  opts: HarnessOptions,
): Promise<Pick<RunOutcome, "reply" | "posts">> {
  const store = runtime.getRoomStore();
  const backend = new LocalRoomBackend(db, store);

  const refs = new Map<string, string>();
  for (const spec of scenario.rooms ?? []) {
    // createRoom already persists through the store, so there is nothing to
    // upsert afterwards — doing it again would just rewrite the same row.
    const room = await backend.createRoom({ name: spec.name, purpose: spec.purpose });
    const ref = formatRoomRef(room.ref);
    refs.set(spec.name, ref);
    // Every agent that takes a turn is subscribed to every room. Subscription
    // follows participation rather than declaration: an agent named only in
    // `config.agents` is scenery — it exists so the transcript can show a third
    // party — and subscribing it would put it in the roster of a room it never
    // speaks in, changing the prompt of every scenario that has one.
    for (const agent of wakeAgents(scenario, agentName)) {
      store.subscribe({
        agent,
        roomRef: ref,
        deliver: spec.deliver ?? "poll",
        wakeOn: spec.wakeOn ?? "all",
        checkInMinutes: spec.checkInMinutes ?? null,
        role: spec.role ?? null,
      });
    }
  }

  // Seen lines first, then the cursor jumps past them: this is a room the agent
  // is already mid-conversation in, not one it is meeting for the first time.
  for (const spec of scenario.rooms ?? []) {
    const ref = refs.get(spec.name) as string;
    let last: string | undefined;
    for (const line of spec.seen ?? []) last = await postLine(backend, room_id(ref), line);
    if (last) store.advanceCursor(agentName, ref, last);
  }

  for (const spec of scenario.rooms ?? []) {
    for (const line of spec.incoming ?? []) await postLine(backend, room_id(refs.get(spec.name) as string), line);
  }

  // Taken after ALL seeding and before the turn: from here on nothing but the
  // agent writes to this table, so a row id above the watermark is its work by
  // construction. An earlier version watermarked before the incoming lines and
  // filtered them back out by matching their bodies — which silently stopped
  // matching the moment the stored form gained an `@addressee`, and reported
  // the questions as the agent's own posts.
  const watermark = (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM room_messages").get() as { id: number }).id;

  const steps = wakeSteps(scenario, agentName);
  if (!steps.length) throw new Error("no room to wake in");
  // The first step owns the session seeding below: `history:` is the agent
  // under test's own prior turns, and there is one session per (room, agent).
  const wakeRef = refs.get(steps[0].room);
  if (!wakeRef) throw new Error(`unknown wake room "${steps[0].room}"`);

  // The agent's own prior turns in this room.
  //
  // Room lines and session history are two different things, and conflating
  // them produced a scenario that tested nothing: `seen:` lines advance the
  // cursor, so by design they are absent from the next wake prompt — the whole
  // point of reading from a cursor. In production what carries the earlier
  // conversation forward is the agent's SESSION, written by the previous turn.
  // Seeding the room here under the key `runTurn` will compute is the only way
  // to reproduce a room the agent is genuinely mid-conversation in.
  if (scenario.history?.length) {
    const session = findOrCreateSession(
      db,
      makeRoomSessionKey(wakeRef, agentName),
      opts.model,
      opts.providerId ?? "openai_compatible",
    );
    for (const line of scenario.history) saveMessage(db, session.id, { role: line.role, content: line.content });
  }

  // Turns run in order, against the same rooms, so a later agent wakes on what
  // an earlier one posted. That is the whole point: one agent answering once
  // cannot produce a cascade, a silence where everybody deferred, or a handoff.
  const watcher = new RoomWatcher({ runtime, store });
  const replies: Array<{ agent: string; reply: string }> = [];
  try {
    for (const step of steps) {
      const ref = refs.get(step.room);
      if (!ref) throw new Error(`unknown wake room "${step.room}"`);
      const reply =
        step.kind === "checkin" ? await watcher.runCheckIn(step.agent, ref) : await watcher.pollOnce(step.agent, ref);
      replies.push({ agent: step.agent, reply: typeof reply === "string" ? reply : "" });
    }
  } finally {
    watcher.stop();
  }

  const byRef = new Map([...refs].map(([name, ref]) => [ref, name]));
  const rows = db
    .prepare("SELECT room_ref, content FROM room_messages WHERE id > ? ORDER BY id")
    .all(watermark) as Array<{ room_ref: string; content: string }>;

  // Attributed, because with more than one agent taking a turn "who posted this"
  // is the question. The envelope already carries the speaker, so this is free.
  const posts = rows.map((row) => {
    const envelope = parseEnvelope(row.content);
    return {
      room: byRef.get(row.room_ref) ?? row.room_ref,
      body: envelope.body.trim(),
      agent: envelope.speaker,
    };
  });

  // `reply` stays every body joined, so single-agent scenarios and every reply
  // assertion behave exactly as before. A multi-agent scenario that needs to
  // separate them asks about `posts`.
  return { reply: posts.map((p) => p.body).join("\n"), posts };
}

/** `local:<id>` → `<id>`, which is what the backend's own methods take. */
function room_id(ref: string): string {
  return ref.startsWith("local:") ? ref.slice("local:".length) : ref;
}

async function postLine(backend: LocalRoomBackend, roomId: string, line: RoomLine): Promise<string | undefined> {
  const posted = await backend.post(roomId, { speaker: line.speaker, to: line.to ?? [], body: line.body });
  return posted?.cursor;
}
