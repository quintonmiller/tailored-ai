/**
 * Non-interactive setup — `tai init --non-interactive`.
 *
 * The Ink wizard in setup.ts is the only way to produce a config.yaml today,
 * and it throws TTYError without a terminal. That makes every unattended first
 * run impossible: a container, a cloud-init VM, a CI fixture, and an image
 * baked by `tai deploy` all have to answer the wizard's questions with nobody
 * there to type. This module answers them from flags and environment instead
 * and writes the same files the wizard writes.
 *
 * It shares `renderNewConfig` with the wizard rather than templating its own
 * YAML, so the two paths cannot drift into producing different configs.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DraftConfig } from "./editor/types.js";
import { defaultDraft } from "./editor/types.js";
import { ensureHomeStructure, resolveHomePaths } from "./home.js";
import { isLoopbackHost, renderNewConfig, type ServerRenderOptions } from "./setup.js";

/** Env var the generated config references for the API auth token. */
export const AUTH_TOKEN_ENV_VAR = "TAI_AUTH_TOKEN";

/**
 * Env var that carries the provider API key into the generated config, for the
 * `openai_compatible` provider only. Plugin-registered providers already get a
 * per-provider variable from `renderProviderBlock` (`ANTHROPIC_API_KEY` and
 * friends), which is the convention their docs use.
 */
export const OPENAI_COMPATIBLE_KEY_ENV_VAR = "OPENAI_COMPATIBLE_API_KEY";

export interface HeadlessInitOptions {
  /** Where config.yaml, .env, agent.db and data/ land. */
  homeDir: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Provider API key. Written to .env, never to config.yaml. */
  apiKey?: string;
  host?: string;
  /** Accepts the raw CLI string so a non-numeric value is reported verbatim. */
  port?: number | string;
  /**
   * `undefined` mints one when the bind is non-loopback; a string uses it
   * verbatim; `false` suppresses token generation entirely (the escape hatch
   * for deployments fronted by `server.proxyAuth`, which authenticates ahead
   * of TAI and would find a second token redundant).
   */
  authToken?: string | false;
  /** Serve the bundled web UI. Default true. */
  ui?: boolean;
  /** Overwrite an existing config.yaml instead of refusing. */
  force?: boolean;
  /** Print what would be written and change nothing. */
  dryRun?: boolean;
}

export interface HeadlessInitResult {
  homeDir: string;
  configPath: string;
  envPath: string;
  configContent: string;
  /** `.env` lines this run added. Empty when there was nothing to add. */
  envLines: string[];
  /** Set only when this run minted a token, so the caller can print it once. */
  generatedAuthToken?: string;
  /** True when config.yaml already existed and `force` overwrote it. */
  overwrote: boolean;
}

/** Flag > env > default, skipping blank strings so `TAI_MODEL=` behaves as unset. */
function pick(flag: string | undefined, envVar: string, fallback: string): string {
  if (flag !== undefined && flag !== "") return flag;
  const fromEnv = process.env[envVar];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return fallback;
}

/**
 * Build the draft the renderer consumes. Split out from {@link runHeadlessInit}
 * so tests can assert the resolution rules without touching a filesystem.
 */
export function resolveHeadlessDraft(opts: HeadlessInitOptions): {
  draft: DraftConfig;
  server: ServerRenderOptions;
  authToken?: string;
  generated: boolean;
} {
  const provider = pick(opts.provider, "TAI_PROVIDER", "openai_compatible");
  const baseUrl = pick(opts.baseUrl, "TAI_BASE_URL", "");
  const apiKey = pick(opts.apiKey, "TAI_API_KEY", "");
  const host = pick(opts.host, "TAI_SERVER_HOST", "127.0.0.1");

  const portRaw = pick(opts.port === undefined ? undefined : String(opts.port), "TAI_SERVER_PORT", "3000");
  // parseInt("3000abc") is 3000, which would silently accept a typo'd port.
  if (!/^\d+$/.test(portRaw)) {
    throw new Error(`Invalid port "${portRaw}" — expected an integer between 1 and 65535.`);
  }
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${portRaw}" — expected an integer between 1 and 65535.`);
  }

  // No model default. Guessing one produces a config that passes validation
  // and then fails on the first message with a provider-side 404, which reads
  // as a TAI bug. Better to refuse now and name the flag that fixes it.
  const model = pick(opts.model, "TAI_MODEL", "");
  if (!model) {
    throw new Error(
      "No model specified. Pass --model <name> or set TAI_MODEL.\n" +
        "  Ollama:  --model llama3.2  --base-url http://localhost:11434/v1\n" +
        "  vLLM:    --model <served-model-name>  --base-url http://127.0.0.1:8000/v1\n" +
        "  Hosted:  --provider anthropic --model claude-haiku-4-5 (install the provider plugin first)",
    );
  }

  const draft = defaultDraft(opts.homeDir);
  draft.provider = {
    kind: provider,
    defaultModel: model,
    // `defaultDraft` seeds the Ollama URL. Keep it for openai_compatible,
    // where a base URL is mandatory, and drop it for hosted providers, which
    // supply their own endpoint and would be broken by a localhost override.
    baseUrl: baseUrl || (provider === "openai_compatible" ? draft.provider.baseUrl : undefined),
    apiKey: apiKey || undefined,
  };
  if (opts.ui === false) draft.ui = "disabled";

  // Auth token policy. A non-loopback bind with no auth publishes every
  // session, chat history and tool result to anyone who can route to the port,
  // so the unattended path mints a token rather than leaving that to a
  // config-validation warning nobody reads in a container log.
  let authToken: string | undefined;
  let generated = false;
  if (opts.authToken === false) {
    authToken = undefined;
  } else if (typeof opts.authToken === "string" && opts.authToken !== "") {
    authToken = opts.authToken;
  } else if (process.env[AUTH_TOKEN_ENV_VAR]) {
    authToken = process.env[AUTH_TOKEN_ENV_VAR];
  } else if (!isLoopbackHost(host)) {
    authToken = randomBytes(32).toString("base64url");
    generated = true;
  }

  return {
    draft,
    server: { host, port, authTokenEnvVar: authToken ? AUTH_TOKEN_ENV_VAR : undefined },
    authToken,
    generated,
  };
}

/**
 * Append `lines` to `.env`, skipping any whose `KEY=` is already present.
 *
 * Re-running init after a container restart must not stack duplicate
 * `TAI_AUTH_TOKEN=` lines: dotenv takes the first occurrence, so a duplicate
 * would silently pin the old token while the operator reads the new one off
 * the end of the file.
 */
export function mergeEnvLines(existing: string, lines: string[]): { text: string; added: string[] } {
  const present = new Set(
    existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf("=")))
      .filter(Boolean),
  );
  const added = lines.filter((l) => {
    const key = l.slice(0, l.indexOf("="));
    return key && !present.has(key);
  });
  if (added.length === 0) return { text: existing, added };
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  return { text: `${existing}${sep}${added.join("\n")}\n`, added };
}

export async function runHeadlessInit(opts: HeadlessInitOptions): Promise<HeadlessInitResult> {
  const paths = resolveHomePaths(opts.homeDir);
  const exists = existsSync(paths.configPath);
  if (exists && !opts.force) {
    throw new Error(
      `${paths.configPath} already exists. Pass --force to overwrite, or edit it with \`tai edit\`.\n` +
        "A container entrypoint should skip init when this file is present — that is what makes restarts idempotent.",
    );
  }

  const { draft, server, authToken, generated } = resolveHeadlessDraft(opts);
  const configContent = renderNewConfig(draft, server);

  const envLines: string[] = [];
  if (generated && authToken) envLines.push(`${AUTH_TOKEN_ENV_VAR}=${authToken}`);
  if (draft.provider.apiKey) {
    const envVar =
      draft.provider.kind === "openai_compatible"
        ? OPENAI_COMPATIBLE_KEY_ENV_VAR
        : `${draft.provider.kind.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    envLines.push(`${envVar}=${draft.provider.apiKey}`);
  }

  if (opts.dryRun) {
    console.log(`── Dry run — no files written ──\n`);
    console.log(`Home directory: ${opts.homeDir}`);
    console.log(`\nconfig.yaml (${paths.configPath}):\n`);
    console.log(configContent);
    if (envLines.length > 0) {
      console.log(`.env additions (${paths.envPath}):`);
      // Values are secrets — show the keys only.
      for (const line of envLines) console.log(`  ${line.slice(0, line.indexOf("="))}=<redacted>`);
    }
    console.log(`\nRe-run without --dry-run to apply.`);
    return {
      homeDir: paths.homeDir,
      configPath: paths.configPath,
      envPath: paths.envPath,
      configContent,
      envLines,
      generatedAuthToken: undefined,
      overwrote: false,
    };
  }

  await ensureHomeStructure(opts.homeDir);
  writeFileSync(paths.configPath, configContent, "utf-8");

  let added: string[] = [];
  if (envLines.length > 0) {
    const existing = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf-8") : "";
    const merged = mergeEnvLines(existing, envLines);
    if (merged.added.length > 0) writeFileSync(paths.envPath, merged.text, { encoding: "utf-8", mode: 0o600 });
    added = merged.added;
  }

  console.log(`Setup complete. Data directory: ${opts.homeDir}`);
  console.log(`  config: ${paths.configPath}`);
  console.log(`  provider: ${draft.provider.kind} (${draft.provider.defaultModel})`);
  console.log(`  server: http://${server.host}:${server.port}`);
  if (generated && authToken && added.some((l) => l.startsWith(`${AUTH_TOKEN_ENV_VAR}=`))) {
    console.log(
      `\n  API auth token (generated, stored in ${paths.envPath}):\n` +
        `    ${authToken}\n` +
        `  Every /api/* request must send \`Authorization: Bearer <token>\`.\n` +
        `  For browser access, set server.proxyAuth instead: it mints a session\n` +
        `  cookie, which the dashboard's SSE streams can carry. See docs/self-hosting.md.\n` +
        `  This is the only time the token is printed.`,
    );
  }

  return {
    homeDir: paths.homeDir,
    configPath: paths.configPath,
    envPath: paths.envPath,
    configContent,
    envLines: added,
    generatedAuthToken: generated ? authToken : undefined,
    overwrote: exists,
  };
}
