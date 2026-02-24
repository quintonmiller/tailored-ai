import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

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
