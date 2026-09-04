/**
 * `pnpm run eval` — run the scenario set, score it, write the result.
 *
 * Two subcommands: `run` produces a report file, `compare` diffs two of them.
 * Everything that could differ between two runs and change the score — model,
 * endpoint, sampling, repeat count, scenario set, git SHA — is recorded in the
 * report, because a benchmark number with no provenance is worse than none.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { stripSeparator } from "./args.js";
import { DEFAULT_PINNED_AT, DEFAULT_TIMEZONE } from "./clock.js";
import { printComparison } from "./compare.js";
import { costRecord, usageOfScenarios } from "./cost.js";
import { extractDemo } from "./demo.js";
import { describeDifficulty } from "./difficulty.js";
import { grade, scoreMilestones } from "./graders.js";
import { type HarnessOptions, wakeSteps } from "./harness.js";
import { narrate } from "./narrate.js";
import { PAYLOAD_FILENAME, readWorkerResult } from "./protocol.js";
import { rehearse } from "./rehearse.js";
import { printScenario, printStalls, printSummary, score, verdict } from "./report.js";
import { traceFacts } from "./routing.js";
import { loadScenarios } from "./schema.js";
import {
  createSimulation,
  listSimulations,
  simulationDefaults,
  simulationKnobs,
  simulationPolicies,
  unknownSimOptions,
} from "./sim/index.js";
import { transitionSystem as lockSystem } from "./sim/lock/model.js";
import { formatLadder, ladder as lockLadder } from "./sim/lock/solvers.js";
import { formatProof, prove, type TransitionSystem } from "./sim/prove.js";
import { formatSweep, gradient, summarise, sweep } from "./sim/sweep.js";
import { simulationReport } from "./sim/types.js";
import { substituteTokens } from "./tokens.js";
import type { BenchmarkReport, CheckResult, RunOutcome, Scenario, ScenarioResult } from "./types.js";
import { newestTrace, serveWatch } from "./watch.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const USAGE = `
tai evals — scenario benchmark for the invocation message

  pnpm run eval -- --model <id> [options]
  pnpm run eval:compare -- <before.json> <after.json>
  pnpm run eval -- regrade <report.json> [--out <file>]   re-score a finished run
                                                          against today's assertions,
                                                          with no model calls
  pnpm run eval -- bench [--simulation factory] [--seeds 60] [--days 60]
                         [--days-per-round 8] [--sim-option k=v] [--raw-options]
                         [--out <file>]
                                                          sweep a simulation's baseline
                                                          policies and print the ladder.
                                                          No model calls; run this before
                                                          trusting any agent score. Sweeps
                                                          the configuration the scenario
                                                          plays; --raw-options sweeps the
                                                          constructor's bare defaults,
                                                          which is a different game.
  pnpm run eval -- watch [--trace <file>] [--port 4380] [--host 127.0.0.1]
                                                          live view of a run: state, messages,
                                                          tool calls, milestones and facts.
                                                          Defaults to the newest trace.
  pnpm run eval -- narrate [--trace <file>] [--home <dir>] [--model <id>]
                                                          commentate on a run from outside
                                                          it. Reads the trace, writes a
                                                          sidecar; never touches the run,
                                                          so a narrated run and a private
                                                          one are byte-identical.
  pnpm run eval -- rehearse [--policy rule-based] [--seed 1000] [--start-floor 31]
                            [--no-maze] [--no-preparation]
                            [--simulation descent-betrayed] [--traitors 0|1|2|roll]
                            [--hide-traitors]                 keep who they are out of
                                                              the trace, for a run somebody
                                                              should watch blind
                                                          play a baseline through the
                                                          simulation and write a trace, so the
                                                          broadcast viewer can be developed in
                                                          seconds instead of model-hours.
                                                          Plays the scenario's configuration
                                                          by default. Writes to
                                                          results/rehearsals/, which the
                                                          scoreboard does not read.
  pnpm run eval -- prove [--puzzle lock] [--rounds 12]
                                                          search a puzzle's whole state graph:
                                                          soft-locks, shortest solution, and
                                                          whether flailing can win. Exits
                                                          non-zero if the puzzle is broken.

Options
  --target <name>       Load flag defaults from targets/<name>.json (explicit flags still win)
  --home <dir>          Read baseUrl / model / sampling from a real instance's config.yaml
  --base-url <url>      OpenAI-compatible endpoint (default http://127.0.0.1:8000/v1)
  --model <id>          Model to benchmark (required unless --home supplies one)
  --repeats <n>         Runs per scenario (default 3). The score is a pass rate over these.
  --rounds <n>          Cut every scenario to n rounds. For iterating on a question, not for
                        scoring: a shortened run is not comparable to a full one.
  --sim-option k=v      Override one of the simulation's own knobs (repeatable).
  --concurrency <n>     Scenarios in flight (default 4)
  --filter <s>          Only scenarios whose id contains <s>, or whose category is <s>.
                        Comma-separate to select several: --filter a-row,b-row
  --difficulty <spec>   Only scenarios at these levels: 4, 4+, 2-3, 3,5. Composes with --filter.
  --seed <n>            Base seed; repeat i uses seed+i (default 1000). --seed off to disable.
  --pinned-at <iso>     Instant every scenario resolves civil time against
                        (default a fixed Wednesday). --pinned-at off uses the host clock.
  --time-zone <iana>    Zone the pinned clock reports (default America/Los_Angeles).
  --temperature <n>     Default 0.3
  --max-tokens <n>      Default 2048; 'off' sends no cap (some hosted models reject it)
  --resume-trace <file> --resume-round <n>
                        Start from the world an earlier run played into, rebuilt
                        by replaying that run's own calls (~20ms, no model). For
                        asking about the second half of a long scenario without
                        paying for the first. The party arrives with no memory of
                        how it got there, so a resumed run is not comparable with
                        a full one and must not be scored against a cohort.
  --max-history-tokens <n>
                        History budget per request. Default: core's own, so an
                        agent here trims like a deployed one. Tool schemas count
                        against it — 40 tools are ~10,900 tokens.
  --max-context-tokens <n>
                        What the server actually accepts. Set it on a target and
                        core will warn when the budget cannot fit the window,
                        which is the failure that ends a long run mid-horizon.
  --max-tool-rounds <n> Default 20. A scoring setting: a low cap favours models
                        that answer without searching. Recorded in the report.
  --max-scenario-minutes <n>  Backstop per scenario (default 120). Raise it for a large
                        roster: five agents over forty rounds is 200 turns, and a run
                        killed by the backstop is scored as whatever it had reached.
  --keep-prompts        Store full prompt text on every run so \`regrade\` can
                        re-score it completely (bigger report)
  --timeout <ms>        Per model call (default 300000)
  --thinking <level>    off | auto | low | medium | high (default: the provider's)
  --inject-memory       Hand the agent's memory to it in the request, instead of
                        leaving it to fetch what it needs. Core's default is off,
                        so this is the second arm of a scenario with \`memory:\`.
  --provider-extra <j>  JSON merged into agent.providerExtra, e.g.
                        '{"reasoning_effort":"none","max_completion_tokens":2048}'
  --api-key-env <VAR>   Name of the env var holding the key. Passed to the config as
                        \${VAR} so loadConfig interpolates it and it never reaches disk.
  --thinking-dialect <d> Provider dialect for reasoning, e.g. vllm
  --plugins <a,b>       Provider plugins to load, e.g. @tailored-ai/provider-openai
  --provider <id>       Provider id the agent runs on (default openai_compatible)
  --judge               Enable LLM-judged assertions (off by default: noisy)
  --out <file>          Report path (default results/<stamp>-<model>.json)
  --min-score <0..1>    Exit non-zero below this score
  --trace <file>        Where the live trace goes (default results/traces/<stamp>.ndjson).
                        --trace off writes none. Watch it with \`eval watch\`.
  --dry-run             Validate scenarios and print the plan; call no model
  --verbose             Stream worker stderr
`;

/** How much worker stdout to keep, purely to explain a worker that died. */
const TAIL_CHARS = 2000;

/**
 * Default ceiling on the worker backstop, however many turns a scenario declares.
 *
 * A six-agent, eight-round scenario multiplies out to half a day of worst-case
 * per-call timeouts, and a backstop nobody will sit through is not a backstop.
 * Two hours is longer than any scenario that is working takes and short enough
 * that a wedged one does not eat a night.
 *
 * "Longer than any scenario that is working takes" stopped being true when
 * `the-endless-descent` arrived: five agents over forty rounds is two hundred
 * turns, which at the measured thirty-five seconds a turn lands within minutes
 * of this limit. A run killed by the backstop is scored as whatever it had
 * reached, which reads as a bad organisation rather than as a timer — so the
 * ceiling is a flag now, and this is only its default.
 */
const MAX_SCENARIO_MS = 2 * 60 * 60 * 1000;

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Pull endpoint and sampling out of a deployment's own config.
 *
 * Read as raw YAML rather than through `loadConfig`, because a real config
 * interpolates `${API_KEY}` from an env file this process does not have — and
 * failing to read a benchmark target because of a key the benchmark never uses
 * would be its own bug.
 */
function readInstanceDefaults(home: string): Partial<HarnessOptions> {
  const path = join(home, "config.yaml");
  if (!existsSync(path)) throw new Error(`no config.yaml in ${home}`);
  const config = YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const provider = config?.providers?.openai_compatible ?? {};
  const agent = config?.agent ?? {};
  const out: Partial<HarnessOptions> = {};
  if (typeof provider.baseUrl === "string" && !provider.baseUrl.includes("${")) out.baseUrl = provider.baseUrl;
  if (typeof provider.defaultModel === "string") out.model = provider.defaultModel;
  if (typeof agent.temperature === "number") out.temperature = agent.temperature;
  if (typeof agent.maxTokens === "number") out.maxTokens = agent.maxTokens;
  if (agent.providerExtra && typeof agent.providerExtra === "object") out.providerExtra = agent.providerExtra;
  if (typeof provider.thinkingDialect === "string") out.thinkingDialect = provider.thinkingDialect;
  if (typeof provider.thinking === "string") out.thinking = provider.thinking;
  return out;
}

/**
 * The parsed command line, as `applyTarget` sees it.
 *
 * `string[]` is here for repeatable flags (`--sim-option k=v`, given more than
 * once). A target file fills in single values only and leaves arrays alone,
 * which is right: a named bundle of defaults should not be able to inject
 * simulation knobs behind the command line's back.
 */
type Flags = Record<string, string | string[] | boolean | undefined>;

function applyTarget(values: Flags): void {
  const name = values.target;
  if (typeof name !== "string") return;
  const path = join(packageRoot, "targets", `${name}.json`);
  if (!existsSync(path)) {
    const known = readdirSync(join(packageRoot, "targets"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
    throw new Error(`unknown target "${name}". Known: ${known.join(", ") || "(none)"}`);
  }
  const preset = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(preset)) {
    if (key.startsWith("_") || values[key] !== undefined) continue;
    values[key] = value as string | boolean;
  }
}

function parseProviderExtra(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`--provider-extra is not a JSON object: ${(err as Error).message}`);
  }
}

async function runWorker(
  scenario: Scenario,
  options: HarnessOptions,
  repeats: number,
  judge: boolean,
  verbose: boolean,
  keepPrompts: boolean,
  source?: string,
  tracePath?: string,
  maxScenarioMs: number = MAX_SCENARIO_MS,
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-payload-"));
  const payloadPath = join(dir, PAYLOAD_FILENAME);
  // The scenario travels as JSON *and* as a path back to the file it came from.
  //
  // JSON is enough to run it — a scenario is data by construction, see
  // `define.ts`. The path is what carries a module's *side effects* across the
  // process boundary: a scenario file is free to call `registerSimulation`, and
  // in a worker that only received JSON that registration never happened, so
  // the run would die on "unknown simulation" naming something the parent had
  // resolved perfectly well a moment earlier.
  writeFileSync(payloadPath, JSON.stringify({ scenario, options, repeats, judge, keepPrompts, source, tracePath }));

  return await new Promise<ScenarioResult>((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "worker.ts"), payloadPath], {
      cwd: packageRoot,
      // The worker logs freely to stdout, so it is drained rather than inherited
      // — an unread pipe fills at 64 KB and blocks the worker on its next log
      // line. Only the tail is kept, and only to explain a worker that died.
      //
      // Stderr is piped for exactly the same reason, and used not to be. That
      // was the bug: this pipe exists *to explain a dead worker*, and the
      // explanation a dying process writes — "FATAL ERROR: … JavaScript heap
      // out of memory", an uncaught throw, a native crash — goes to stderr,
      // which was routed to /dev/null unless somebody happened to be running
      // with `--verbose`. So the one channel carrying the cause was the one
      // channel discarded, and a scenario that died every single time could
      // only ever report the startup notice that happened to be last on stdout.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let tail = "";
    child.stdout.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-TAIL_CHARS);
    });

    // Kept separately rather than merged into `tail`: interleaved, a chatty
    // stdout evicts the few stderr lines that matter, which is the failure this
    // is here to prevent. `--verbose` still streams it live, so piping costs
    // that mode nothing.
    let errTail = "";
    child.stderr.on("data", (chunk) => {
      errTail = (errTail + String(chunk)).slice(-TAIL_CHARS);
      if (verbose) process.stderr.write(chunk);
    });

    // Backstop for a worker wedged somewhere other than a model call, which the
    // per-call timeout cannot see. Generous on purpose: it is here so a batch
    // finishes, not to bound a slow scenario.
    //
    // Scaled by the turns the scenario actually runs, which it was not. The old
    // budget assumed one turn per repeat and so bounded a seven-turn room
    // scenario at one turn's worth of time; a forty-eight-turn one would be
    // SIGKILLed halfway and reported as an errored scenario, which reads as a
    // crash rather than as a timer. Capped, because turns × rounds × per-call
    // timeout reaches half a day on a large roster and a backstop nobody will
    // wait for is not one.
    const turns = Math.max(1, wakeSteps(scenario, scenario.agent?.name ?? "bench").length);
    const budget = Math.min(repeats * turns * (options.maxToolRounds + 2) * options.timeoutMs, maxScenarioMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), budget);

    // Identity travels with the result rather than through the worker: the
    // worker grades runs and has no reason to know why a scenario exists.
    const describe = {
      id: scenario.id,
      category: scenario.category,
      intent: scenario.intent,
      difficulty: scenario.difficulty,
    };
    const gap = scenario.knownGap ? { knownGap: scenario.knownGap } : {};

    // Every exit from here resolves with *something*. A worker that dies, or
    // comes back with a result that will not parse, is one scenario reported as
    // an error — never an exception out of an event handler, which is not
    // catchable by the promise around it and takes the whole run down after the
    // model time has already been spent.
    child.on("close", (code, signal) => {
      clearTimeout(kill);
      const outcome = readWorkerResult(dir, code, tail, { signal, stderr: errTail });
      rmSync(dir, { recursive: true, force: true });
      resolvePromise(
        "error" in outcome
          ? { ...describe, ...gap, runs: [], passRate: 0, error: outcome.error }
          : { ...outcome.result, ...gap },
      );
    });
  });
}

/** Fixed-size worker pool: `limit` scenarios in flight, results in scenario order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function cmdRun(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      target: { type: "string" },
      home: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      repeats: { type: "string" },
      concurrency: { type: "string" },
      filter: { type: "string" },
      difficulty: { type: "string" },
      // Experiment only, never a measurement. See `clampRounds`.
      rounds: { type: "string" },
      // Override one of the simulation's own knobs for this run, the same way
      // `bench` does. The scenario's declared options are the baseline and this
      // layers on top; the trace records the result, so a run configured
      // differently can never be mistaken for the scenario's own.
      "sim-option": { type: "string", multiple: true },
      seed: { type: "string" },
      "pinned-at": { type: "string" },
      "time-zone": { type: "string" },
      temperature: { type: "string" },
      "max-tokens": { type: "string" },
      "max-tool-rounds": { type: "string" },
      "max-history-tokens": { type: "string" },
      "max-context-tokens": { type: "string" },
      "resume-trace": { type: "string" },
      "resume-round": { type: "string" },
      "max-scenario-minutes": { type: "string" },
      timeout: { type: "string" },
      "thinking-dialect": { type: "string" },
      thinking: { type: "string" },
      "inject-memory": { type: "boolean" },
      "provider-extra": { type: "string" },
      plugins: { type: "string" },
      provider: { type: "string" },
      "api-key-env": { type: "string" },
      judge: { type: "boolean" },
      "keep-prompts": { type: "boolean" },
      trace: { type: "string" },
      out: { type: "string" },
      "min-score": { type: "string" },
      "dry-run": { type: "boolean" },
      verbose: { type: "boolean" },
      scenarios: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // A target is a named bundle of flags, not a new configuration layer: it fills
  // in what the command line left out and never overrides it. Hosted models each
  // want their own two or three quirks set, and retyping them every iteration is
  // how a loop ends up measuring a different thing than it did last time.
  applyTarget(values);

  const fromHome = values.home ? readInstanceDefaults(resolve(values.home.replace(/^~/, process.env.HOME ?? "~"))) : {};
  const options: HarnessOptions = {
    baseUrl: values["base-url"] ?? fromHome.baseUrl ?? "http://127.0.0.1:8000/v1",
    model: values.model ?? fromHome.model ?? "",
    // `${VAR}` rather than the value: `loadConfig` interpolates from
    // process.env, so a live key is never written into the temp config.
    apiKey: values["api-key-env"] ? `\${${values["api-key-env"]}}` : (process.env.TAI_EVAL_API_KEY ?? "eval"),
    temperature: values.temperature ? Number(values.temperature) : (fromHome.temperature ?? 0.3),
    maxTokens:
      values["max-tokens"] === "off"
        ? null
        : values["max-tokens"]
          ? Number(values["max-tokens"])
          : (fromHome.maxTokens ?? 2048),
    // 20, not 6.
    //
    // This is a scoring setting, not plumbing: a model that searches before it
    // answers spends rounds, one that answers immediately does not, and a low
    // cap scores the second higher without either being better. At 6, Qwen3.8
    // stalled 16 of 48 long-session runs with correct answers cut off
    // mid-sentence and scored 33.3%; at 20 it stalled 5 and scored 54.2%. Qwen3.6
    // moved far less (16 stalls to 4, 65% to 70.8%) — which is the point. The
    // cap was not measuring the models, it was measuring which one fitted under
    // it. The deployment this benchmark stands in for allows 100.
    maxToolRounds: values["max-tool-rounds"] ? Number(values["max-tool-rounds"]) : 20,
    // Left undefined unless asked for, so core's own defaults apply and the
    // benchmark trims history exactly like a deployment. A target that knows
    // its server's real window should say so: `maxContextTokens` is what makes
    // core's budget-versus-window warning mean anything, and that warning is
    // the one that would have caught the 2026-08-17 descent failure.
    ...(values["resume-trace"]
      ? {
          resumeFrom: {
            trace: resolve(values["resume-trace"] as string),
            round: Number(values["resume-round"] ?? 0),
          },
        }
      : {}),
    ...(values["max-history-tokens"] ? { maxHistoryTokens: Number(values["max-history-tokens"]) } : {}),
    ...(values["max-context-tokens"] ? { maxContextTokens: Number(values["max-context-tokens"]) } : {}),
    providerExtra: { ...(fromHome.providerExtra ?? {}), ...parseProviderExtra(values["provider-extra"]) },
    seed: values.seed === "off" ? null : Number(values.seed ?? 1000),
    pinnedAt: values["pinned-at"] === "off" ? null : (values["pinned-at"] ?? DEFAULT_PINNED_AT),
    timeZone: values["time-zone"] ?? DEFAULT_TIMEZONE,
    timeoutMs: values.timeout ? Number(values.timeout) : 300_000,
    plugins: values.plugins
      ? String(values.plugins)
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean)
      : undefined,
    providerId: values.provider,
    thinkingDialect: values["thinking-dialect"] ?? fromHome.thinkingDialect,
    thinking: values.thinking ?? fromHome.thinking,
    injectMemory: values["inject-memory"] ? true : undefined,
  };

  if (!options.model) {
    console.error("A model is required: pass --model <id>, or --home <dir> to take it from a config.yaml.");
    return 2;
  }

  const scenarioDir = values.scenarios ? resolve(values.scenarios) : join(packageRoot, "scenarios");
  const loaded = await loadScenarios(scenarioDir, values.filter, values.difficulty);
  const { hash, fingerprints, sources } = loaded;
  const overrides: Record<string, unknown> = {};
  for (const pair of (values["sim-option"] as string[] | undefined) ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      console.error(`  --sim-option wants key=value, got "${pair}".`);
      return 2;
    }
    overrides[pair.slice(0, at)] = pair.slice(at + 1);
  }
  // Refused rather than ignored. An unread key is not a no-op: it changes which
  // arm ran while the trace records the typo as though it were the setting.
  for (const scenario of loaded.scenarios) {
    if (!scenario.simulation) continue;
    const bad = unknownSimOptions(scenario.simulation.name, Object.keys(overrides));
    if (bad.length === 0) continue;
    for (const { key, suggestion } of bad) {
      console.error(
        `  --sim-option "${key}" is not a knob of the "${scenario.simulation.name}" simulation` +
          `${suggestion ? `. Did you mean "${suggestion}"?` : "."}`,
      );
    }
    console.error(`  knobs: ${simulationKnobs(scenario.simulation.name).join(", ")}`);
    return 2;
  }
  let scenarios = loaded.scenarios;
  if (values.rounds) scenarios = scenarios.map((s) => clampRounds(s, Number(values.rounds)));
  if (Object.keys(overrides).length) scenarios = scenarios.map((s) => withSimOptions(s, overrides));
  if (!scenarios.length) {
    const narrowed = [
      values.filter ? `filter "${values.filter}"` : "",
      values.difficulty ? `difficulty "${values.difficulty}"` : "",
    ].filter(Boolean);
    console.error(`No scenarios matched${narrowed.length ? ` ${narrowed.join(" + ")}` : ""} in ${scenarioDir}.`);
    return 2;
  }

  // An explicit `--repeats` beats a scenario's own, and the default does not.
  //
  // `scenario.repeats ?? repeats` had the flag losing to the scenario always,
  // which is right for a suite run — a forty-eight-turn row must not cost three
  // hours of it — and wrong the moment you want to measure that row's rate,
  // because there is then no way to ask for more without editing the file.
  const requested = values.repeats === undefined ? null : Number(values.repeats);
  const repeats = requested ?? 3;
  const concurrency = Number(values.concurrency ?? 4);

  if (values["dry-run"]) {
    console.log(
      `${scenarios.length} scenario(s), set ${hash}, ${repeats} repeat(s) → ${scenarios.length * repeats} model turns`,
    );
    for (const s of scenarios) {
      console.log(
        `  ${describeDifficulty(s.difficulty).padEnd(14)} ${s.category.padEnd(16)} ${s.id.padEnd(44)} ${s.expect.length} check(s)`,
      );
    }
    return 0;
  }

  const startedAt = new Date();
  console.log(
    `\nRunning ${scenarios.length} scenario(s) × ${repeats} against ${options.model} ` +
      `via ${options.providerId ?? "openai_compatible"}${options.plugins?.length ? ` (${options.plugins.join(", ")})` : ` at ${options.baseUrl}`} ` +
      `(concurrency ${concurrency})\n`,
  );

  /**
   * Where this run's live trace goes.
   *
   * On by default, and deliberately so. The point of a trace is to be watched
   * while the run happens, and a flag you have to remember before an hour-long
   * run is a flag you remember afterwards. It costs a few hundred kilobytes and
   * `--trace off` turns it off.
   */
  const traceStamp = startedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const tracePath =
    values.trace === "off"
      ? undefined
      : values.trace
        ? resolve(values.trace as string)
        : join(packageRoot, "results", "traces", `${traceStamp}.ndjson`);
  if (tracePath) console.log(`  watch it: pnpm run eval -- watch\n`);

  let done = 0;
  const results = await pool(scenarios, concurrency, async (scenario) => {
    const result = await runWorker(
      scenario,
      options,
      requested ?? scenario.repeats ?? repeats,
      !!values.judge,
      !!values.verbose,
      !!values["keep-prompts"],
      sources[scenario.id],
      tracePath ? tracePath.replace(/\.ndjson$/, "") + `.${scenario.id}.ndjson` : undefined,
      values["max-scenario-minutes"] ? Number(values["max-scenario-minutes"]) * 60_000 : MAX_SCENARIO_MS,
    );
    done++;
    process.stdout.write(`[${String(done).padStart(3)}/${scenarios.length}] `);
    if (result.error) console.log(`ERROR  ${result.id}: ${result.error}`);
    else printScenario(result);
    return result;
  });

  const finishedAt = new Date();
  const runUsage = usageOfScenarios(results);
  const report: BenchmarkReport = {
    meta: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      gitSha: git(["rev-parse", "--short", "HEAD"]) || "unknown",
      gitDirty: git(["status", "--porcelain"]).length > 0,
      model: options.model,
      baseUrl: options.baseUrl,
      provider: options.providerId ?? "openai_compatible",
      plugins: options.plugins ?? [],
      repeats,
      seed: options.seed,
      // Settings that change what the model does and what a turn costs, and
      // were previously unrecorded — so a published result could not be read
      // back to see what produced it. `maxTokens` and `thinking` between them
      // caused #490, where a turn spent its whole budget reasoning and answered
      // nothing; the clock decides whether a wall-clock scenario reproduces at
      // all (#492 was the same bug in a unit test).
      maxTokens: options.maxTokens,
      maxToolRounds: options.maxToolRounds,
      thinking: options.thinking ?? null,
      // `thinking` alone does not identify the request. Under the `vllm`
      // dialect every enabled level sends the same boolean, so `medium` and
      // `high` are the same wire call and the template's own default decides
      // the effort; under `vllm_effort` they are different calls. A report
      // saying only `thinking: medium` cannot be told apart from one that asked
      // for medium and was silently served the template's maximum.
      thinkingDialect: options.thinkingDialect ?? null,
      // Which arm this was. Two reports over the same scenarios are only
      // comparable if the reader can tell whether the agent was handed its
      // memory or left to fetch it, and nothing else in the report says.
      injectMemory: options.injectMemory ?? null,
      pinnedAt: options.pinnedAt ?? null,
      timeZone: options.pinnedAt === null ? null : (options.timeZone ?? DEFAULT_TIMEZONE),
      judge: !!values.judge,
      keepPrompts: !!values["keep-prompts"],
      scenarioSetHash: hash,
      // Per scenario, and only for the ones this run actually covered. The set
      // hash says two reports were defined differently; this says *which*
      // scenario moved, which is the difference between a number a reader can
      // act on and a digest they cannot.
      scenarioFingerprints: Object.fromEntries(scenarios.map((s) => [s.id, fingerprints[s.id]])),
      durationSeconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
      usage: runUsage,
      cost: costRecord(runUsage, options.model),
    },
    score: score(results),
    scenarios: results,
  };

  const outPath = values.out
    ? resolve(values.out)
    : join(
        packageRoot,
        "results",
        `${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${options.model.replace(/[^\w.-]/g, "_")}.json`,
      );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  printSummary(report);
  console.log(`  report  ${outPath}\n`);

  const { code, message } = verdict(report, values["min-score"] ? Number(values["min-score"]) : null);
  if (message) console.error(message);
  return code;
}

function cmdCompare(argv: string[]): number {
  const [beforePath, afterPath] = argv;
  if (!beforePath || !afterPath) {
    console.error("Usage: pnpm run eval:compare -- <before.json> <after.json>");
    return 2;
  }
  const before = JSON.parse(readFileSync(resolve(beforePath), "utf8")) as BenchmarkReport;
  const after = JSON.parse(readFileSync(resolve(afterPath), "utf8")) as BenchmarkReport;
  return printComparison(before, after) ? 1 : 0;
}

/**
 * Re-score a finished run against today's assertions, without touching a model.
 *
 * Every run's full outcome — reply, requests, calls, executions, posts, stop —
 * is already in the report, so a change to a grader or an `expect` block is a
 * pure function of data we have. Before this, checking whether a fix moved
 * anything meant a fresh cohort: sixteen minutes, a GPU, and a fresh roll of
 * the model's own variance mixed into the answer.
 *
 * That last part is the real gain. Re-running conflates "my assertion changed"
 * with "the model sampled differently"; replay holds the behaviour fixed and
 * shows only what the grader did, which is the only way to know an assertion
 * change did what you meant.
 *
 * The result is written with `regradedFrom` set and is **not** a baseline: it
 * describes today's assertions against an older run's behaviour, and publishing
 * it would pair one commit's number with another commit's questions.
 */
/** Assertions that read the request text, which a trimmed report no longer has. */
const PROMPT_CHECKS = new Set(["prompt_contains", "prompt_not_contains", "prompt_occurrences", "prompt_max_tokens"]);

/**
 * Whether this run still carries the prompt text a `prompt_*` check needs.
 *
 * `withoutRequests` keeps the request objects and empties their `system` and
 * `messages`, so length alone cannot tell a stripped run from one that made no
 * calls. An estimate with no text behind it is the signature.
 */
function promptsRetained(outcome: RunOutcome): boolean {
  if (outcome.requests.length === 0) return true;
  return outcome.requests.some((r) => r.system.length > 0 || r.messages.length > 0);
}

async function cmdRegrade(argv: string[]): Promise<number> {
  const [reportPath] = argv;
  if (!reportPath) {
    console.error("Usage: pnpm run eval -- regrade <report.json> [--out <file>]");
    return 2;
  }
  const outFlag = argv.indexOf("--out");
  const report = JSON.parse(readFileSync(resolve(reportPath), "utf8")) as BenchmarkReport;
  const { scenarios } = await loadScenarios(join(packageRoot, "scenarios"));
  const byId = new Map(scenarios.map((s) => [s.id, s]));

  const rescored: ScenarioResult[] = [];
  const moved: string[] = [];
  let missing = 0;
  let skipped = 0;
  for (const result of report.scenarios) {
    const scenario = byId.get(result.id);
    if (!scenario) {
      missing++;
      console.warn(`  ! ${result.id} is in the report but not in scenarios/ — dropped`);
      continue;
    }
    const runs = [];
    for (const run of result.runs) {
      // No judge: an LLM grader would defeat the point, and no scenario uses one.
      // Substituted with the values *this run* was given, not fresh ones: the
      // reply contains the witness the agent actually saw, and grading it
      // against a newly minted one would fail every witness scenario.
      const scoped = run.tokens ? substituteTokens(scenario, run.tokens) : scenario;
      const checks = await grade(scoped, run.outcome);
      // A report keeps the reply, the calls and the posts for every run, but
      // discards the prompt text of runs that passed — the baseline would be
      // hundreds of megabytes otherwise. So `prompt_*` assertions have nothing
      // to read here, and grading them anyway reports a confident failure for
      // an assertion that was never evaluated. The first version of this
      // command did exactly that and turned 92.0% into 75.9%.
      const unreadable = new Set<string>();
      if (!promptsRetained(run.outcome)) for (const k of PROMPT_CHECKS) unreadable.add(k);
      // Same rule for executions: a report written before they were recorded
      // has `undefined`, which means "not recorded" and never "nothing ran".
      if (run.outcome.executions === undefined) unreadable.add("calls_by");
      // And for the world. A report from before worlds existed, or of a run
      // whose scenario has no machinery, carries no final state — which is not
      // the same as a goal that went unreached.
      if (run.outcome.world === undefined) {
        unreadable.add("world_state");
        unreadable.add("world_reached");
      }
      if (run.outcome.guesses === undefined) unreadable.add("answers_correctly");
      if (run.outcome.executions === undefined) unreadable.add("fact_reaches");
      const gradable = checks.filter((c) => !unreadable.has(c.kind));
      skipped += checks.length - gradable.length;
      // The ladder and the routing are recomputed, not carried over.
      //
      // `...run` kept the stored ones, which made this command useless for the
      // thing it exists for: a milestone written against the wrong assertion
      // re-scored to exactly the same wrong answer, and the fix could only be
      // seen by paying for another run. They are diagnosis rather than score, so
      // they never move `pass` — a milestone that cannot be graded on an old
      // report simply reads as not reached, the same as it does live.
      const milestones = scenario.milestones?.length ? await scoreMilestones(scoped, run.outcome) : undefined;
      // `scoped`, not `scenario`: the fact values are `{{token:…}}` until
      // substitution, and tracing against the literal finds nothing anywhere —
      // which renders as a run that routed none of its facts rather than as a
      // regrade bug. The same mistake in the same shape as the oracle whose
      // accepted answer was still the token.
      const facts = scoped.facts ? traceFacts(scoped.facts, run.outcome) : undefined;
      runs.push({
        ...run,
        pass: gradable.every((c: CheckResult) => c.pass),
        checks: gradable,
        ...(milestones ? { milestones } : {}),
        ...(facts ? { facts } : {}),
      });
    }
    const passed = runs.filter((r) => r.pass).length;
    const passRate = runs.length ? passed / runs.length : 0;
    if (passRate !== result.passRate) {
      moved.push(`  ${(result.passRate * 100).toFixed(0)}% → ${(passRate * 100).toFixed(0)}%  ${result.id}`);
    }
    rescored.push({ ...result, runs, passRate, intent: scenario.intent, difficulty: scenario.difficulty });
  }

  const out: BenchmarkReport = {
    ...report,
    meta: { ...report.meta, regradedFrom: { report: resolve(reportPath), gitSha: report.meta.gitSha } },
    score: score(rescored),
    scenarios: rescored,
  };

  console.log(`\n  regraded ${rescored.length} scenario(s) from ${report.meta.gitSha}, no model calls`);
  if (missing) console.log(`  ${missing} scenario(s) in the report no longer exist`);
  if (skipped) {
    console.log(
      `  ${skipped} check(s) skipped — this report does not carry what they read.\n` +
        "    Prompt text is dropped from passing runs unless the run used --keep-prompts;\n" +
        "    executions are absent from reports written before they were recorded.",
    );
  }
  console.log(moved.length ? `\n  moved:\n${moved.join("\n")}` : "\n  nothing moved");
  console.log("");
  // "Were those failures stalls or wrong answers?" is a question about a report
  // that already exists, and it should not cost a model run to answer.
  printStalls(out);
  console.log(`\n  ${(report.score.overall * 100).toFixed(1)}% → ${(out.score.overall * 100).toFixed(1)}%  overall\n`);

  if (outFlag !== -1 && argv[outFlag + 1]) {
    writeFileSync(resolve(argv[outFlag + 1]), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`  written to ${argv[outFlag + 1]}\n`);
  }
  return 0;
}

/**
 * `eval bench` — sweep a simulation's baseline policies and print the ladder.
 *
 * The cheapest and most important command in this package. It calls no model,
 * runs in milliseconds, and answers the one question that decides whether any
 * agent number from that simulation means anything: **does the economy have a
 * gradient?** If a random policy and a competent one score the same, there are
 * no decisions in the world and every figure a model run produces afterwards is
 * noise wearing a dollar sign.
 *
 * It is also what turns an agent's score into a statement. "$1.31M" says
 * nothing. "$1.31M, between the set-and-forget baseline at $829K and textbook
 * operations at $1.24M" says exactly where a framework sits.
 *
 * Three separate builds of the factory economy were caught by this command
 * before a single model call: a machine ceiling below baseline demand, a
 * warehouse too small to hold the cheap supplier's lead time, and a horizon so
 * short that the random policy won outright.
 */
function cmdBench(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      simulation: { type: "string", default: "factory" },
      seeds: { type: "string", default: "60" },
      days: { type: "string" },
      "days-per-round": { type: "string" },
      // Anything a simulation reads off its options bag, layered over the
      // configuration the simulation says it is played at. A ladder swept at a
      // different configuration is not a weaker measurement of the same game, it
      // is a measurement of a different one — which is how a pacing defect that
      // only appears deep stayed invisible.
      "sim-option": { type: "string", multiple: true },
      // Sweep the constructor's bare defaults instead. Only useful for asking
      // what a knob is worth, and the header says which mode produced the table.
      "raw-options": { type: "boolean", default: false },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const name = values.simulation as string;
  const policies = simulationPolicies(name);
  if (!Object.keys(policies).length) {
    console.error(`No baseline policies for "${name}". Known simulations: ${listSimulations().join(", ") || "(none)"}`);
    return 2;
  }
  const count = Number(values.seeds);
  const seeds = Array.from({ length: count }, (_, i) => 1000 + i);
  const days = values.days ? Number(values.days) : undefined;
  const stride = values["days-per-round"] ? Number(values["days-per-round"]) : 1;

  // Start from the configuration the simulation declares it is played at, so a
  // bare `bench` reproduces the ladder in the docs. `--sim-option startFloor=31`
  // still wins, because asking what one knob is worth is the other real use of
  // this command. Numbers stay numbers; everything else is passed through as a
  // string, because a simulation's options bag is opaque to this command by
  // design.
  const played = values["raw-options"] ? {} : simulationDefaults(name);
  const simOptions: Record<string, unknown> = { ...played };
  for (const pair of (values["sim-option"] as string[] | undefined) ?? []) {
    const at = pair.indexOf("=");
    if (at < 0) {
      console.error(`  --sim-option wants key=value, got "${pair}".`);
      return 2;
    }
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    simOptions[key] = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    const bad = unknownSimOptions(name, [key]);
    if (bad.length > 0) {
      const { suggestion } = bad[0];
      console.error(
        `  --sim-option "${key}" is not a knob of the "${name}" simulation` +
          `${suggestion ? `. Did you mean "${suggestion}"?` : "."}`,
      );
      console.error(`  knobs: ${simulationKnobs(name).join(", ")}`);
      return 2;
    }
  }

  const report = simulationReport(name);
  const summaries = Object.entries(policies).map(([, make]) =>
    summarise(sweep(name, make(), seeds, days, stride, simOptions), report),
  );
  const opening = createSimulation(name, {
    seed: seeds[0],
    ...(days === undefined ? {} : { days }),
    ...simOptions,
  }).objective();

  console.log(
    `\n  ${name} — ${seeds.length} seeds${days ? `, ${days} days` : ""}${stride > 1 ? `, one round per ${stride} days` : ""}` +
      `${
        Object.keys(simOptions).length
          ? `\n  options ${Object.entries(simOptions)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ")}` +
            `\n  ${values["raw-options"] ? "constructor defaults — NOT the configuration the scenario plays" : "as the scenario plays it"}`
          : ""
      }` +
      `\n  opening ${report.key} ${(report.format ?? ((n: number) => Math.round(n).toLocaleString("en-US")))(opening)}\n`,
  );
  console.log(formatSweep(summaries, report));

  const { spread, ordered } = gradient(summaries);
  console.log(
    `\n  spread ${Math.round(spread).toLocaleString("en-US")} between the weakest and strongest baseline` +
      `${ordered ? "" : " (the listed order is not monotonic — expected where a baseline is a deliberate trap)"}\n`,
  );
  if (spread <= 0) {
    console.error("  No gradient: every policy scored the same. Any agent number from this simulation is noise.\n");
    return 1;
  }
  if (values.out) {
    writeFileSync(
      resolve(values.out as string),
      JSON.stringify({ simulation: name, seeds, days, stride, summaries }, null, 2),
    );
    console.log(`  written to ${values.out}\n`);
  }
  return 0;
}

/**
 * `eval demo` — cut one run down to what a page can render.
 *
 * The demonstration pages on the site show what a team actually did, and the
 * only way that stays true is for the page to read a build artifact taken from a
 * real report rather than figures somebody typed in. Regenerate, commit, and the
 * page renders whatever the run did.
 */
function cmdDemo(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { scenario: { type: "string" }, run: { type: "string" }, out: { type: "string" } },
    allowPositionals: true,
  });
  const report = positionals[0];
  if (!report || !values.scenario) {
    console.error("usage: eval demo <report.json> --scenario <id> [--run <index>] [--out <file>]");
    return 2;
  }
  const demo = extractDemo(resolve(report), values.scenario as string, Number(values.run ?? 0));
  const json = JSON.stringify(demo, null, 2);
  if (values.out) {
    const path = resolve(values.out as string);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${json}\n`);
    console.log(
      `  ${demo.scenario}: ${demo.turns.length} turns, ${demo.calls.length} calls → ${values.out} (${Math.round(json.length / 1024)} kB)`,
    );
  } else {
    console.log(json);
  }
  return 0;
}

/**
 * `eval prove` — search a puzzle's whole state graph and say whether it holds up.
 *
 * The equivalent of `bench` for a scenario with a win condition instead of a
 * balance sheet, and it answers the two questions that decide whether a puzzle
 * is worth running a model against: can a team get into a state it can never
 * recover from, and can a team win without understanding anything. Both are
 * free to check and both are invisible from a transcript, which is why they
 * belong in a command rather than in an author's head.
 *
 * Exits non-zero on a soft-lock or an unreachable goal, so CI can hold the line.
 */
function cmdProve(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { puzzle: { type: "string", default: "lock" }, rounds: { type: "string", default: "12" } },
    allowPositionals: false,
  });
  const horizon = Number(values.rounds);
  const puzzles: Record<string, () => { system: TransitionSystem<never>; ladder: () => string }> = {
    lock: () => ({
      system: lockSystem() as unknown as TransitionSystem<never>,
      ladder: () => formatLadder(lockLadder(horizon)),
    }),
  };
  const make = puzzles[values.puzzle as string];
  if (!make) {
    console.error(`No puzzle "${values.puzzle}". Known: ${Object.keys(puzzles).join(", ")}`);
    return 2;
  }

  const { system, ladder } = make();
  const proof = prove(system, { horizon });
  console.log(`\n${formatProof(values.puzzle as string, proof)}\n`);
  console.log(`  solvers (horizon ${horizon})`);
  console.log(ladder());
  console.log("");

  if (proof.softLocks.length) {
    console.error("  A team can reach a state it cannot recover from. Fix the puzzle before running a model at it.\n");
    return 1;
  }
  if (proof.minRounds === null) {
    console.error("  The goal is not reachable at all inside the horizon.\n");
    return 1;
  }
  if (proof.blindRate > 0.02) {
    console.error(
      `  A blind player wins ${(proof.blindRate * 100).toFixed(1)}% of the time — this measures persistence, not understanding.\n`,
    );
    return 1;
  }
  return 0;
}

/**
 * Everything that is not `run`.
 *
 * A table rather than a chain of `if`s so that the two places a subcommand can
 * appear stay in step. See `main` for why there are two.
 */
const SUBCOMMANDS: Record<string, (argv: string[]) => number | Promise<number>> = {
  compare: cmdCompare,
  regrade: cmdRegrade,
  bench: cmdBench,
  demo: cmdDemo,
  prove: cmdProve,
  watch: cmdWatch,
  narrate: cmdNarrate,
  rehearse: cmdRehearse,
};

/**
 * `eval rehearse` — a trace from a bot, for developing the broadcast against.
 *
 * A real run of `the-endless-descent` is two hundred agent turns and about
 * fifty minutes. Iterating on a viewer against that is not iteration, it is one
 * attempt an hour. A baseline plays the same simulation through the same public
 * API and writes the same trace format in under a second.
 *
 * Output goes to `results/rehearsals/`, never `results/traces/`: the scoreboard
 * scans the traces directory, and a bot's score sitting there as a record would
 * be a lie about what any agent has ever done.
 */
/**
 * Cut a scenario short, for an experiment rather than a measurement.
 *
 * A forty-round descent is about an hour of model time, which is the right cost
 * for a score and far too much for a question like "does the agent read this at
 * all". Eight rounds answers that for a tenth of the bill, and the failure it is
 * looking for shows up in the first three.
 *
 * `n`, not `min(step.rounds, n)`, and the difference cost a four-hour run.
 *
 * The horizon was set to `n` unconditionally while the roster was only ever
 * *shortened*, so `--rounds 60` against a scenario declaring 40 produced a sim
 * that ran 60 ticks and agents that stopped at 40. The last twenty rounds were
 * played by nobody — and because `finishSimulationTrace` runs a simulation on
 * to its horizon under the last decisions made, an unattended party stood in a
 * dungeon and was eaten. The trace shows five characters at full health on tick
 * 39 and five corpses on tick 55, with no rounds in between.
 *
 * The two numbers describe one thing and have to move together. Raising the
 * roster past the authored value deliberately bypasses the schema ceiling,
 * which governs what an author may write down rather than what an operator may
 * ask for at a command line.
 *
 * Deliberately not a scenario option. A shortened run is **not comparable** to a
 * full one — fewer rounds means less experience, so every `sim_metric`
 * threshold and the whole baseline ladder are measuring a different game — and
 * the trace records the clamped horizon so nothing downstream can mistake one
 * for the other. It exists to iterate, never to publish.
 */
export function clampRounds(scenario: Scenario, rounds: number): Scenario {
  const n = Math.max(1, Math.floor(rounds));
  const wake = scenario.wake;
  const list = wake ? (Array.isArray(wake) ? wake : [wake]) : [];
  return {
    ...scenario,
    ...(scenario.simulation ? { simulation: { ...scenario.simulation, days: n } } : {}),
    ...(list.length ? { wake: list.map((step) => ("agents" in step ? { ...step, rounds: n } : step)) } : {}),
  };
}

/**
 * Layer `--sim-option k=v` over a scenario's declared simulation options.
 *
 * Values arrive as strings, which every simulation constructor already copes
 * with — the flag has no schema to convert against, and inventing one here
 * would put a copy of each simulation's option types in the CLI.
 */
function withSimOptions(scenario: Scenario, overrides: Record<string, unknown>): Scenario {
  if (!scenario.simulation) return scenario;
  return {
    ...scenario,
    simulation: { ...scenario.simulation, options: { ...(scenario.simulation.options ?? {}), ...overrides } },
  };
}

/** `--traitors 0|1|2|roll`, for rehearsing the control arm against the rolled one. */
function parseTraitors(raw: string): number | "roll" {
  return raw === "roll" ? "roll" : Number(raw);
}

async function cmdRehearse(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      // No default: each dungeon has its own ladder, so the right rung depends
      // on `--simulation`, which is resolved below.
      policy: { type: "string" },
      simulation: { type: "string" },
      traitors: { type: "string" },
      "hide-traitors": { type: "boolean", default: false },
      seed: { type: "string", default: "1000" },
      rounds: { type: "string", default: "40" },
      "start-floor": { type: "string" },
      // These default ON, to the configuration the scenario plays. They used to
      // default off, and a rehearsal with no maze has a null `floorMap` for the
      // whole run — no floor graph, no room movement, no locks, no gates. Two
      // separate pieces of viewer work were verified against that trace before
      // anybody noticed, which is a bad default rather than a missing warning.
      "no-maze": { type: "boolean", default: false },
      "no-preparation": { type: "boolean", default: false },
      "sim-option": { type: "string", multiple: true },
      out: { type: "string" },
    },
    allowPositionals: false,
  });

  const which = (values.simulation as string | undefined) ?? "descent";
  const known = simulationPolicies(which);
  if (Object.keys(known).length === 0) {
    console.error(`unknown simulation "${which}". Known: ${listSimulations().join(", ")}`);
    return 2;
  }
  // Each dungeon has its own ladder, so the default rung has to come from the
  // one being played: `descent-betrayed` has no `rule-based` row at all.
  const policy = (values.policy as string | undefined) ?? (which === "descent-betrayed" ? "loyal-party" : "rule-based");
  if (!known[policy]) {
    console.error(`${which} has no policy "${policy}". Known: ${Object.keys(known).join(", ")}`);
    return 2;
  }

  // Checked against the simulation's declared knobs, exactly as `run` and
  // `bench` do. A rehearsal is the cheap arm of an experiment and an unread
  // option here silently measures the wrong one — which is precisely what
  // happened before this block existed.
  const simOptions: Record<string, unknown> = {};
  for (const pair of (values["sim-option"] as string[] | undefined) ?? []) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      console.error(`  --sim-option wants key=value, got "${pair}".`);
      return 2;
    }
    const key = pair.slice(0, at);
    const raw = pair.slice(at + 1);
    simOptions[key] = raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  const badOptions = unknownSimOptions(which, Object.keys(simOptions));
  if (badOptions.length > 0) {
    for (const { key, suggestion } of badOptions) {
      console.error(
        `  --sim-option "${key}" is not a knob of the "${which}" simulation` +
          `${suggestion ? `. Did you mean "${suggestion}"?` : "."}`,
      );
    }
    return 2;
  }

  const played = simulationDefaults(which) as {
    startFloor?: number;
    maze?: boolean;
    preparation?: boolean;
    traitors?: number | "roll";
  };

  const out =
    (values.out as string | undefined) ?? join(packageRoot, "results", "rehearsals", `${which}-${policy}.ndjson`);
  const result = await rehearse({
    out,
    policy,
    simulation: which,
    seed: Number(values.seed),
    rounds: Number(values.rounds),
    startFloor: values["start-floor"] ? Number(values["start-floor"]) : (played.startFloor ?? 1),
    maze: values["no-maze"] ? false : (played.maze ?? true),
    preparation: values["no-preparation"] ? false : (played.preparation ?? true),
    ...(values.traitors === undefined ? {} : { traitors: parseTraitors(String(values.traitors)) }),
    ...(values["hide-traitors"] ? { revealTraitors: false } : {}),
    ...(Object.keys(simOptions).length ? { simOptions } : {}),
  });

  console.log(
    `\n  ${out.replace(`${packageRoot}/`, "")}` +
      `\n  ${result.turns} turns, reached floor ${result.floor}, earned ${result.earned.toLocaleString()}` +
      `\n\n  watch it: pnpm run eval -- watch --trace ${out.replace(`${packageRoot}/`, "")}\n`,
  );
  return 0;
}

/**
 * `eval narrate` — commentary on a run, from outside it.
 *
 * A separate command rather than a flag on `run`, and that is a correctness
 * decision rather than an ergonomic one. The narrator is a model; wiring it
 * into a run would put an observer's tokens and latency inside the thing being
 * measured, and a benchmark figure taken while somebody was watching would stop
 * being comparable with one taken in private. It reads the trace and writes a
 * sidecar; the run cannot tell whether it is running.
 */
async function cmdNarrate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      trace: { type: "string" },
      home: { type: "string" },
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key-env": { type: "string" },
      temperature: { type: "string" },
      rounds: { type: "string" },
    },
    allowPositionals: false,
  });

  const tracePath = (values.trace as string | undefined) ?? newestTrace();
  if (!tracePath) {
    console.error("no trace to narrate. Start a run, or pass --trace <file>.");
    return 2;
  }

  const defaults = values.home ? readInstanceDefaults(resolve(values.home as string)) : {};
  const baseUrl = (values["base-url"] as string) ?? defaults.baseUrl ?? "http://127.0.0.1:8000/v1";
  const model = (values.model as string) ?? defaults.model;
  if (!model) {
    console.error("no model. Pass --model <id>, or --home <dir> to read one from a deployment.");
    return 2;
  }
  const apiKey = values["api-key-env"] ? process.env[values["api-key-env"] as string] : undefined;

  console.log(`
  narrating ${tracePath.replace(`${packageRoot}/`, "")}`);
  console.log(`  as ${model} via ${baseUrl}`);
  console.log(`  writing ${tracePath.replace(/\.ndjson$/, ".narration.ndjson").replace(`${packageRoot}/`, "")}\n`);

  const spoken = await narrate({
    tracePath,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(values.temperature ? { temperature: Number(values.temperature) } : {}),
    ...(values.rounds ? { maxRounds: Number(values.rounds) } : {}),
    onLine: (line, round) => console.log(`  ${String(round).padStart(3)}  ${line}`),
    onNote: (note) => console.log(`  --   ${note}`),
  });

  console.log(`\n  ${spoken} line(s) of commentary.\n`);
  return 0;
}

/**
 * `eval watch` — open a live view of the newest run.
 *
 * Deliberately has no idea whether a run is in progress. It serves whatever
 * trace is newest, and the page says whether anything is still being appended
 * to it — so the same command is "watch this run" and "read the last one".
 */
async function cmdWatch(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      trace: { type: "string" },
      port: { type: "string", default: "4380" },
      host: { type: "string", default: "127.0.0.1" },
    },
    allowPositionals: false,
  });
  const path = values.trace ? resolve(values.trace as string) : newestTrace();
  if (!path) {
    console.error("No trace found. Start a run — traces are written by default — or pass --trace <file>.");
    return 2;
  }
  const url = await serveWatch(values.trace ? path : undefined, Number(values.port), values.host as string);
  console.log(`\n  watching ${path.replace(`${packageRoot}/`, "")}`);
  console.log(`  ${url}\n`);
  console.log("  Ctrl-C to stop.\n");
  // Never resolves: the server is the command.
  return await new Promise<number>(() => {});
}

async function main(): Promise<void> {
  const argv = stripSeparator(process.argv.slice(2));
  let [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  // `pnpm run eval` expands to `tsx src/cli.ts run`, so every documented
  // subcommand invocation — `pnpm run eval -- bench` — arrives here as
  // `run bench`, and used to fall through to `cmdRun`, which reported the
  // subcommand's own flags as unknown options. Both `bench` and `demo` shipped
  // documented and unreachable by the only route the docs give for them.
  if (command === "run" && rest[0] && rest[0] in SUBCOMMANDS) {
    command = rest[0];
    rest = rest.slice(1);
  }
  const sub = SUBCOMMANDS[command];
  if (sub) {
    process.exitCode = await sub(rest);
    return;
  }
  process.exitCode = await cmdRun(command === "run" ? rest : argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
