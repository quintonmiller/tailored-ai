import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ensureContextDir } from "../context.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

const FILENAME_RE = /^[a-zA-Z0-9_-]+\.md$/;
const MAX_SEARCH_OUTPUT = 3000;

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
      return this.write(filename, content, scope, agentDir, kbDir, agentKbDir);
    }

    if (action === "append") {
      const content = args.content as string;
      if (!content) {
        return { success: false, output: "", error: "content is required for append." };
      }
      return this.append(filename, content, scope, agentDir, kbDir, agentKbDir);
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
  ): Promise<ToolResult> {
    if (scope === "knowledge") {
      const targetDir = agentKbDir ?? kbDir;
      if (!targetDir) {
        return { success: false, output: "", error: "No knowledge base directory configured." };
      }
      return this.writeToDir(filename, content, targetDir, "knowledge");
    }

    const targetDir = this.resolveDefaultDir(scope, agentDir);
    const label = targetDir === this.globalDir ? "global" : "profile";
    return this.writeToDir(filename, content, targetDir, label);
  }

  private async writeToDir(filename: string, content: string, dir: string, label: string): Promise<ToolResult> {
    try {
      await ensureContextDir(dir);
      await writeFile(resolve(dir, filename), content, "utf-8");
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
  ): Promise<ToolResult> {
    if (scope === "knowledge") {
      const targetDir = agentKbDir ?? kbDir;
      if (!targetDir) {
        return { success: false, output: "", error: "No knowledge base directory configured." };
      }
      return this.appendToDir(filename, content, targetDir, "knowledge");
    }

    const targetDir = this.resolveDefaultDir(scope, agentDir);
    const label = targetDir === this.globalDir ? "global" : "profile";
    return this.appendToDir(filename, content, targetDir, label);
  }

  private async appendToDir(filename: string, content: string, dir: string, label: string): Promise<ToolResult> {
    try {
      await ensureContextDir(dir);
      await appendFile(resolve(dir, filename), `\n${content}`, "utf-8");
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

  private resolveDefaultDir(scope: Scope | undefined, agentDir?: string): string {
    if (scope === "global") return this.globalDir;
    if (scope === "profile" && agentDir) return agentDir;
    // Default: profile dir if available, otherwise global
    return agentDir ?? this.globalDir;
  }
}
