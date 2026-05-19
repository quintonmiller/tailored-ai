import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Head + tail truncation for noisy command output (test runners,
 * compilers). Saves the full output to a file so the agent (or a
 * human debugging) can read it later, returns a bounded summary in
 * the tool result. Without this, a single `pnpm test` run can blow
 * past the model's context budget — see docs/agent-unification.md
 * Phase 7 (output truncation + trim pinning).
 */
const TRUNCATE_BYTES = 4000;
const HEAD_LINES = 15;
const TAIL_LINES = 35;

async function maybeTruncate(raw: string, sessionId: string | undefined): Promise<string> {
  if (raw.length <= TRUNCATE_BYTES) return raw;

  const path = await saveFullOutput(raw, sessionId);
  const lines = raw.split("\n");
  const total = lines.length;
  if (total <= HEAD_LINES + TAIL_LINES) {
    // Char-bloated single-line case (stack trace with long paths, etc.)
    // — just clip head/tail by chars.
    const head = raw.slice(0, 1500);
    const tail = raw.slice(-2000);
    return `[exec output: ${raw.length} bytes truncated. Full output: ${path}]\n${head}\n... [middle omitted] ...\n${tail}`;
  }
  const head = lines.slice(0, HEAD_LINES).join("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  const omitted = total - HEAD_LINES - TAIL_LINES;
  return [
    `[exec output: ${raw.length} bytes, ${total} lines — truncated. Full output: ${path}]`,
    head,
    `... [${omitted} lines omitted] ...`,
    tail,
  ].join("\n");
}

async function saveFullOutput(raw: string, sessionId: string | undefined): Promise<string> {
  const dir = join(homedir(), ".tai", "exec-outputs", sessionId || "unknown");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.log`);
  await writeFile(path, raw, "utf8");
  return path;
}

export class ExecTool implements Tool {
  name = "exec";
  description = "Run a shell command and return its output.";
  parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute.",
      },
    },
    required: ["command"],
  };

  private allowedCommands: string[];
  private timeoutMs: number;

  constructor(allowedCommands?: string[], timeoutMs: number = 30_000) {
    this.allowedCommands = allowedCommands ?? [];
    this.timeoutMs = timeoutMs;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    if (!command) {
      return { success: false, output: "", error: "No command provided." };
    }

    if (this.allowedCommands.length > 0) {
      // Reject shell metacharacters to prevent chaining/piping past the allowlist
      if (/[;|&`$(){}<>!#\n]/.test(command)) {
        return {
          success: false,
          output: "",
          error: `Command rejected: shell operators are not allowed when an allowlist is active.`,
        };
      }
      const bin = command.split(/\s+/)[0];
      if (!this.allowedCommands.includes(bin)) {
        return {
          success: false,
          output: "",
          error: `Command "${bin}" is not in the allowlist: ${this.allowedCommands.join(", ")}`,
        };
      }
    }

    if (context.sandbox && context.sandboxHandle) {
      const result = await context.sandbox.exec(context.sandboxHandle, command, {
        cwd: context.workingDirectory,
        env: context.env,
        timeoutMs: this.timeoutMs,
      });
      const raw = result.stdout + (result.stderr ? `\n[stderr]: ${result.stderr}` : "");
      const output = await maybeTruncate(raw, context.sessionId);
      if (result.exitCode !== 0) {
        return { success: false, output, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { success: true, output };
    }

    return new Promise((resolve) => {
      execFile(
        "bash",
        ["-c", command],
        {
          cwd: context.workingDirectory,
          env: { ...process.env, ...context.env },
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        async (error, stdout, stderr) => {
          const raw = stdout + (stderr ? `\n[stderr]: ${stderr}` : "");
          const output = await maybeTruncate(raw, context.sessionId);
          if (error) {
            resolve({
              success: false,
              output,
              error: stderr || error.message,
            });
          } else {
            resolve({ success: true, output });
          }
        },
      );
    });
  }
}
