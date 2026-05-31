import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type Database from "better-sqlite3";
import YAML from "yaml";
import { getProject, getProjectByPath, type Project } from "../db/project-queries.js";

export const PROJECT_FILE = ".tai.yaml";

/**
 * Schema of a project's `.tai.yaml` file.
 *
 * `project.id` is set by `tai project init` and is immutable.
 * `config` is an optional overlay merged on top of the global config.yaml
 * (see S7.3). Treated as opaque here — resolver only reads `project`.
 */
export interface ProjectFile {
  project: {
    id: string;
    name?: string;
  };
  config?: Record<string, unknown>;
}

/**
 * Runtime context for an active project. Sessions, tasks, cron, autopilot,
 * and channels carry this through their call paths so behavior scopes per-project.
 */
export interface ProjectContext {
  id: string;
  name: string;
  path: string;
  overlayPath: string;
  overlay: Record<string, unknown>;
}

export interface ResolveOptions {
  /** Working directory to resolve from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Stop walk-up at this directory (inclusive). Defaults to filesystem root. */
  stopAt?: string;
  /** Logger for warnings. Defaults to `console.warn`. */
  warn?: (msg: string) => void;
}

/**
 * Walk up from `cwd` looking for a `.tai.yaml` file.
 * Returns the absolute path of the file and the directory containing it.
 */
export function findProjectFile(cwd: string, stopAt?: string): { file: string; dir: string } | null {
  let current = resolve(cwd);
  const stop = stopAt ? resolve(stopAt) : null;
  while (true) {
    const candidate = resolve(current, PROJECT_FILE);
    if (existsSync(candidate)) return { file: candidate, dir: current };
    if (stop && current === stop) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function readProjectFile(file: string): ProjectFile {
  const text = readFileSync(file, "utf8");
  const parsed = YAML.parse(text) as ProjectFile | null | undefined;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid ${PROJECT_FILE}: expected an object`);
  }
  if (!parsed.project || typeof parsed.project.id !== "string") {
    throw new Error(`Invalid ${PROJECT_FILE}: missing project.id`);
  }
  return parsed;
}

/**
 * Resolve the active project for a given working directory.
 *
 * Priority:
 *   1. Walk up from `cwd` looking for `.tai.yaml`. If found, project_id is read
 *      from the file. The DB row is looked up by id; if the row's `path` doesn't
 *      match the disk location (repo moved/copied), a warning is emitted but the
 *      disk location wins so tools run against the right files.
 *   2. If no `.tai.yaml` found, look up a registered project whose `path` is an
 *      ancestor of `cwd` (covers `tai project add <path>` lazy mode).
 *   3. Otherwise return null (global mode).
 */
export function resolveProjectFromCwd(db: Database.Database, options: ResolveOptions = {}): ProjectContext | null {
  const cwd = resolve(options.cwd ?? process.cwd());
  const warn = options.warn ?? ((msg: string) => console.warn(msg));

  const found = findProjectFile(cwd, options.stopAt);
  if (found) {
    let file: ProjectFile;
    try {
      file = readProjectFile(found.file);
    } catch (err) {
      warn(`[project] Failed to read ${found.file}: ${(err as Error).message}`);
      return null;
    }

    const row = getProject(db, file.project.id);
    if (!row) {
      warn(
        `[project] ${PROJECT_FILE} declares id ${file.project.id} but no such project is registered. ` +
          `Run \`tai project add ${found.dir}\` to register it.`,
      );
      return null;
    }

    if (row.path && resolve(row.path) !== found.dir) {
      warn(`[project] ${PROJECT_FILE} found at ${found.dir} but registered path is ${row.path}. Using disk location.`);
    }

    return {
      id: row.id,
      name: file.project.name ?? row.title,
      path: found.dir,
      overlayPath: found.file,
      overlay: file.config ?? {},
    };
  }

  // Lazy mode: cwd is inside a registered project's path.
  const ancestor = findRegisteredAncestor(db, cwd);
  if (ancestor) {
    return {
      id: ancestor.id,
      name: ancestor.title,
      path: ancestor.path as string,
      overlayPath: "",
      overlay: {},
    };
  }

  return null;
}

/**
 * Look up any registered project whose `path` column is an ancestor of `cwd`.
 * Used as a fallback when no `.tai.yaml` is found on disk.
 */
function findRegisteredAncestor(db: Database.Database, cwd: string): Project | null {
  const absCwd = resolve(cwd);
  let current = absCwd;
  while (true) {
    const hit = getProjectByPath(db, current);
    if (hit?.path) return hit;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Build a `.tai.yaml` payload for `tai project init`.
 */
export function buildProjectFile(input: { id: string; name?: string; config?: Record<string, unknown> }): string {
  const file: ProjectFile = { project: { id: input.id } };
  if (input.name) file.project.name = input.name;
  if (input.config && Object.keys(input.config).length > 0) file.config = input.config;
  return YAML.stringify(file);
}

/**
 * Validate that a path is absolute. Used at registration boundaries to keep
 * the `projects.path` column free of relative entries that would break resolution
 * across `cd` changes.
 */
export function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`Project path must be absolute, got: ${path}`);
  }
}
