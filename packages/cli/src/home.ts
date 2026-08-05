import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const DEFAULT_HOME = ".tailored-ai";

export interface HomePaths {
  homeDir: string;
  configPath: string;
  envPath: string;
  dbPath: string;
  contextDir: string;
  kbDir: string;
}

/**
 * Resolve the home directory for tai.
 * Priority: -c flag dirname > TAI_HOME env > ~/.tailored-ai/
 */
export function resolveHomeDir(configOverride?: string): string {
  if (configOverride) {
    return dirname(resolve(configOverride));
  }
  if (process.env.TAI_HOME) {
    return resolve(process.env.TAI_HOME);
  }
  return resolve(homedir(), DEFAULT_HOME);
}

/**
 * Resolve the home directory and publish it as `TAI_HOME` for the rest of the
 * process.
 *
 * `resolveHomeDir` reads `TAI_HOME` but nothing ever wrote it — there was not
 * one assignment in the repo. Core is a library and never sees `-c`, so the
 * modules that isolate per-instance state by reading the variable (the vault
 * key, the workflow secrets key, exec and tool-output scratch, the sandbox
 * scratch allowlist) were blind to it. `tai -c <other home>` got its own
 * config and database while writing its keys and cached output into
 * `~/.tailored-ai`; the giveaway on a live install was `~/.tai/exec-outputs`
 * filling up, which only happens when `TAI_HOME` is unset.
 *
 * Assigning here is what makes `-c` and `TAI_HOME` the same instruction. Call
 * this instead of `resolveHomeDir` at every entry point; `resolveHomeDir`
 * stays pure for callers that only want to know the answer.
 */
export function adoptHomeDir(configOverride?: string): string {
  const homeDir = resolveHomeDir(configOverride);
  process.env.TAI_HOME = homeDir;
  return homeDir;
}

/**
 * Check if setup has been completed (config.yaml exists in home dir).
 */
export function isSetupDone(homeDir: string): boolean {
  return existsSync(resolve(homeDir, "config.yaml"));
}

/**
 * Resolve all standard paths relative to the home directory.
 */
export function resolveHomePaths(homeDir: string): HomePaths {
  return {
    homeDir,
    configPath: resolve(homeDir, "config.yaml"),
    envPath: resolve(homeDir, ".env"),
    dbPath: resolve(homeDir, "agent.db"),
    contextDir: resolve(homeDir, "data", "context"),
    kbDir: resolve(homeDir, "data", "kb"),
  };
}

/**
 * Ensure the home directory structure exists.
 */
export async function ensureHomeStructure(homeDir: string): Promise<void> {
  const dirs = [
    homeDir,
    // The workflow engine watches <home>/workflows and logs an ENOENT warning
    // when it is missing, so every fresh install printed a failure for a
    // directory nothing had been asked to create yet.
    resolve(homeDir, "workflows"),
    resolve(homeDir, "data"),
    resolve(homeDir, "data", "context"),
    resolve(homeDir, "data", "context", "global"),
    resolve(homeDir, "data", "context", "profiles"),
    resolve(homeDir, "data", "kb"),
    resolve(homeDir, "data", "kb", "global"),
    resolve(homeDir, "data", "kb", "profiles"),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}
