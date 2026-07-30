import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as YAML from "yaml";
import { type AgentConfig, findUnknownKeys, normalizeRawConfig, validateConfig } from "./config.js";

/**
 * The one door every runtime write to `config.yaml` goes through.
 *
 * Before this existed there were twelve of them — three in the admin tool,
 * seven HTTP routes, a plugin tool, and the setup TUI — each hand-rolling
 * read → mutate → stringify → write → reload with its own idea of what to
 * check first. The strongest checked a YAML round-trip and the agent's tool
 * references; the weakest (`PUT /api/config`) wrote the request body to disk
 * without parsing it at all. Since {@link ConfigWriteHost.reload} swallows its
 * own failures, that route answered `200 {"ok":true}` on unparseable YAML while
 * the process kept running the previous config, and the corruption only
 * surfaced at the next restart.
 *
 * The gap that prompted it: an agent wrote itself a config block with `name:`
 * and `temp:` instead of `temperature:`. Every layer accepted it — the write,
 * the round-trip, the manifest export — and the agent ran at the default
 * temperature for a day. `validateConfig` had detected exactly this since #252;
 * it just ran at startup, into a log, after the fact.
 */

/** The slice of `AgentRuntime` a config write needs. Structural so this module stays cycle-free and testable. */
export interface ConfigWriteHost {
  readonly configPath: string;
  withConfigLock<T>(fn: () => T | Promise<T>): Promise<T>;
  reload(): void;
}

/**
 * A write refused because it would have introduced config that parses but is
 * never read. Carries the individual findings so a caller can render them for
 * whoever is on the other end — an HTTP client, or a model that needs to know
 * which key it got wrong.
 */
export class ConfigWriteRejected extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Config not written — ${issues.length} problem(s) the write would introduce:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigWriteRejected";
    this.issues = issues;
  }
}

export interface ConfigWriteResult {
  /** Non-blocking findings in the resulting config. Worth showing; not worth refusing over. */
  warnings: string[];
}

/** Read and parse the config as it is on disk. Unlike `readRawConfig`, a parse failure is not silently an empty doc. */
function readCurrentRaw(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const content = readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(content) as Record<string, unknown> | null;
  return parsed ?? {};
}

/**
 * Findings the pending config has and the current one did not.
 *
 * Compared rather than absolute on purpose. A deployment accumulates findings
 * that have nothing to do with the next write — a tool whose credential env
 * var isn't exported in this shell, a provider a plugin registers later — and
 * refusing on the total would make a config unwritable for reasons unrelated
 * to the change being made. Comparing by message identity means a write is
 * judged only on what it actually introduces.
 */
function introducedIssues(before: AgentConfig | undefined, after: AgentConfig): string[] {
  const existing = new Set(before ? findUnknownKeys(before) : []);
  return findUnknownKeys(after).filter((issue) => !existing.has(issue));
}

/** Round-trip through the serializer the write will use, so the check sees what lands on disk. */
function serialize(raw: Record<string, unknown>): string {
  const text = YAML.stringify(raw);
  YAML.parse(text);
  return text;
}

/**
 * Apply `mutate` to the parsed config document, validate the result, and write
 * it — or throw {@link ConfigWriteRejected} and leave the file untouched.
 *
 * The existing document is parsed strictly. A patch computed against a config
 * that failed to parse would write the patch over an empty document and drop
 * everything else in the file, which is how `readRawConfig`'s catch-all
 * `return {}` behaves today.
 */
export async function updateRawConfig(
  host: ConfigWriteHost,
  mutate: (raw: Record<string, unknown>) => void,
): Promise<ConfigWriteResult> {
  return host.withConfigLock(() => {
    let current: Record<string, unknown>;
    try {
      current = readCurrentRaw(host.configPath);
    } catch (err) {
      throw new ConfigWriteRejected([
        `${host.configPath} could not be parsed, so a patch cannot be applied without losing its contents ` +
          `(${(err as Error).message}). Fix the file, then retry.`,
      ]);
    }

    const before = normalizeRawConfig(structuredClone(current));
    mutate(current);

    let text: string;
    try {
      text = serialize(current);
    } catch (err) {
      throw new ConfigWriteRejected([`the change produced invalid YAML: ${(err as Error).message}`]);
    }

    const after = normalizeRawConfig(YAML.parse(text) as Record<string, unknown>);
    const introduced = introducedIssues(before, after);
    if (introduced.length > 0) throw new ConfigWriteRejected(introduced);

    writeFileSync(host.configPath, text, "utf-8");
    host.reload();
    return { warnings: validateConfig(after) };
  });
}

/**
 * Replace the whole config file with `text` — the raw-editor path.
 *
 * Parses before writing, which the route this replaces did not do at all.
 * When the file currently on disk is itself unparseable there is no baseline
 * to compare against, so every finding in the incoming text counts as
 * introduced; that is the stricter reading, and it applies only when the
 * config was already broken.
 */
export async function writeRawConfigText(host: ConfigWriteHost, text: string): Promise<ConfigWriteResult> {
  return host.withConfigLock(() => {
    let parsed: Record<string, unknown>;
    try {
      parsed = (YAML.parse(text) as Record<string, unknown> | null) ?? {};
    } catch (err) {
      throw new ConfigWriteRejected([`not valid YAML: ${(err as Error).message}`]);
    }

    let before: AgentConfig | undefined;
    try {
      before = normalizeRawConfig(readCurrentRaw(host.configPath));
    } catch {
      before = undefined;
    }

    const after = normalizeRawConfig(structuredClone(parsed));
    const introduced = introducedIssues(before, after);
    if (introduced.length > 0) throw new ConfigWriteRejected(introduced);

    writeFileSync(host.configPath, text, "utf-8");
    host.reload();
    return { warnings: validateConfig(after) };
  });
}
