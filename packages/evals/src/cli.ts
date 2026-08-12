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
import { describeDifficulty } from "./difficulty.js";
import { grade } from "./graders.js";
import type { HarnessOptions } from "./harness.js";
import { PAYLOAD_FILENAME, readWorkerResult } from "./protocol.js";
import { printScenario, printSummary, score, verdict } from "./report.js";
import { loadScenarios } from "./schema.js";
import type { BenchmarkReport, CheckResult, RunOutcome, Scenario, ScenarioResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const USAGE = `
tai evals — scenario benchmark for the invocation message

  pnpm run eval -- --model <id> [options]
  pnpm run eval:compare -- <before.json> <after.json>
  pnpm run eval -- regrade <report.json> [--out <file>]   re-score a finished run
                                                          against today's assertions,
                                                          with no model calls

Options
  --target <name>       Load flag defaults from targets/<name>.json (explicit flags still win)
  --home <dir>          Read baseUrl / model / sampling from a real instance's config.yaml
  --base-url <url>      OpenAI-compatible endpoint (default http://127.0.0.1:8000/v1)
  --model <id>          Model to benchmark (required unless --home supplies one)
  --repeats <n>         Runs per scenario (default 3). The score is a pass rate over these.
  --concurrency <n>     Scenarios in flight (default 4)
  --filter <s>          Only scenarios whose id contains <s>, or whose category is <s>
  --difficulty <spec>   Only scenarios at these levels: 4, 4+, 2-3, 3,5. Composes with --filter.
  --seed <n>            Base seed; repeat i uses seed+i (default 1000). --seed off to disable.
  --pinned-at <iso>     Instant every scenario resolves civil time against
                        (default a fixed Wednesday). --pinned-at off uses the host clock.
  --time-zone <iana>    Zone the pinned clock reports (default America/Los_Angeles).
  --temperature <n>     Default 0.3
  --max-tokens <n>      Default 2048; 'off' sends no cap (some hosted models reject it)
  --max-tool-rounds <n> Default 6
  --keep-prompts        Store full prompt text on every run so \`regrade\` can
                        re-score it completely (bigger report)
  --timeout <ms>        Per model call (default 300000)
  --thinking <level>    off | auto | low | medium | high (default: the provider's)
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
  --dry-run             Validate scenarios and print the plan; call no model
  --verbose             Stream worker stderr
`;

/** How much worker stdout to keep, purely to explain a worker that died. */
const TAIL_CHARS = 2000;

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

type Flags = Record<string, string | boolean | undefined>;

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
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-payload-"));
  const payloadPath = join(dir, PAYLOAD_FILENAME);
  writeFileSync(payloadPath, JSON.stringify({ scenario, options, repeats, judge, keepPrompts }));

  return await new Promise<ScenarioResult>((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "worker.ts"), payloadPath], {
      cwd: packageRoot,
      // The worker logs freely to stdout, so it is drained rather than inherited
      // — an unread pipe fills at 64 KB and blocks the worker on its next log
      // line. Only the tail is kept, and only to explain a worker that died.
      stdio: ["ignore", "pipe", verbose ? "inherit" : "ignore"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let tail = "";
    child.stdout.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-TAIL_CHARS);
    });

    // Backstop for a worker wedged somewhere other than a model call, which the
    // per-call timeout cannot see. Generous on purpose: it is here so a batch
    // finishes, not to bound a slow scenario.
    const budget = repeats * (options.maxToolRounds + 2) * options.timeoutMs;
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
    child.on("close", (code) => {
      clearTimeout(kill);
      const outcome = readWorkerResult(dir, code, tail);
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
      seed: { type: "string" },
      "pinned-at": { type: "string" },
      "time-zone": { type: "string" },
      temperature: { type: "string" },
      "max-tokens": { type: "string" },
      "max-tool-rounds": { type: "string" },
      timeout: { type: "string" },
      "thinking-dialect": { type: "string" },
      thinking: { type: "string" },
      "provider-extra": { type: "string" },
      plugins: { type: "string" },
      provider: { type: "string" },
      "api-key-env": { type: "string" },
      judge: { type: "boolean" },
      "keep-prompts": { type: "boolean" },
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
    maxToolRounds: values["max-tool-rounds"] ? Number(values["max-tool-rounds"]) : 6,
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
  };

  if (!options.model) {
    console.error("A model is required: pass --model <id>, or --home <dir> to take it from a config.yaml.");
    return 2;
  }

  const scenarioDir = values.scenarios ? resolve(values.scenarios) : join(packageRoot, "scenarios");
  const { scenarios, hash, fingerprints } = loadScenarios(scenarioDir, values.filter, values.difficulty);
  if (!scenarios.length) {
    const narrowed = [
      values.filter ? `filter "${values.filter}"` : "",
      values.difficulty ? `difficulty "${values.difficulty}"` : "",
    ].filter(Boolean);
    console.error(`No scenarios matched${narrowed.length ? ` ${narrowed.join(" + ")}` : ""} in ${scenarioDir}.`);
    return 2;
  }

  const repeats = Number(values.repeats ?? 3);
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

  let done = 0;
  const results = await pool(scenarios, concurrency, async (scenario) => {
    const result = await runWorker(
      scenario,
      options,
      scenario.repeats ?? repeats,
      !!values.judge,
      !!values.verbose,
      !!values["keep-prompts"],
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
      thinking: options.thinking ?? null,
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
  const { scenarios } = loadScenarios(join(packageRoot, "scenarios"));
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
      const checks = await grade(scenario, run.outcome);
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
      const gradable = checks.filter((c) => !unreadable.has(c.kind));
      skipped += checks.length - gradable.length;
      runs.push({ ...run, pass: gradable.every((c: CheckResult) => c.pass), checks: gradable });
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
  console.log(`\n  ${(report.score.overall * 100).toFixed(1)}% → ${(out.score.overall * 100).toFixed(1)}%  overall\n`);

  if (outFlag !== -1 && argv[outFlag + 1]) {
    writeFileSync(resolve(argv[outFlag + 1]), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`  written to ${argv[outFlag + 1]}\n`);
  }
  return 0;
}

async function main(): Promise<void> {
  const argv = stripSeparator(process.argv.slice(2));
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "compare") {
    process.exitCode = cmdCompare(rest);
    return;
  }
  if (command === "regrade") {
    process.exitCode = await cmdRegrade(rest);
    return;
  }
  process.exitCode = await cmdRun(command === "run" ? rest : argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
