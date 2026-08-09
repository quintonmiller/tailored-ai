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
import { printComparison } from "./compare.js";
import type { HarnessOptions } from "./harness.js";
import { RESULT_MARKER } from "./protocol.js";
import { printScenario, printSummary, score } from "./report.js";
import { loadScenarios } from "./schema.js";
import type { BenchmarkReport, Scenario, ScenarioResult } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

const USAGE = `
tai evals — scenario benchmark for the invocation message

  pnpm run eval -- --model <id> [options]
  pnpm run eval:compare -- <before.json> <after.json>

Options
  --target <name>       Load flag defaults from targets/<name>.json (explicit flags still win)
  --home <dir>          Read baseUrl / model / sampling from a real instance's config.yaml
  --base-url <url>      OpenAI-compatible endpoint (default http://127.0.0.1:8000/v1)
  --model <id>          Model to benchmark (required unless --home supplies one)
  --repeats <n>         Runs per scenario (default 3). The score is a pass rate over these.
  --concurrency <n>     Scenarios in flight (default 4)
  --filter <s>          Only scenarios whose id contains <s>, or whose category is <s>
  --seed <n>            Base seed; repeat i uses seed+i (default 1000). --seed off to disable.
  --temperature <n>     Default 0.3
  --max-tokens <n>      Default 2048; 'off' sends no cap (some hosted models reject it)
  --max-tool-rounds <n> Default 6
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
): Promise<ScenarioResult> {
  const dir = mkdtempSync(join(tmpdir(), "tai-eval-payload-"));
  const payloadPath = join(dir, "payload.json");
  writeFileSync(payloadPath, JSON.stringify({ scenario, options, repeats, judge }));

  return await new Promise<ScenarioResult>((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(here, "worker.ts"), payloadPath], {
      cwd: packageRoot,
      // The worker's stdout carries logs as well as the result, so it is read
      // rather than inherited; stderr is only interesting when debugging.
      stdio: ["ignore", "pipe", verbose ? "inherit" : "ignore"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });

    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });

    // Backstop for a worker wedged somewhere other than a model call, which the
    // per-call timeout cannot see. Generous on purpose: it is here so a batch
    // finishes, not to bound a slow scenario.
    const budget = repeats * (options.maxToolRounds + 2) * options.timeoutMs;
    const kill = setTimeout(() => child.kill("SIGKILL"), budget);

    // Identity travels with the result rather than through the worker: the
    // worker grades runs and has no reason to know why a scenario exists.
    const describe = { id: scenario.id, category: scenario.category, intent: scenario.intent };
    const gap = scenario.knownGap ? { knownGap: scenario.knownGap } : {};

    child.on("close", (code) => {
      clearTimeout(kill);
      rmSync(dir, { recursive: true, force: true });
      const line = out.split("\n").find((l) => l.startsWith(RESULT_MARKER));
      if (!line) {
        resolvePromise({
          ...describe,
          ...gap,
          runs: [],
          passRate: 0,
          error: `worker produced no result (exit ${code})`,
        });
        return;
      }
      const parsed = JSON.parse(line.slice(RESULT_MARKER.length));
      if (parsed.error && !parsed.runs) {
        resolvePromise({ ...describe, ...gap, runs: [], passRate: 0, error: parsed.error });
        return;
      }
      resolvePromise({ ...(parsed as ScenarioResult), ...gap });
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
      seed: { type: "string" },
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
  const { scenarios, hash } = loadScenarios(scenarioDir, values.filter);
  if (!scenarios.length) {
    console.error(`No scenarios matched${values.filter ? ` filter "${values.filter}"` : ""} in ${scenarioDir}.`);
    return 2;
  }

  const repeats = Number(values.repeats ?? 3);
  const concurrency = Number(values.concurrency ?? 4);

  if (values["dry-run"]) {
    console.log(
      `${scenarios.length} scenario(s), set ${hash}, ${repeats} repeat(s) → ${scenarios.length * repeats} model turns`,
    );
    for (const s of scenarios) console.log(`  ${s.category.padEnd(16)} ${s.id.padEnd(44)} ${s.expect.length} check(s)`);
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
    const result = await runWorker(scenario, options, scenario.repeats ?? repeats, !!values.judge, !!values.verbose);
    done++;
    process.stdout.write(`[${String(done).padStart(3)}/${scenarios.length}] `);
    if (result.error) console.log(`ERROR  ${result.id}: ${result.error}`);
    else printScenario(result);
    return result;
  });

  const finishedAt = new Date();
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
      judge: !!values.judge,
      scenarioSetHash: hash,
      durationSeconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
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

  const min = values["min-score"] ? Number(values["min-score"]) : null;
  if (min !== null && report.score.overall < min) {
    console.error(`Score ${(report.score.overall * 100).toFixed(1)}% is below --min-score ${(min * 100).toFixed(1)}%.`);
    return 1;
  }
  return 0;
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "compare") {
    process.exitCode = cmdCompare(rest);
    return;
  }
  process.exitCode = await cmdRun(command === "run" ? rest : process.argv.slice(2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
