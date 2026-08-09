import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { isPathContainedRealpath } from "./path-containment.js";
import { checkSandboxBoundary } from "./sandbox-boundary.js";

/**
 * Read a file, a window at a time.
 *
 * `offset`/`limit` are in **characters**, not lines, because the thing they
 * exist to escape counts characters: a result over `maxToolOutputChars` is cut
 * middle-out, and that cut is a dead end. It is deterministic, so calling again
 * returns the same string and reading the saved copy returns the same string —
 * the elided middle had no route back at all (#466). A character offset is the
 * one unit that lines up with where the cut happened.
 *
 * Line ranges are a real want, and `exec` with `sed -n` serves them where it is
 * enabled. They are not added here: two units on one tool is two ways to
 * describe the same window, and the one that matters for recovery is chars.
 */
export class ReadTool implements Tool {
  name = "read";
  description =
    "Read a file. Large files come back in one window at a time; the result says how to continue from where it stopped.";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read.",
      },
      offset: {
        type: "number",
        description: "Character position to start at. Defaults to 0. Use the number the previous result gave you.",
      },
      limit: {
        type: "number",
        description: "Maximum characters to return. Defaults to as much as fits in one tool result.",
      },
    },
    required: ["path"],
  };

  private allowedPaths: string[];

  constructor(allowedPaths?: string[]) {
    this.allowedPaths = allowedPaths ?? [];
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = args.path as string;
    if (!rawPath) {
      return { success: false, output: "", error: "No path provided." };
    }

    const offset = numeric(args.offset);
    const limit = numeric(args.limit);
    if (offset !== undefined && offset < 0) {
      return { success: false, output: "", error: "offset must be 0 or greater." };
    }
    if (limit !== undefined && limit <= 0) {
      return { success: false, output: "", error: "limit must be greater than 0." };
    }

    const fullPath = isAbsolute(rawPath) ? rawPath : resolve(context.workingDirectory, rawPath);

    const boundaryCheck = checkSandboxBoundary(fullPath, context);
    if (!boundaryCheck.ok) {
      return { success: false, output: "", error: boundaryCheck.error };
    }

    if (this.allowedPaths.length > 0) {
      const allowed = this.allowedPaths.some((p) => isPathContainedRealpath(fullPath, p, context.workingDirectory));
      if (!allowed) {
        return {
          success: false,
          output: "",
          error: `Path "${fullPath}" is not within allowed paths.`,
        };
      }
    }

    try {
      const content =
        context.sandbox && context.sandboxHandle
          ? await context.sandbox.readFile(context.sandboxHandle, fullPath)
          : await readFile(fullPath, "utf-8");
      return { success: true, output: window(content, { path: rawPath, offset, limit, context }) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EISDIR") {
        return {
          success: false,
          output: "",
          error: `"${fullPath}" is a directory, not a file. Use the exec tool (e.g. \`ls\`) to list its contents.`,
        };
      }
      if (code === "ENOENT") {
        return { success: false, output: "", error: `File not found: ${fullPath}` };
      }
      return {
        success: false,
        output: "",
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }
  }
}

/** Tolerates the string a model sends for a number-typed field. */
function numeric(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

/**
 * Room left for the file after the note that will be appended to it.
 *
 * Generous, and deliberately so: undershooting the budget costs a few hundred
 * characters of a window, while overshooting hands the whole result to the
 * middle-out cut and loses the note along with it — the one thing carrying the
 * offset that makes the rest reachable.
 */
const NOTE_RESERVE = 240;

function window(
  content: string,
  args: { path: string; offset?: number; limit?: number; context: ToolContext },
): string {
  const start = Math.min(args.offset ?? 0, content.length);
  const budget = args.context.maxOutputChars;
  // An explicit `limit` is the caller's business. Otherwise take the loop's
  // budget, which is what the result has to survive.
  const span = args.limit ?? (budget && budget > NOTE_RESERVE ? budget - NOTE_RESERVE : undefined);
  const end = span === undefined ? content.length : Math.min(start + span, content.length);
  const slice = content.slice(start, end);

  const notes: string[] = [];
  if (start > 0) notes.push(`Resumed at character ${start.toLocaleString()} of ${content.length.toLocaleString()}.`);
  if (end < content.length) {
    // The exact next call, not a suggestion to page. A model that has to
    // compose the offset itself is a model that will re-issue the same call.
    notes.push(
      `${(content.length - end).toLocaleString()} of ${content.length.toLocaleString()} characters remain — ` +
        `read(path="${args.path}", offset=${end}) continues from here.`,
    );
  }

  return notes.length ? `${slice}\n\n[${notes.join(" ")}]` : slice;
}
