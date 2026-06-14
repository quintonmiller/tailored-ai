import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { isPathContainedRealpath } from "./path-containment.js";
import { checkSandboxBoundary } from "./sandbox-boundary.js";

/**
 * Surgical, exact-match file edit. Replaces `old_string` with `new_string` in an
 * existing file without the agent having to regenerate the whole file (the gap
 * that made `write` impractical for large existing files). Mirrors the
 * read/write tools' path resolution, sandbox boundary, and allowlist handling so
 * it composes with the same agents and sandboxes.
 */
export class EditTool implements Tool {
  name = "edit";
  description =
    "Replace an exact string in an existing file. `old_string` must match exactly and be unique unless `replace_all` is set. Use this for surgical edits instead of rewriting the whole file with write.";
  parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      old_string: { type: "string", description: "Exact text to replace (must appear in the file)." },
      new_string: { type: "string", description: "Text to replace it with." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring a unique match. Default false.",
      },
    },
    required: ["path", "old_string", "new_string"],
  };

  private allowedPaths: string[];

  constructor(allowedPaths?: string[]) {
    this.allowedPaths = allowedPaths ?? [];
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const rawPath = args.path as string;
    const oldString = args.old_string as string;
    const newString = args.new_string as string;
    const replaceAll = args.replace_all === true;

    if (!rawPath) {
      return { success: false, output: "", error: "No path provided." };
    }
    if (oldString === undefined || oldString === null || oldString === "") {
      return { success: false, output: "", error: "`old_string` is required and must be non-empty." };
    }
    if (newString === undefined || newString === null) {
      return { success: false, output: "", error: "`new_string` is required." };
    }
    if (oldString === newString) {
      return { success: false, output: "", error: "`old_string` and `new_string` are identical — nothing to change." };
    }

    const fullPath = isAbsolute(rawPath) ? rawPath : resolve(context.workingDirectory, rawPath);

    const boundaryCheck = checkSandboxBoundary(fullPath, context);
    if (!boundaryCheck.ok) {
      return { success: false, output: "", error: boundaryCheck.error };
    }

    if (this.allowedPaths.length > 0) {
      const allowed = this.allowedPaths.some((p) => isPathContainedRealpath(fullPath, p, context.workingDirectory));
      if (!allowed) {
        return { success: false, output: "", error: `Path "${fullPath}" is not within allowed paths.` };
      }
    }

    let content: string;
    try {
      content =
        context.sandbox && context.sandboxHandle
          ? await context.sandbox.readFile(context.sandboxHandle, fullPath)
          : await readFile(fullPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { success: false, output: "", error: `File not found: ${fullPath}. Use write to create a new file.` };
      }
      if (code === "EISDIR") {
        return { success: false, output: "", error: `"${fullPath}" is a directory, not a file.` };
      }
      return { success: false, output: "", error: `Failed to read file: ${(err as Error).message}` };
    }

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return {
        success: false,
        output: "",
        error: `\`old_string\` not found in ${fullPath}. It must match exactly (including whitespace and indentation).`,
      };
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        success: false,
        output: "",
        error: `\`old_string\` matches ${occurrences} places in ${fullPath}. Add surrounding context to make it unique, or set replace_all: true.`,
      };
    }

    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);

    try {
      if (context.sandbox && context.sandboxHandle) {
        await context.sandbox.writeFile(context.sandboxHandle, fullPath, updated);
      } else {
        await writeFile(fullPath, updated, "utf-8");
      }
      const what = replaceAll ? `${occurrences} occurrence(s)` : "1 occurrence";
      return { success: true, output: `Edited ${fullPath} (replaced ${what}).` };
    } catch (err) {
      return { success: false, output: "", error: `Failed to write file: ${(err as Error).message}` };
    }
  }
}
