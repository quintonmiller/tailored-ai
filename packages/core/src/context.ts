import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function ensureContextDir(dir: string): Promise<string> {
  const resolved = resolve(dir);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

export async function loadContextFiles(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return "";
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
  if (mdFiles.length === 0) return "";

  const sections: string[] = [];
  for (const file of mdFiles) {
    const content = await readFile(resolve(dir, file), "utf-8");
    sections.push(`## ${file}\n${content.trim()}`);
  }

  return `\n\n<context>\n${sections.join("\n\n")}\n</context>`;
}

/**
 * Which of the global context files an agent should be given.
 *
 * Global context is injected into every turn of every agent, so a file that
 * only one role needs is paid for by all of them. `skipGlobalContext` already
 * let an agent opt out of the lot, but that is usually too blunt: the same
 * directory tends to hold both deployment-wide plumbing an agent does need and
 * material it does not. This narrows the set instead of dropping it.
 *
 * `include` is a whitelist applied first; `exclude` then removes from whatever
 * survived. Both take shell-style globs matched against the file name.
 */
export interface GlobalContextFilter {
  include?: string[];
  exclude?: string[];
}

/** `*` and `?` only — enough for file names, and no dependency. */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/** Apply a filter to a list of file names. Exported so callers can preview it. */
export function selectGlobalFiles(files: string[], filter?: GlobalContextFilter): string[] {
  if (!filter) return files;
  let out = files;
  if (filter.include?.length) {
    const pats = filter.include.map(globToRegExp);
    out = out.filter((f) => pats.some((re) => re.test(f)));
  }
  if (filter.exclude?.length) {
    const pats = filter.exclude.map(globToRegExp);
    out = out.filter((f) => !pats.some((re) => re.test(f)));
  }
  return out;
}

export async function loadAllContext(
  baseDir: string,
  agentContextDir?: string,
  globalFilter?: GlobalContextFilter,
): Promise<string> {
  const globalDir = join(baseDir, "global");
  const sections: string[] = [];

  // Load global context files
  try {
    const entries = await readdir(globalDir);
    const mdFiles = selectGlobalFiles(entries.filter((f) => f.endsWith(".md")).sort(), globalFilter);
    for (const file of mdFiles) {
      const content = await readFile(resolve(globalDir, file), "utf-8");
      sections.push(`## ${file}\n${content.trim()}`);
    }
  } catch {
    // global dir may not exist yet
  }

  // Load agent-specific context files
  if (agentContextDir) {
    try {
      const entries = await readdir(agentContextDir);
      const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
      for (const file of mdFiles) {
        const content = await readFile(resolve(agentContextDir, file), "utf-8");
        sections.push(`## ${file}\n${content.trim()}`);
      }
    } catch {
      // agent dir may not exist yet
    }
  }

  if (sections.length === 0) return "";
  return `\n\n<context>\n${sections.join("\n\n")}\n</context>`;
}

export interface FileStats {
  name: string;
  bytes: number;
}

export interface ContextStats {
  globalContext: FileStats[];
  profileContext: FileStats[];
  globalKb: FileStats[];
  profileKb: FileStats[];
}

async function getFilesWithSizes(dir: string): Promise<FileStats[]> {
  try {
    const entries = await readdir(dir);
    const mdFiles = entries.filter((f) => f.endsWith(".md")).sort();
    const results: FileStats[] = [];
    for (const file of mdFiles) {
      try {
        const s = await stat(resolve(dir, file));
        results.push({ name: file, bytes: s.size });
      } catch {
        // skip unreadable files
      }
    }
    return results;
  } catch {
    return [];
  }
}

export async function getContextStats(
  contextDir: string,
  kbDir: string,
  agentContextDir?: string,
  agentKbDir?: string,
): Promise<ContextStats> {
  const globalDir = join(contextDir, "global");
  const globalKbDir = join(kbDir, "global");

  const [globalContext, profileContext, globalKb, profileKb] = await Promise.all([
    getFilesWithSizes(globalDir),
    agentContextDir ? getFilesWithSizes(agentContextDir) : Promise.resolve([]),
    getFilesWithSizes(globalKbDir),
    agentKbDir ? getFilesWithSizes(agentKbDir) : Promise.resolve([]),
  ]);

  return { globalContext, profileContext, globalKb, profileKb };
}

export async function migrateContextDir(baseDir: string): Promise<void> {
  const globalDir = join(baseDir, "global");

  // Check if global/ already exists — if so, migration is done
  try {
    const s = await stat(globalDir);
    if (s.isDirectory()) return;
  } catch {
    // global/ doesn't exist, check if we need to migrate
  }

  // Check for .md files at the base directory root
  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    return; // base dir doesn't exist, nothing to migrate
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return; // nothing to migrate

  // Create global/ and move all .md files into it
  await mkdir(globalDir, { recursive: true });

  for (const file of mdFiles) {
    const src = join(baseDir, file);
    const dest = join(globalDir, file);
    await rename(src, dest);
  }

  console.log(`[context] Migrated ${mdFiles.length} file(s) from ${baseDir} to ${globalDir}`);
}
