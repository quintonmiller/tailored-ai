import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkCommandAllowlist } from "./command-allowlist.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { checkExecBoundary } from "./sandbox-boundary.js";

/**
 * Where the exec tool writes the full output of a truncated command.
 *
 * Precedence:
 *   1. Constructor-supplied `scratchDir` (factories pass `<TAI_HOME>/exec-outputs`).
 *   2. `TAI_HOME` env var (`$TAI_HOME/exec-outputs`).
 *   3. Legacy default `~/.tai/exec-outputs`.
 *
 * Closes #60: previously the hardcoded ~/.tai/exec-outputs path ignored
 * every configured home, and a write failure there could hang the tool
 * promise.
 */
function resolveScratchDir(override: string | undefined, sessionId: string | undefined): string {
  const base = override ?? (process.env.TAI_HOME ? join(process.env.TAI_HOME, "exec-outputs") : undefined);
  const dir = resolve(base ?? join(homedir(), ".tai", "exec-outputs"));
  return join(dir, sessionId || "unknown");
}

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

async function maybeTruncate(
  raw: string,
  sessionId: string | undefined,
  scratchDir: string | undefined,
): Promise<string> {
  if (raw.length <= TRUNCATE_BYTES) return raw;

  // Best-effort scratch persistence. When it fails (permission denied,
  // disk full, no $HOME on a CI runner, ...) we still return a truncated
  // summary so the tool promise settles — without this the outer
  // `new Promise((resolve) => ...)` in execute() would never call resolve
  // and the call would hang until the tool timeout fires (#60).
  const saved = await saveFullOutput(raw, sessionId, scratchDir).catch((err) => ({
    error: (err as Error).message,
  }));
  const path = typeof saved === "string" ? saved : undefined;
  const persistWarning =
    typeof saved === "object"
      ? `Full output could not be persisted: ${saved.error}. Falling back to in-memory truncation.`
      : undefined;

  const lines = raw.split("\n");
  const total = lines.length;
  const fullRef = path ? `Full output: ${path}` : (persistWarning ?? "Full output not persisted.");
  if (total <= HEAD_LINES + TAIL_LINES) {
    // Char-bloated single-line case (stack trace with long paths, etc.)
    // — just clip head/tail by chars.
    const head = raw.slice(0, 1500);
    const tail = raw.slice(-2000);
    return `[exec output: ${raw.length} bytes truncated. ${fullRef}]\n\n${head}\n... [middle omitted] ...\n${tail}`;
  }
  const head = lines.slice(0, HEAD_LINES).join("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  const omitted = total - HEAD_LINES - TAIL_LINES;
  return [
    `[exec output: ${raw.length} bytes, ${total} lines — truncated. ${fullRef}]`,
    head,
    `... [${omitted} lines omitted] ...`,
    tail,
  ].join("\n");
}

async function saveFullOutput(
  raw: string,
  sessionId: string | undefined,
  scratchDirOverride: string | undefined,
): Promise<string> {
  const dir = resolveScratchDir(scratchDirOverride, sessionId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.log`);
  await writeFile(path, raw, "utf8");
  return path;
}

export class ExecTool implements Tool {
  name = "exec";
  description = "Run a shell command and return its output. Chain steps with && or || and pipe with |.";
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
  private scratchDir: string | undefined;

  constructor(allowedCommands?: string[], timeoutMs: number = 30_000, scratchDir?: string) {
    this.allowedCommands = allowedCommands ?? [];
    this.timeoutMs = timeoutMs;
    this.scratchDir = scratchDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    if (!command) {
      return { success: false, output: "", error: "No command provided." };
    }

    if (this.allowedCommands.length > 0) {
      // Permit safe compound commands (chains, pipes, redirections) while
      // keeping the allowlist's guarantee that only listed binaries run in
      // command position. See command-allowlist.ts for the policy.
      const check = checkCommandAllowlist(command, this.allowedCommands);
      if (!check.ok) {
        return { success: false, output: "", error: check.error };
      }
    }

    const boundaryCheck = checkExecBoundary(command, context);
    if (!boundaryCheck.ok) {
      return { success: false, output: "", error: boundaryCheck.error };
    }

    if (context.sandbox && context.sandboxHandle) {
      const result = await context.sandbox.exec(context.sandboxHandle, command, {
        cwd: context.workingDirectory,
        env: context.env,
        timeoutMs: this.timeoutMs,
      });
      const raw = result.stdout + (result.stderr ? `\n[stderr]: ${result.stderr}` : "");
      const output = await maybeTruncate(raw, context.sessionId, this.scratchDir);
      if (result.exitCode !== 0) {
        return { success: false, output, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { success: true, output };
    }

    return new Promise<ToolResult>((resolveTool) => {
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
          // Wrap maybeTruncate so an unexpected throw still settles the
          // outer promise instead of hanging the agent loop (#60). The
          // raw output goes back in place of the truncated summary so the
          // model has something to work with.
          let output: string;
          try {
            output = await maybeTruncate(raw, context.sessionId, this.scratchDir);
          } catch (truncErr) {
            output = `${raw.slice(0, TRUNCATE_BYTES)}\n[exec: output truncation failed: ${(truncErr as Error).message}]`;
          }
          if (error) {
            resolveTool({
              success: false,
              output,
              error: stderr || error.message,
            });
          } else {
            resolveTool({ success: true, output });
          }
        },
      );
    });
  }
}
