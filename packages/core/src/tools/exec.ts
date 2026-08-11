import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { taiHomePath } from "../home.js";
import { type CommandRules, type CommandRulesMode, checkCommandRules, mergeCommandRules } from "./command-allowlist.js";
import { classifyCommand } from "./effect.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { checkExecBoundary } from "./sandbox-boundary.js";

/**
 * Where the exec tool writes the full output of a truncated command.
 *
 * A constructor-supplied `scratchDir` wins; otherwise this instance's home.
 *
 * Closes #60: previously the hardcoded ~/.tai/exec-outputs path ignored
 * every configured home, and a write failure there could hang the tool
 * promise. The `~/.tai` fallback that replaced it was only reachable when
 * `TAI_HOME` was unset — which, since nothing assigned it, was always. That
 * is why a real install accumulates 441 session directories under a path no
 * config mentions.
 */
function resolveScratchDir(override: string | undefined, sessionId: string | undefined): string {
  const dir = override ? resolve(override) : taiHomePath("exec-outputs");
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
  /**
   * Per call, not per tool. `git status` and `rm -rf build` are not the same
   * act, and charging every shell call the cost of the irreversible path would
   * make the check unaffordable exactly where it is least needed.
   */
  effect = (args: Record<string, unknown>) =>
    classifyCommand(typeof args.command === "string" ? args.command : "");
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

  private rules: CommandRules;
  private mode: CommandRulesMode;
  private timeoutMs: number;
  private scratchDir: string | undefined;

  constructor(
    rules?: CommandRules | string[],
    timeoutMs: number = 30_000,
    scratchDir?: string,
    mode: CommandRulesMode = "intersect",
  ) {
    // A bare array is the historical `allowedCommands` argument.
    this.rules = Array.isArray(rules) ? { allow: rules } : (rules ?? {});
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.scratchDir = scratchDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = args.command as string;
    if (!command) {
      return { success: false, output: "", error: "No command provided." };
    }

    // One ExecTool instance serves every agent, so the per-agent rules arrive
    // on the context and are merged here rather than baked in at construction.
    // Permits safe compound commands (chains, pipes, redirections) while
    // keeping the guarantee that only permitted binaries run in command
    // position. See command-allowlist.ts for the policy.
    const effective = mergeCommandRules(this.rules, context.execRules, this.mode);
    const check = checkCommandRules(command, effective);
    if (!check.ok) {
      return { success: false, output: "", error: check.error };
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
      const child = execFile(
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

      // An agent's command has no interactive input, but execFile hands the
      // child an open stdin pipe that is never written to and never closed.
      // Any CLI that reads stdin when it is not a TTY then blocks until the
      // timeout kills it — and the kill discards the buffers, so the agent
      // sees empty stdout, empty stderr and a bare "Command failed", which
      // reads as "that binary isn't installed" rather than "it is waiting".
      //
      // Observed with the Notion CLI: `ntn api v1/users/me` returned fine,
      // while `ntn api v1/users/me | jq -r .name` hung for the full 30s.
      // `stdio` is not honoured by execFile (it owns the pipes to buffer
      // them), so close the stream on the returned child instead.
      child.stdin?.end();
    });
  }
}
