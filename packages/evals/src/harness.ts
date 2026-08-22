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
  isStallStop,
  LocalRoomBackend,
  type LoopStop,
  loadConfig,
  loadPlugins,
  makeRoomSessionKey,
  messageText,
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
import { answerTool, Oracle } from "./oracle.js";
import { createSimulation, type Simulation } from "./sim/index.js";
import { finishSimulationTrace, looksRefused, type TraceSink } from "./trace.js";
import type {
  RecordedCall,
  RecordedExecution,
  RecordedRequest,
  RoomLine,
  RunOutcome,
  RunUsage,
  Scenario,
  ScenarioTool,
  ToolResults,
  WakeRounds,
  WakeStep,
} from "./types.js";
import { World } from "./world.js";

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
   * This model has eyes, and tool-returned media should reach them.
   *
   * A flag rather than a probe, for the reason core's own capability doc gives:
   * an OpenAI-compatible endpoint serves whatever was last loaded under a name
   * nothing can introspect, so the operator is the only party who knows. It is
   * also not free to be wrong in either direction — undeclared, core leaves
   * `toolResultMedia` at `"unknown"` and sends the image inline on a
   * `role: "tool"` message, which the OpenAI Chat Completions shape does not
   * accept, so a vision model would fail every request that carried a picture.
   *
   * Setting it declares the documented shape for that API: images accepted as
   * bytes, and tool-result media relayed as a **follow-up user turn**.
   */
  vision?: boolean;
  /**
   * The deployment's context window, in tokens.
   *
   * Recorded, never enforced: nothing here reads it to decide anything. It is
   * on the harness because it is a property of what is being benchmarked and
   * there is nowhere else to learn it — an OpenAI-compatible `/v1/models` does
   * not report it, and a served model's real window is a launch flag on the
   * server rather than anything visible over the wire. So the operator says,
   * and the run writes it down next to the result.
   */
  contextTokens?: number;
  /**
   * The commit and the framework version this run exercises.
   *
   * Supplied by the CLI, which already computes both for the report, so a
   * simulation recording provenance and the report describing the same run
   * cannot disagree about which code produced it.
   */
  gitSha?: string;
  taiVersion?: string;
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
  /**
   * Where to send events as the run happens, when anybody is watching.
   *
   * The harness emits and does not write: it has no business knowing whether
   * there is a viewer or where its output goes, which is the same argument that
   * moved the clock's announcement out of here and into the simulation. The
   * worker points this at a file; `eval watch` reads the file.
   */
  trace?: TraceSink;
}

const OWNER_ID = "owner-0000";
const OWNER_LABEL = "quinton";

/**
 * Who says what time it is on a simulation run. Not an agent, and not scored.
 *
 * Named for the job rather than for the first world that had one: `plant-clock`
 * was a sensible speaker in a factory and a strange one in a canal lock, and
 * the agents read this name.
 */
const DAY_MARKER = "clock";

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
function instrument(tool: Tool, recorder: Recorder, results: ToolResults, world?: World, alwaysStub = false): Tool {
  const stubbed = alwaysStub || STUBBED.has(tool.name);
  return {
    ...tool,
    async execute(args, context) {
      // Pushed before the call and mutated after, so an execution that throws is
      // still on the record — a tool that blew up is the most useful line in a
      // trace and the easiest one to lose.
      const record: RecordedExecution = { name: tool.name, args, agent: context.agentName, turn: recorder.turn };
      recorder.executions.push(record);
      if (!stubbed) {
        const real = await tool.execute(args, context);
        record.result = describeResult(real);
        recorder.trace?.({
          kind: "call",
          at: Date.now(),
          turn: recorder.turn,
          ...(context.agentName ? { agent: context.agentName } : {}),
          tool: tool.name,
          args,
          result: record.result,
          refused: looksRefused(record.result),
        });
        return real;
      }
      // The world first, static stubs second. A scenario usually has a handful
      // of calls that move the machinery and a larger number that only report
      // things, and making them compose means a puzzle can still have ordinary
      // furniture in it. `null` is "no rule claimed this call", which is why the
      // world returns that rather than a default of its own.
      const moved = world?.resolve(tool.name, args, context.agentName, recorder.turn);
      const output = moved !== null && moved !== undefined ? moved : stubResult(tool.name, args, results);
      record.result = describeResult({ success: true, output });
      recorder.trace?.({
        kind: "call",
        at: Date.now(),
        turn: recorder.turn,
        ...(context.agentName ? { agent: context.agentName } : {}),
        tool: tool.name,
        args,
        result: record.result,
        refused: looksRefused(record.result),
      });
      return { success: true, output };
    },
  };
}

/** What the tool said, capped. Long enough for a witness, short enough for a report. */
const RESULT_CHARS = 600;

function describeResult(result: { success?: boolean; output?: unknown; error?: unknown }): string {
  const body = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? result.error ?? "");
  return body.length <= RESULT_CHARS ? body : `${body.slice(0, RESULT_CHARS)}…`;
}

/**
 * Instruments that exist only in this scenario.
 *
 * Built to look exactly like a real tool, because the model cannot tell and
 * should not have to: same name shape, same one-line description, same JSON
 * schema. There is no implementation — the world or `toolResults` answers every
 * call, which is why they go through `instrument` with the stub forced on.
 *
 * `effect` defaults to `write` rather than `read`: these are levers, and a
 * scenario that wants the derivability gate involved says `irreversible`.
 */
export function buildScenarioTools(specs: readonly ScenarioTool[]): Tool[] {
  return specs.map((spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(spec.params ?? {}).map(([name, description]) => [name, { type: "string", description }]),
      ),
      required: spec.required ?? Object.keys(spec.params ?? {}),
    },
    effect: spec.effect ?? "write",
    async execute() {
      // Never reached: `instrument` stubs this tool unconditionally. Present
      // because `Tool` requires it, and returning a recognisable string beats
      // throwing if the wrapping is ever bypassed.
      return { success: true, output: DEFAULT_STUB_RESULT };
    },
  }));
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
  /**
   * Where to send events as they happen, when anybody is watching.
   *
   * On the recorder rather than threaded through every call site because the
   * recorder is already the one object that sees every execution and knows
   * which turn is running — the two things a live view is made of.
   */
  trace?: TraceSink;
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
  /**
   * Which wake step is running, stamped onto every execution.
   *
   * The only clock this harness has. Executions and posts were two unordered
   * lists, so "did Boron act on what Atlas said, or before it" — the question a
   * multi-agent run is entirely about — could not be asked at all.
   */
  turn = 0;
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
    .map((m) => messageText(m.content))
    .join("\n");
  const messages = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: messageText(m.content) }));
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

/**
 * Which tools each agent gets from the simulation, by role.
 *
 * The scenario names roles and the simulation owns what each role can touch, so
 * neither one has to restate the other. A hand-written allowlist per agent would
 * work exactly once: the day somebody adds a tool to the sales role, every
 * scenario silently keeps the old list, six specialists quietly become six
 * generalists, and the split that the whole benchmark rests on is gone with
 * nothing red to show for it.
 */
export function simulationGrants(sim: Simulation, roles: Record<string, string>): Record<string, string[]> {
  const perRole = sim.tools();

  // Two roles exporting the same tool name is a silent measurement bug rather
  // than a style question, and it is invisible from inside a simulation: the
  // harness flattens every role's tools into one registry and each agent's
  // allowlist selects by *name*, so the roles do not get one implementation
  // each — they all get whichever was built last. `the-lock` shipped six roles
  // with a `raise_paddle` apiece, every agent was handed the upper chamber's
  // one, and the run that found it took sixty-seven minutes and read as a team
  // hallucinating its own capabilities. It was reporting exactly what it was
  // told.
  //
  // A tool whose behaviour depends on who called it belongs in `sharedTools()`,
  // where `agentTool` can read `context.agentName`.
  const owner = new Map<string, string>();
  for (const [role, tools] of Object.entries(perRole)) {
    for (const t of tools) {
      const first = owner.get(t.name);
      if (first !== undefined) {
        throw new Error(
          `simulation "${sim.name}" gives both "${first}" and "${role}" a tool called "${t.name}". ` +
            "Tools are registered by name, so one of those implementations would serve both agents. " +
            "Give them different names, or move it to sharedTools() and read the caller from context.agentName.",
        );
      }
      owner.set(t.name, role);
    }
  }

  const shared = sim.sharedTools().map((t) => t.name);
  const grants: Record<string, string[]> = {};
  for (const [role, agent] of Object.entries(roles)) {
    const own = perRole[role];
    if (!own) {
      throw new Error(
        `simulation "${sim.name}" has no role "${role}". Known roles: ${Object.keys(perRole).join(", ")}`,
      );
    }
    grants[agent] = [...new Set([...(grants[agent] ?? []), ...own.map((t) => t.name), ...shared])];
  }
  return grants;
}

/**
 * What the simulation wants said to one role, if anything.
 *
 * The only durable channel a simulation has to an agent. Everything else it
 * says arrives as a tool result — which a model reads as *what happened*, not
 * as *what it wants* — and that asymmetry is not a matter of wording. See the
 * call site.
 */
function brief(sim: Simulation, role: string | undefined): string | undefined {
  return role ? sim.briefFor?.(role) : undefined;
}

export function buildConfig(scenario: Scenario, opts: HarnessOptions, sim?: Simulation): Record<string, unknown> {
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
      /*
       * A one-rung chain, declared only to hang `capabilities` on it.
       *
       * `ModelEntry.capabilities` is the only place config can state what a
       * model accepts, and an entry needs a chain to live in. One rung naming
       * the same provider and model the run already uses is what an unset
       * `models` builds implicitly, so this changes nothing about routing:
       * every other field is left unset and inherits, exactly as it did.
       */
      ...(opts.vision
        ? {
            models: [
              {
                provider: providerId,
                model: opts.model,
                capabilities: {
                  input: ["text/*", "image/*"],
                  inputBytes: { supported: true },
                  toolResultMedia: { supported: true, mode: "follow-up" },
                },
              },
            ],
          }
        : {}),
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

  const merged = deepMerge(config, scenario.config ?? {});

  if (sim && scenario.simulation) {
    const agents = (merged.agents ?? {}) as Record<string, Record<string, unknown>>;

    /*
     * agent → role, which is the direction nothing had.
     *
     * `simulation.roles` is written role-first (`{ mage: "mage" }`) because
     * that is how a scenario casts its parts, and every scenario so far has
     * named its agents after its roles — so indexing it *by agent* returned the
     * right answer by coincidence. `the-workshop-alone` is the first row where
     * they differ (five roles, one agent called `maker`), and there the lookup
     * silently returned undefined and the agent ran with no brief at all: the
     * one arm that most needed the task description was the one that did not
     * get it, and nothing was red.
     *
     * First role wins when several map to one agent. That agent is playing all
     * of them, and a simulation that cares says so itself — the workshop, for
     * instance, describes every file as yours when ownership is shared.
     */
    const roleOf = new Map<string, string>();
    for (const [role, agent] of Object.entries(scenario.simulation.roles)) {
      if (!roleOf.has(agent)) roleOf.set(agent, role);
    }

    for (const [agent, granted] of Object.entries(simulationGrants(sim, scenario.simulation.roles))) {
      const block = agents[agent];
      if (!block) {
        throw new Error(
          `simulation roles name the agent "${agent}", which this scenario does not declare ` +
            `[${Object.keys(agents).join(", ")}] — it would run with no instructions and no instruments`,
        );
      }
      const declared = Array.isArray(block.tools) ? (block.tools as string[]) : [];

      /*
       * A fresh object, never a write through to the scenario's own.
       *
       * `deepMerge` copies a key it does not already hold by reference, so
       * `merged.agents.mage` *is* `scenario.config.agents.mage`. Mutating it
       * edits the loaded scenario for every later caller in the process. The
       * tools line got away with that because rebuilding a set from a superset
       * is idempotent; appending text is not, so a scenario built twice —
       * `--repeats 3`, or two variants in one test file — would accumulate the
       * brief once per build.
       */
      agents[agent] = {
        ...block,
        // `room` is added rather than assumed. An agent given an allowlist that
        // omits it cannot post, so it would take its turn, read everything, act
        // on nothing anybody else could see, and look like an agent with
        // nothing to say — which is the single most misleading way for a
        // coordination scenario to fail.
        tools: [...new Set([...declared, ...granted, "room"])],
        // Anything the simulation decided about this agent that the scenario
        // could not know when it was written — a role drawn at construction, a
        // brief chosen by `--sim-option`. Appended rather than replacing,
        // because the scenario's own description of the job is still true.
        //
        // It has to live in the instructions rather than in a tool result, and
        // that is measured rather than assumed: on `the-descent-betrayed`, seed
        // 610357, a traitor's objective was delivered thirteen times as the
        // first line of its own tool output, correctly scoped to one agent, and
        // across nineteen rounds its private reasoning referenced the role zero
        // times while it played a textbook loyal cleric. One line of transient
        // data against a persistent instruction is not a fair fight.
        ...(brief(sim, roleOf.get(agent))
          ? {
              instructions: `${String(block.instructions ?? "").trim()}\n\n${brief(sim, roleOf.get(agent))}`.trim(),
            }
          : {}),
      };
    }
  }

  return merged;
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
  recorder.trace = opts.trace;
  const emit = opts.trace ?? (() => {});
  // Built once per run, so every agent in a multi-agent scenario drives the same
  // machinery. That is the whole point of a shared world: what one agent unlocks
  // is unlocked for the next one, and two agents doing the same step is visible
  // as a repeat rather than as two independent successes.
  const world = scenario.world ? new World(scenario.world) : undefined;
  emit({
    kind: "run",
    at: Date.now(),
    scenario: scenario.id,
    ...(scenario.intent ? { intent: scenario.intent } : {}),
    model: opts.model,
    agents: [...new Set(wakeSteps(scenario, scenario.agent?.name ?? "bench").map((step) => step.agent))],
    rooms: (scenario.rooms ?? []).map((room) => room.name),
    ...((scenario.rooms ?? []).length
      ? {
          roomMembers: Object.fromEntries(
            (scenario.rooms ?? []).map((room) => [
              room.name,
              // Same default the subscription loop uses: a room with no declared
              // members holds everybody who takes a turn.
              room.members ?? wakeAgents(scenario, scenario.agent?.name ?? "bench"),
            ]),
          ),
        }
      : {}),
    ...(scenario.simulation ? { roles: scenario.simulation.roles } : {}),
    rounds: Math.max(1, ...wakeSteps(scenario, scenario.agent?.name ?? "bench").map((step) => (step.round ?? 0) + 1)),
    ...(scenario.facts ? { facts: scenario.facts } : {}),
    ...(scenario.milestones ? { milestones: scenario.milestones.map((m) => ({ id: m.id, points: m.points })) } : {}),
  });
  // Same lifetime as the world, and for the same reason: in a multi-agent
  // scenario the attempts are the team's, not each agent's. Three guesses each
  // would make a room of five agents a search rather than a test.
  const oracle = scenario.oracle ? new Oracle(scenario.oracle) : undefined;
  // Same lifetime as the world and for the same reason: one economy, driven by
  // every agent in the scenario. A simulation per agent would be six companies
  // that happen to share a name.
  //
  // Seeded from the run's own seed by default, so repeats of a scenario see
  // different weather — a stochastic run repeated on identical luck measures
  // nothing about variance, which is the thing repeats exist to measure.
  const simSeed = scenario.simulation?.seed ?? opts.seed ?? 0;
  const sim = scenario.simulation
    ? createSimulation(scenario.simulation.name, {
        seed: simSeed,
        ...(scenario.simulation.days === undefined ? {} : { days: scenario.simulation.days }),
        ...(scenario.simulation.options ?? {}),
        /*
         * What is running this. Provenance, never a rule — see `RunContext`.
         *
         * A simulation is otherwise told nothing about the model, which is
         * correct: a world whose behaviour changes with the model is not
         * measuring the model. This is the label on the output rather than an
         * input to the game, and it exists because the workshop publishes its
         * artifact to a site that outlives the run. A board of a hundred games
         * that cannot say which model built which answers nothing.
         *
         * Spread last so it cannot be shadowed by a scenario option, and read
         * defensively by everything downstream — `bench` and `rehearse`
         * construct simulations with no model at all.
         */
        run: {
          scenario: scenario.id,
          model: opts.model,
          provider: opts.providerId ?? "openai_compatible",
          baseUrl: opts.baseUrl,
          gitSha: opts.gitSha ?? "",
          taiVersion: opts.taiVersion ?? "",
          modelMeta: {
            temperature: opts.temperature,
            maxTokens: opts.maxTokens,
            maxToolRounds: opts.maxToolRounds,
            ...(opts.thinking ? { thinking: opts.thinking } : {}),
            ...(opts.thinkingDialect ? { thinkingDialect: opts.thinkingDialect } : {}),
            ...(opts.contextTokens ? { contextTokens: opts.contextTokens } : {}),
          },
          roles: scenario.simulation.roles ?? {},
        },
      })
    : undefined;
  let db: import("better-sqlite3").Database | undefined;

  try {
    const agentName = scenario.agent?.name ?? "bench";
    const configObject = buildConfig(scenario, opts, sim);

    // Every speaker a room line uses has to resolve, or the wake policy reads
    // an unknown label as a person and the transcript loses attribution.
    const rooms = (configObject.rooms ?? {}) as Record<string, unknown>;
    const identities = { ...((rooms.identities ?? {}) as Record<string, unknown>) };
    const declaredAgents = Object.keys((configObject.agents ?? {}) as Record<string, unknown>);
    // The day marker speaks on every simulation run and appears in no scenario
    // file, so it has to be declared here or the wake policy reads an unknown
    // label and the transcript loses attribution for every day boundary.
    if (scenario.simulation) identities[DAY_MARKER] = `person-${DAY_MARKER}`;
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
    ) => [
      ...createTools(cfg, ctxDir, cfgPath, runtimeOpts).map((t) =>
        instrument(t, recorder, scenario.toolResults ?? {}, world),
      ),
      // Scenario-declared instruments, stubbed unconditionally — there is
      // nothing behind them but the world. Appended alongside the real ones so
      // an agent's `tools:` allowlist decides who holds which, exactly as it
      // does for `exec`.
      ...buildScenarioTools(scenario.tools ?? []).map((t) =>
        instrument(t, recorder, scenario.toolResults ?? {}, world, true),
      ),
      // Not instrumented: it is not a stub standing in for something real, it
      // *is* the thing. Appended here rather than in the meta-tool list so an
      // agent's `tools:` allowlist still governs whether it can reach it.
      ...(oracle ? [answerTool(oracle, recorder)] : []),
      // The simulation's instruments. Every role's tools are built here and the
      // per-agent allowlist decides who can reach which — the same mechanism
      // production uses, rather than a second one invented for the benchmark.
      // Wrapped so calls are recorded and attributed, but never stubbed: unlike
      // every other tool in this harness these have a real implementation, and
      // it is the thing under test.
      ...(sim
        ? [...Object.values(sim.tools()).flat(), ...sim.sharedTools()].map((t) =>
            instrument(t, recorder, scenario.toolResults ?? {}, undefined),
          )
        : []),
    ];

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
      createMetaTools(runtime, contextDir, kbDir).map((t) =>
        instrument(t, recorder, scenario.toolResults ?? {}, world),
      ),
    );

    /*
     * The runtime's own media store, so a simulation's tool can hand the model
     * a picture instead of a description of one.
     *
     * After construction rather than through `createSimulation`, because the
     * store does not exist until the runtime resolves it from config — and it
     * has to be *this* instance, not an equivalent one built beside it, or the
     * loop hydrates the simulation's refs to nothing. Before the first turn,
     * which is what makes the ordering safe: `sim.tools()` is called lazily by
     * the tool factory and each tool reads the store when it executes, not when
     * it is built.
     */
    sim?.attachMedia?.(runtime.getMediaStore());

    const outcome = scenario.rooms?.length
      ? await runRoomScenario(scenario, runtime, db, agentName, opts, recorder, world, sim)
      : await runChatScenario(scenario, runtime, db, agentName, opts);

    // The room path emits its own turns and its own ending. A single-turn
    // session scenario has neither, and without this a viewer pointed at one
    // would sit on "connecting" forever for a run that finished in nine
    // seconds — the tool has to be honest about every scenario, not just the
    // ones it was built to watch.
    if (!scenario.rooms?.length) {
      emit({ kind: "turn", at: Date.now(), turn: 0, round: 0, agent: agentName, room: "(session)" });
      if (outcome.reply) {
        emit({
          kind: "post",
          at: Date.now(),
          turn: 0,
          agent: agentName,
          room: "(session)",
          to: [],
          body: outcome.reply,
        });
      }
      emit({ kind: "end", at: Date.now(), turns: 1 });
    }

    return {
      ...outcome,
      ...(sim && scenario.simulation
        ? { simulation: describeSimulation(sim, scenario.simulation, simSeed, outcome.dayOfTurn ?? []) }
        : {}),
      calls: recorder.calls,
      executions: recorder.executions,
      requests: recorder.requests,
      usage: recorder.usage,
      ...(world ? { world: world.snapshot(), worldLog: world.log } : {}),
      ...(oracle ? { guesses: oracle.submissions } : {}),
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
      // Recorded even when the turn threw: how far the world got before it fell
      // over is the most useful thing about a crashed run.
      ...(world ? { world: world.snapshot(), worldLog: world.log } : {}),
      ...(oracle ? { guesses: oracle.submissions } : {}),
      latencyMs: Date.now() - started,
      providerErrors: recorder.failures,
      error: (err as Error).message,
    };
  } finally {
    // The room backend registry is a module singleton keyed by backend id, so a
    // stale `local` backend points the next run at a closed database.
    //
    // Unconditional, and it was not: this used to fire only after a room
    // scenario, on the reasoning that only those build a backend. They are not
    // the only ones — `tools/builtin.ts` registers a `local` backend lazily
    // whenever the `room` tool is built, which every scenario in this harness
    // does, and `AgentRuntime` registers one of its own. So a chat scenario left
    // a backend pointing at the database closed on the next line, and the next
    // room run in the same process died on "the database connection is not
    // open". Invisible in a benchmark run, where the runner forks per scenario —
    // and immediate the moment anything drives `runOnce` twice, which is what
    // found it.
    unregisterRoomBackend("local");
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
): Promise<Pick<RunOutcome, "reply" | "posts" | "stop" | "dayOfTurn">> {
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
 * One stop for a run that may have taken several turns.
 *
 * The first stall if there was one, otherwise the last turn's ending. A
 * coordination scenario where the first agent gets stuck and the second answers
 * cleanly is a run that went wrong, and reporting the second agent's tidy
 * ending would say the opposite — which is the direction that hides things, so
 * it is the direction to rule out.
 *
 * Exported for the test rather than inlined: this is the only judgement call in
 * the room path's stop reporting, and everything around it is plumbing.
 */
export function stopForRun(stops: readonly LoopStop[]): LoopStop | undefined {
  return stops.find(isStallStop) ?? stops[stops.length - 1];
}

export interface PlannedTurn {
  room: string;
  agent: string;
  kind?: string;
  /** Which pass this belongs to, on a `rounds:` wake. Absent on an explicit list. */
  round?: number;
}

/**
 * The turns a scenario runs, normalised.
 *
 * A bare object and a one-entry list mean the same thing; `agent` defaults to
 * the agent under test so a single-agent scenario never names it. With no
 * `wake:` at all, the last room carrying `incoming:` lines is the one that woke
 * somebody — the rule the schema already enforces.
 *
 * A `rounds:` object expands into `rounds × agents` turns, tagged with which
 * pass each belongs to so the runner can stop after a pass that changed
 * nothing. Six agents needing a dozen exchanges is seventy-two entries written
 * by hand, and the length of that list is not supposed to be part of the
 * measurement.
 */
export function wakeSteps(scenario: Scenario, agentName: string): PlannedTurn[] {
  const wake = scenario.wake;
  const declared = wake ? (Array.isArray(wake) ? wake : [wake]) : [];
  const blocks = declared.filter((step): step is WakeRounds => "agents" in step);

  if (blocks.length) {
    // Round-major across every block, not block by block.
    //
    // With two rooms this is the difference between a scenario and nothing: run
    // all of the north room's turns and then all of the south room's, and an
    // agent sitting in both carries everything across in one go, at a moment
    // when the south room has not started. Interleaving is what makes a relay a
    // relay — each side gets a turn, then the other side, and the carrier has to
    // choose what to bring.
    if (blocks.length !== declared.length) {
      throw new Error("a `wake:` list mixes turn entries and roster entries; use one form or the other");
    }
    const steps: PlannedTurn[] = [];
    const rounds = Math.max(...blocks.map((b) => b.rounds));
    for (let round = 0; round < rounds; round++) {
      for (const block of blocks) {
        if (round >= block.rounds) continue;
        for (const agent of block.agents) steps.push({ room: block.room, agent, round });
      }
    }
    return steps;
  }

  if (declared.length) {
    // Narrowed above: `blocks.length` is zero here, so every entry is a turn.
    return (declared as WakeStep[]).map((step) => ({
      room: step.room,
      agent: step.agent ?? agentName,
      kind: step.kind,
    }));
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
  recorder: Recorder,
  world?: World,
  sim?: Simulation,
): Promise<Pick<RunOutcome, "reply" | "posts" | "stop" | "turns" | "dayOfTurn">> {
  const store = runtime.getRoomStore();
  const backend = new LocalRoomBackend(db, store);

  const refs = new Map<string, string>();
  for (const spec of scenario.rooms ?? []) {
    // createRoom already persists through the store, so there is nothing to
    // upsert afterwards — doing it again would just rewrite the same row.
    const room = await backend.createRoom({ name: spec.name, purpose: spec.purpose });
    const ref = formatRoomRef(room.ref);
    refs.set(spec.name, ref);
    // Every agent that takes a turn is subscribed to every room, unless the room
    // names its own `members`. Subscription otherwise follows participation
    // rather than declaration: an agent named only in `config.agents` is
    // scenery — it exists so the transcript can show a third party — and
    // subscribing it would put it in the roster of a room it never speaks in,
    // changing the prompt of every scenario that has one.
    const members = spec.members ?? wakeAgents(scenario, agentName);
    for (const agent of members) {
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

  // Why each turn ended.
  //
  // A room turn's return value cannot carry this: `pollOnce` and `runCheckIn`
  // return void, and the FIFO chain they run through (`onRoomTurn`) has no
  // channel to thread a value back along. So the watcher reports it on the bus
  // and we listen — which is also how a production subscriber would learn it,
  // rather than a hook that exists only for the benchmark.
  //
  // Until this landed, every room run recorded `stop: undefined` — 56% of a
  // 237-run cohort — and the grader fell back to matching `[Agent stopped: …]`
  // in the reply, which matched none of the 12 stalls in that cohort. The room
  // path had no stall detection at all; it had a regex that had never fired.
  const stops: LoopStop[] = [];
  const listening = runtime.events?.on("room.turn_ended", (e) => {
    if (e.stop) stops.push(e.stop);
  });

  // Where each turn's posts end, so a post can be attributed to the turn that
  // produced it. Room messages arrive through the database rather than through
  // a return value, so this boundary list is the only way to recover the order.
  const highWater = () =>
    (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM room_messages").get() as { id: number }).id;
  const boundaries: number[] = [];
  const turns: Array<{ agent: string; room: string }> = [];

  // A pass that changes nothing ends the run.
  //
  // `rounds:` has to be generous — a discovery loop needs room to close, and the
  // cost of guessing low is a scenario that measures the length of its own wake
  // list. Generous is expensive at six agents a pass, and the cheapest possible
  // evidence that a team has finished (or jammed) is a whole pass in which
  // nobody said anything and nothing in the machinery moved, not even a refusal.
  const rosters = (Array.isArray(scenario.wake) ? scenario.wake : scenario.wake ? [scenario.wake] : []).filter(
    (step): step is WakeRounds => "agents" in step,
  );
  const quiescent = rosters.length > 0 && !rosters.some((r) => r.noQuiescence);
  // Posts and world transitions together, because a team hammering a locked door
  // is stuck rather than finished, and cutting the run short there would report
  // "quiescent" for the state most worth watching. A refused transition counts.
  const activity = () => ({ posts: highWater() - watermark, world: world?.log.length ?? 0 });
  let round = steps[0]?.round;
  let activityAtRoundStart = activity();
  // Which simulated day each turn ran on. The only clock connecting the
  // transcript to the economy, and what lets latency be reported in days.
  const dayOfTurn: number[] = [];
  const stride = Math.max(1, scenario.simulation?.daysPerRound ?? 1);

  /**
   * One line a day, from the clock on the wall.
   *
   * Required, not decoration. `pollOnce` returns without running a turn when a
   * room has nothing new in it, so on a round where nobody happened to post,
   * every agent would sleep — and a run whose team went quiet on day two would
   * take no further turns while the harness cheerfully advanced the clock to the
   * horizon. The failure would look exactly like a team that chose to say
   * nothing, which is the thing this benchmark is supposed to be able to tell
   * apart from a team that was never woken.
   *
   * It carries the day and nothing else. Anything about the state of the
   * business would be a broadcast, and would hand every agent information the
   * simulation deliberately gave to one of them.
   */
  const strikeTheHour = async () => {
    if (!sim) return;
    const horizon = scenario.simulation?.days;
    // The simulation says what its own clock says. The harness knows only that
    // there is a clock and that somebody has to wind it — a runner that writes
    // this sentence itself has to know whether the world has customers or
    // water in it, and grows a branch for every world after the first.
    const body =
      sim.announce?.() ?? `Day ${sim.day + 1}${horizon ? ` of ${horizon}` : ""}. Today's decisions are yours.`;
    for (const ref of refs.values()) {
      await postLine(backend, room_id(ref), { speaker: DAY_MARKER, body });
    }
  };

  /**
   * One line per round, for anybody watching.
   *
   * Emitted even when the simulation has nothing to announce, because the round
   * boundary is what a viewer draws its timeline against — and in a puzzle where
   * state decays every round, "which round was that" is most of the story.
   */
  /**
   * Everything said since the last time we looked, for anybody watching.
   *
   * Drained after each turn rather than collected at the end, which is the whole
   * point: the report already has the transcript, and by the time it exists the
   * run is over. The same envelope parsing the final mapper does, so a live view
   * and the report attribute a line to the same speaker.
   *
   * The clock's own lines are dropped here exactly as they are there — a day
   * marker is the harness talking, not the team.
   */
  let traced = watermark;
  const drainPosts = () => {
    // The simulation wants these even when nothing is tracing: `observePost` is
    // how a live view learns what the team is saying, and a run watched through
    // the arcade rather than through `eval watch` passes no trace callback.
    if (!recorder.trace && !sim?.observePost) return;
    const rows = db
      .prepare("SELECT id, room_ref, content FROM room_messages WHERE id > ? ORDER BY id")
      .all(traced) as Array<{ id: number; room_ref: string; content: string }>;
    for (const row of rows) {
      traced = Math.max(traced, row.id);
      const envelope = parseEnvelope(row.content);
      if (envelope.speaker === DAY_MARKER) continue;
      const post = {
        ...(envelope.speaker ? { agent: envelope.speaker } : {}),
        room: [...refs].find(([, ref]) => ref === row.room_ref)?.[0] ?? row.room_ref,
        to: envelope.to ?? [],
        body: envelope.body.trim(),
      };
      recorder.trace?.({ kind: "post", at: Date.now(), turn: recorder.turn, ...post });
      // Never allowed to take the run down. A simulation that throws while
      // being told what was said would turn a reporting problem into a lost
      // run, and the artifact is the deliverable.
      try {
        sim?.observePost?.(post);
      } catch {
        // Nothing to say; the trace already has it.
      }
    }
  };

  const openRound = (n: number) => {
    recorder.trace?.({
      kind: "round",
      at: Date.now(),
      round: n,
      ...(sim ? { day: sim.day } : {}),
      ...(sim?.announce?.() ? { announce: sim.announce() as string } : {}),
    });
  };

  /** Publish the simulation state at an actual world boundary. */
  const traceState = (atRound: number) => {
    if (!sim) return;
    recorder.trace?.({
      kind: "state",
      at: Date.now(),
      turn: recorder.turn,
      round: atRound,
      snapshot: sim.snapshot(),
      resolved: true,
      ...(sim.announce?.() ? { announce: sim.announce() as string } : {}),
    });
  };

  try {
    await strikeTheHour();
    openRound(round ?? 0);
    for (const step of steps) {
      if (step.round !== round) {
        // A pass that changed nothing ends the run — unless a simulation is
        // running, where it does not: the economy moves on its own, so "nobody
        // said anything" is a fact about the team rather than evidence the run
        // is over, and stopping there would score a company that was abandoned
        // on day three as though the horizon were day three.
        if (quiescent && !sim) {
          const now = activity();
          if (now.posts === activityAtRoundStart.posts && now.world === activityAtRoundStart.world) break;
          activityAtRoundStart = now;
        }
        // The clock ticks between rounds, not between turns. One pass of the
        // roster is one simulated day, so every manager decides on the same
        // information and the day closes once. Letting an agent close the day
        // itself is worse in both directions: the managers who had not spoken
        // yet would be acting on tomorrow's numbers, and a roster that forgot to
        // call it would run the whole scenario against a frozen world and report
        // an untouched balance sheet as a result.
        // `daysPerRound` days pass between decisions, not one. See the note on
        // `SimulationSpec.daysPerRound`: a horizon short enough for one round
        // per day is short enough to reward doing nothing.
        for (let i = 0; i < stride && !sim?.done; i++) sim?.advance();
        // The result belongs in the trace before the next round is announced.
        // Waiting for the first agent turn left the stage showing the previous
        // room (and its stale intents) throughout a potentially long model call.
        traceState(round ?? 0);
        round = step.round;
        await strikeTheHour();
        openRound(round ?? 0);
      }
      // A team cannot manage a company that has already failed. Stopping here
      // rather than running the roster out keeps `daysManaged` honest — turns
      // taken after a bankruptcy are turns spent on nothing.
      if (sim?.done) break;

      const ref = refs.get(step.room);
      if (!ref) throw new Error(`unknown wake room "${step.room}"`);
      recorder.turn = turns.length;
      turns.push({ agent: step.agent, room: step.room });
      if (sim) dayOfTurn.push(sim.day);
      recorder.trace?.({
        kind: "turn",
        at: Date.now(),
        turn: recorder.turn,
        round: step.round ?? 0,
        agent: step.agent,
        room: step.room,
      });
      const reply =
        step.kind === "checkin" ? await watcher.runCheckIn(step.agent, ref) : await watcher.pollOnce(step.agent, ref);
      // After the turn rather than before: what a viewer wants to see is the
      // state this agent left behind, next to what it said.
      if (sim) {
        recorder.trace?.({
          kind: "state",
          at: Date.now(),
          turn: recorder.turn,
          round: step.round ?? 0,
          snapshot: sim.snapshot(),
        });
      }
      drainPosts();
      replies.push({ agent: step.agent, reply: typeof reply === "string" ? reply : "" });
      boundaries.push(highWater());
    }
  } finally {
    drainPosts();
    listening?.dispose();
    watcher.stop();
    // Run the company on to the horizon under management's last decisions.
    //
    // Not a formality: it is what makes an eight-round agent run comparable with
    // a baseline swept over the same sixty days. Truncating instead would score
    // the team on a shorter horizon than the thing it is being compared to, and
    // flatter every team that stopped early — a company that is abandoned keeps
    // paying wages, and the balance sheet should say so.
    finishSimulationTrace(sim, recorder.trace, {
      turn: recorder.turn,
      round: round ?? 0,
      turns: turns.length,
    });
  }

  const byRef = new Map([...refs].map(([name, ref]) => [ref, name]));
  const rows = db
    .prepare("SELECT id, room_ref, content FROM room_messages WHERE id > ? ORDER BY id")
    .all(watermark) as Array<{ id: number; room_ref: string; content: string }>;

  // Attributed, because with more than one agent taking a turn "who posted this"
  // is the question. The envelope already carries the speaker, so this is free.
  //
  // The clock's own lines are dropped. They sit above the watermark like
  // everything else, so leaving them in would credit the harness's day markers
  // to the team — inflating `posts_by`, and putting a sentence the agents never
  // wrote into the joined `reply` that every text assertion reads.
  const posts = rows
    .map((row) => {
      const envelope = parseEnvelope(row.content);
      const turn = boundaries.findIndex((edge) => row.id <= edge);
      return {
        room: byRef.get(row.room_ref) ?? row.room_ref,
        body: envelope.body.trim(),
        agent: envelope.speaker,
        ...(turn === -1 ? {} : { turn }),
      };
    })
    .filter((post) => post.agent !== DAY_MARKER);

  // `reply` stays every body joined, so single-agent scenarios and every reply
  // assertion behave exactly as before. A multi-agent scenario that needs to
  // separate them asks about `posts`.
  return {
    reply: posts.map((p) => p.body).join("\n"),
    posts,
    stop: stopForRun(stops),
    turns,
    ...(dayOfTurn.length ? { dayOfTurn } : {}),
  };
}

/**
 * The economy as the run left it.
 *
 * `daysManaged` is separate from `days` on purpose. A roster of eight rounds
 * against a sixty-day horizon is a company that was managed for eight days and
 * then ran on by itself, and reporting only the horizon would present that as a
 * full run. The gap is the most useful number on a scenario whose team went
 * quiet early.
 */
function describeSimulation(
  sim: Simulation,
  spec: NonNullable<Scenario["simulation"]>,
  seed: number,
  dayOfTurn: number[],
): import("./types.js").SimulationOutcome {
  return {
    name: sim.name,
    seed,
    days: sim.day,
    daysManaged: dayOfTurn.length ? Math.max(...dayOfTurn) + 1 : 0,
    daysPerRound: spec.daysPerRound ?? 1,
    ...(sim.endedBecause ? { endedBecause: sim.endedBecause } : {}),
    metrics: sim.metrics(),
    objective: sim.objective(),
    events: sim.events,
    dayOfTurn,
    roles: spec.roles,
    ...(spec.options ? { options: spec.options } : {}),
    responses: sim.responses ?? {},
  };
}

/** `local:<id>` → `<id>`, which is what the backend's own methods take. */
function room_id(ref: string): string {
  return ref.startsWith("local:") ? ref.slice("local:".length) : ref;
}

async function postLine(backend: LocalRoomBackend, roomId: string, line: RoomLine): Promise<string | undefined> {
  const posted = await backend.post(roomId, { speaker: line.speaker, to: line.to ?? [], body: line.body });
  return posted?.cursor;
}
