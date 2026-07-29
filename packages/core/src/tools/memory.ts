import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureContextDir } from "../context.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

const FILENAME_RE = /^[a-zA-Z0-9_-]+\.md$/;
const MAX_SEARCH_OUTPUT = 3000;
/**
 * Where a scope-less write goes when the session has no agent identity.
 * A sibling of `global/`, so `loadAllContext` — which reads `global/` and
 * `agents/<name>/` — never picks it up.
 */
const UNSCOPED_DIR = "unscoped";

type Scope = "global" | "profile" | "knowledge";

function sanitizeFilename(name: string): string | null {
  const base = basename(name);
  return FILENAME_RE.test(base) ? base : null;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

export class MemoryTool implements Tool {
  name = "memory";
  description =
    "Save or retrieve persistent notes and knowledge base files. Use search with scope knowledge to find reference material.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "write", "append", "search"],
        description: "list, read, write (replace), append, or search files.",
      },
      file: {
        type: "string",
        description: 'Filename (e.g. "notes.md"). Required for read/write/append.',
      },
      content: {
        type: "string",
        description: "Content to write. Required for write/append.",
      },
      scope: {
        type: "string",
        enum: ["global", "profile", "knowledge"],
        description: "Target scope. knowledge = reference KB files. Default: profile if available, otherwise global.",
      },
      query: {
        type: "string",
        description: "Search query (case-insensitive keyword match). Required for search action.",
      },
    },
    required: ["action"],
  };

  private globalDir: string;

  constructor(globalDir: string) {
    this.globalDir = globalDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    const scope = args.scope as Scope | undefined;
    const agentDir = context.agentContextDir;
    const kbDir = context.kbDir;
    const agentKbDir = context.agentKbDir;

    if (action === "search") {
      const query = (args.query ?? args.content) as string | undefined;
      if (!query) {
        return { success: false, output: "", error: "query is required for search." };
      }
      return this.search(query, scope, agentDir, kbDir, agentKbDir);
    }

    if (action === "list") {
      return this.list(scope, agentDir, kbDir, agentKbDir);
    }

    // Accept common parameter name variations from models
    const rawFilename = (args.file ?? args.filename ?? args.path ?? args.name) as string | undefined;
    const filename = sanitizeFilename(rawFilename ?? "");
    if (!filename) {
      return {
        success: false,
        output: "",
        error: `Invalid filename "${rawFilename ?? ""}". Pass the file parameter with a name like "goals.md".`,
      };
    }

    if (action === "read") {
      return this.read(filename, scope, agentDir, kbDir, agentKbDir);
    }

    if (action === "write") {
      const content = args.content as string;
      if (!content) {
        return { success: false, output: "", error: "content is required for write." };
      }
      return this.write(filename, content, scope, agentDir, kbDir, agentKbDir, context);
    }

    if (action === "append") {
      const content = args.content as string;
      if (!content) {
        return { success: false, output: "", error: "content is required for append." };
      }
      return this.append(filename, content, scope, agentDir, kbDir, agentKbDir, context);
    }

    return { success: false, output: "", error: `Unknown action "${action}".` };
  }

  private async list(
    scope: Scope | undefined,
    agentDir?: string,
    kbDir?: string,
    agentKbDir?: string,
  ): Promise<ToolResult> {
    const lines: string[] = [];

    if (!scope || scope === "global") {
      const globalFiles = await listDir(this.globalDir);
      for (const f of globalFiles) lines.push(`[global] ${f}`);
    }

    if ((!scope || scope === "profile") && agentDir) {
      const profileFiles = await listDir(agentDir);
      for (const f of profileFiles) lines.push(`[profile] ${f}`);
    }

    if (!scope || scope === "knowledge") {
      if (kbDir) {
        const kbFiles = await listDir(kbDir);
        for (const f of kbFiles) lines.push(`[knowledge] ${f}`);
      }
      if (agentKbDir) {
        const profileKbFiles = await listDir(agentKbDir);
        for (const f of profileKbFiles) lines.push(`[knowledge:profile] ${f}`);
      }
    }

    return { success: true, output: lines.length ? lines.join("\n") : "(no files)" };
  }

  private async read(
    filename: string,
    scope: Scope | undefined,
    agentDir?: string,
    kbDir?: string,
    agentKbDir?: string,
  ): Promise<ToolResult> {
    if (scope === "knowledge") {
      return this.readFromKb(filename, kbDir, agentKbDir);
    }

    // Determine which directory to read from
    const defaultDir = this.resolveDefaultDir(scope, agentDir);
    const fallbackDir = scope ? undefined : defaultDir === agentDir ? this.globalDir : agentDir;

    try {
      const content = await readFile(resolve(defaultDir, filename), "utf-8");
      return { success: true, output: content };
    } catch {
      // Try fallback if no explicit scope was given
      if (fallbackDir) {
        try {
          const content = await readFile(resolve(fallbackDir, filename), "utf-8");
          return { success: true, output: content };
        } catch (err) {
          return { success: false, output: "", error: `Failed to read: ${(err as Error).message}` };
        }
      }
      return { success: false, output: "", error: `File not found: ${filename}` };
    }
  }

  private async readFromKb(filename: string, kbDir?: string, agentKbDir?: string): Promise<ToolResult> {
    // Try profile KB first, then global KB
    for (const dir of [agentKbDir, kbDir]) {
      if (!dir) continue;
      try {
        const content = await readFile(resolve(dir, filename), "utf-8");
        return { success: true, output: content };
      } catch {
        // try next
      }
    }
    return { success: false, output: "", error: `File not found in knowledge base: ${filename}` };
  }

  private async write(
    filename: string,
    content: string,
    scope: Scope | undefined,
    agentDir?: string,
    kbDir?: string,
    agentKbDir?: string,
    context?: ToolContext,
  ): Promise<ToolResult> {
    if (scope === "knowledge") {
      const targetDir = agentKbDir ?? kbDir;
      if (!targetDir) {
        return { success: false, output: "", error: "No knowledge base directory configured." };
      }
      return this.writeToDir(filename, content, targetDir, "knowledge", [kbDir, agentKbDir]);
    }

    const targetDir = this.resolveDefaultDir(scope, agentDir);
    const label = this.labelFor(targetDir, agentDir);
    this.noteGlobalWrite(label, filename, scope, context);
    return this.writeToDir(filename, content, targetDir, label, [this.globalDir, agentDir, targetDir]);
  }

  /**
   * A write to the global directory changes every agent's prompt. Say so.
   *
   * Not blocked — an agent curating shared knowledge is a legitimate thing to
   * want, and whether it is allowed is a permissions question, not something to
   * hardcode here. But it happened silently, which is how a queue of answered
   * questions came to be read by 27 agents on every turn for two months. The
   * point is that it stops being invisible.
   *
   * `scope === undefined` is called out separately because that path is not a
   * choice the model made: with no agent context directory, an unscoped
   * "profile" write falls through to global. The agent asked for its own notes
   * and wrote to everyone's.
   */
  private noteGlobalWrite(label: string, filename: string, scope: Scope | undefined, context?: ToolContext): void {
    if (label !== "global") return;
    const who = context?.agentName ?? "an un-named session";
    const how = scope === "global" ? "explicitly" : "by falling back from profile scope (no agent context dir)";
    console.warn(
      `[memory] ${who} wrote ${filename} to GLOBAL context ${how}. ` +
        `Every agent reads this on every turn — check it is meant to be shared, and that it is dated.`,
    );
  }

  /**
   * Refuse to write anywhere but this tool's own roots.
   *
   * A containment invariant, deliberately not `checkSandboxBoundary`. The two
   * answer different questions: a boundary asks "may this agent touch this part
   * of the filesystem", and three live agents have one pointing at a research
   * folder that has nothing to do with where their notes live — checking it
   * here would reject every legitimate memory write they make. This asks the
   * narrower question the tool can actually answer: is the target inside a
   * directory this tool owns?
   *
   * Cheap, and it closes a real gap. `memory` never checked anything, while
   * `scope: "global"` writes into the directory injected into every agent's
   * prompt on every turn.
   */
  private withinOwnRoots(target: string, roots: Array<string | undefined>): boolean {
    const full = resolve(target);
    return roots.some((root) => {
      if (!root) return false;
      const base = resolve(root);
      return full === base || full.startsWith(`${base}/`);
    });
  }

  private async writeToDir(
    filename: string,
    content: string,
    dir: string,
    label: string,
    roots?: Array<string | undefined>,
  ): Promise<ToolResult> {
    const target = resolve(dir, filename);
    if (roots && !this.withinOwnRoots(target, roots)) {
      return {
        success: false,
        output: "",
        error: `Refusing to write outside the memory directories. "${filename}" resolves outside this tool's own roots.`,
      };
    }
    try {
      await ensureContextDir(dir);
      await writeFile(target, content, "utf-8");
      return { success: true, output: `Saved ${filename} [${label}]` };
    } catch (err) {
      return { success: false, output: "", error: `Failed to write: ${(err as Error).message}` };
    }
  }

  private async append(
    filename: string,
    content: string,
    scope: Scope | undefined,
    agentDir?: string,
    kbDir?: string,
    agentKbDir?: string,
    context?: ToolContext,
  ): Promise<ToolResult> {
    if (scope === "knowledge") {
      const targetDir = agentKbDir ?? kbDir;
      if (!targetDir) {
        return { success: false, output: "", error: "No knowledge base directory configured." };
      }
      return this.appendToDir(filename, content, targetDir, "knowledge", [kbDir, agentKbDir]);
    }

    const targetDir = this.resolveDefaultDir(scope, agentDir);
    const label = this.labelFor(targetDir, agentDir);
    this.noteGlobalWrite(label, filename, scope, context);
    return this.appendToDir(filename, content, targetDir, label, [this.globalDir, agentDir, targetDir]);
  }

  private async appendToDir(
    filename: string,
    content: string,
    dir: string,
    label: string,
    roots?: Array<string | undefined>,
  ): Promise<ToolResult> {
    const target = resolve(dir, filename);
    if (roots && !this.withinOwnRoots(target, roots)) {
      return {
        success: false,
        output: "",
        error: `Refusing to write outside the memory directories. "${filename}" resolves outside this tool's own roots.`,
      };
    }
    try {
      await ensureContextDir(dir);
      await appendFile(target, `\n${content}`, "utf-8");
      return { success: true, output: `Appended to ${filename} [${label}]` };
    } catch (err) {
      return { success: false, output: "", error: `Failed to append: ${(err as Error).message}` };
    }
  }

  private async search(
    query: string,
    scope: Scope | undefined,
    agentDir?: string,
    kbDir?: string,
    agentKbDir?: string,
  ): Promise<ToolResult> {
    const dirs: { label: string; dir: string }[] = [];

    // When scope is knowledge or unset, search KB directories
    if (!scope || scope === "knowledge") {
      if (kbDir) dirs.push({ label: "knowledge", dir: kbDir });
      if (agentKbDir) dirs.push({ label: "knowledge:profile", dir: agentKbDir });
    }
    // When scope is global or unset, search global context
    if (!scope || scope === "global") {
      dirs.push({ label: "global", dir: this.globalDir });
    }
    // When scope is profile or unset, search profile context
    if ((!scope || scope === "profile") && agentDir) {
      dirs.push({ label: "profile", dir: agentDir });
    }

    const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const results: string[] = [];
    let totalLength = 0;

    for (const { label, dir } of dirs) {
      const files = await listDir(dir);
      for (const file of files) {
        try {
          const content = await readFile(resolve(dir, file), "utf-8");
          const lines = content.split("\n");
          const matches: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              matches.push(`  L${i + 1}: ${lines[i].slice(0, 120)}`);
            }
          }
          if (matches.length > 0) {
            const entry = `[${label}] ${file} (${matches.length} matches)\n${matches.slice(0, 5).join("\n")}`;
            if (totalLength + entry.length > MAX_SEARCH_OUTPUT) {
              results.push("... (output truncated)");
              return { success: true, output: results.join("\n") };
            }
            results.push(entry);
            totalLength += entry.length;
          }
        } catch {
          // skip unreadable files
        }
      }
    }

    return {
      success: true,
      output: results.length ? results.join("\n") : `No matches for "${query}".`,
    };
  }

  /**
   * Where a write lands.
   *
   * `global` and a resolvable `profile` are the caller's own choice. The third
   * case is the one that bit: a "profile" write from a session with no agent
   * context directory — an un-named CLI run, a Slack message, an API call —
   * used to fall through to the GLOBAL directory. The caller asked for its own
   * notes and got everyone's prompt, silently.
   *
   * The fallback is now a sibling directory that nothing injects. Deliberately
   * a redirect rather than an error: `scope` is optional, and hard-failing an
   * omitted optional parameter to make the model retry with the right enum
   * value is the loop a small local model handles worst. It turns a quiet
   * correctness bug into a loud stall. Same shape as moving the `ask_user`
   * inbox out of `global/` — change where it goes, do not add a gate.
   */
  /** What to call the directory in the result, so "saved" says where. */
  private labelFor(targetDir: string, agentDir?: string): string {
    if (targetDir === this.globalDir) return "global";
    if (agentDir && targetDir === agentDir) return "profile";
    return UNSCOPED_DIR;
  }

  private resolveDefaultDir(scope: Scope | undefined, agentDir?: string): string {
    if (scope === "global") return this.globalDir;
    if (agentDir) return agentDir;
    if (scope === "profile") return resolve(this.globalDir, "..", UNSCOPED_DIR);
    // No scope and no agent identity: not a request to write to every prompt.
    return resolve(this.globalDir, "..", UNSCOPED_DIR);
  }
}
