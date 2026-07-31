import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where this instance keeps its state.
 *
 * Core is a library: it never sees `-c`, so `TAI_HOME` is the only channel by
 * which the CLI can tell it which deployment it belongs to. Six places used to
 * answer this question for themselves and they did not agree — some read
 * `TAI_HOME`, some `process.env.HOME`, some `homedir()`, and the two scratch
 * writers fell back to `~/.tai` rather than `~/.tailored-ai`. The result was a
 * home directory that held the config and database while its secrets keys and
 * cached tool output went somewhere else entirely.
 *
 * Everything that needs an instance-scoped path now derives it from here.
 *
 * Read the environment on every call, never at module load. `import` runs a
 * module body before `main()` gets to parse `-c`, so anything that snapshots
 * this into a `const` at import time captures the value from before the CLI
 * published it — the fix would be there and do nothing.
 */
export const DEFAULT_HOME_DIR_NAME = ".tailored-ai";

export function taiHome(): string {
  const fromEnv = process.env.TAI_HOME;
  if (fromEnv) return resolve(fromEnv);
  return resolve(homedir(), DEFAULT_HOME_DIR_NAME);
}

/** `taiHome()` joined with `segments`. */
export function taiHomePath(...segments: string[]): string {
  return join(taiHome(), ...segments);
}

/**
 * Scratch base used before this file existed: `~/.tai`, hardcoded, and shared
 * by every deployment on the machine.
 *
 * Kept only so the sandbox boundary still admits reads of output written
 * there. Truncated tool and exec results hand the model an absolute path to
 * the full text, and those pointers live in session history forever — a
 * boundaried agent re-reading one from last week must not be refused because
 * the write location moved. Nothing writes here anymore.
 */
export function legacyScratchHome(): string {
  return resolve(homedir(), ".tai");
}
