import { execFile } from "node:child_process";
import type { Sandbox } from "../../sandboxes/interface.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import { resolveString, resolveValue } from "../scope.js";
import type { ShellStep, WorkflowStepDef } from "../types.js";

export interface ShellExecutorOptions {
  /** When set, commands route through this sandbox. The handle is shared across all shell steps in a run; the engine prepares/cleans it up. */
  sandbox?: Sandbox;
  /** Default working directory if step.cwd is unset. */
  cwd?: string;
  /** Environment variables merged with step.env. */
  baseEnv?: Record<string, string>;
  /** Default per-step timeout. Default 60s. */
  defaultTimeoutMs?: number;
  /** Per-shell-step grace period after SIGTERM before SIGKILL (sandboxes may ignore). Default 30s. */
  gracePeriodMs?: number;
}

/**
 * Runs a shell command. Same posture as the `exec` tool: when a sandbox
 * is configured the command runs there; otherwise it runs on the host
 * via `bash -c`.
 *
 * Output is the command's stdout. Non-zero exit raises with stderr in
 * the message so the engine can apply onError/retry.
 */
export class ShellExecutor implements StepExecutor {
  type = "shell" as const;
  private sandbox: Sandbox | undefined;
  private cwd: string;
  private baseEnv: Record<string, string>;
  private defaultTimeoutMs: number;
  private gracePeriodMs: number;

  constructor(opts: ShellExecutorOptions = {}) {
    this.sandbox = opts.sandbox;
    this.cwd = opts.cwd ?? process.cwd();
    this.baseEnv = opts.baseEnv ?? {};
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
    this.gracePeriodMs = opts.gracePeriodMs ?? 30_000;
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as ShellStep;
    const command = String(resolveString(s.command, ctx.scope));

    if (ctx.dryRun) {
      console.log(`[dry-run] shell "${s.name}" skipped: ${command}`);
      return { output: `[dry-run] would run: ${command}` };
    }
    const cwd = s.cwd ? String(resolveString(s.cwd, ctx.scope)) : this.cwd;
    const stepEnv = (resolveValue(s.env ?? {}, ctx.scope) as Record<string, string>) ?? {};
    const env = { ...this.baseEnv, ...stepEnv };
    const timeoutMs = s.timeoutMs ?? this.defaultTimeoutMs;

    // Prefer the run-level sandbox threaded onto ctx (set by the engine when
    // WorkflowDefinition.sandbox is configured). Fall back to the executor's
    // constructor sandbox for back-compat.
    const sandbox = ctx.sandbox ?? this.sandbox;
    const sandboxHandle = ctx.sandboxHandle;
    if (sandbox && sandboxHandle) {
      const result = await sandbox.exec(sandboxHandle, command, {
        cwd,
        env,
        timeoutMs,
        signal: ctx.signal,
      });
      if (result.exitCode !== 0) {
        throw new Error(`shell exit ${result.exitCode}: ${result.stderr || result.stdout || command}`);
      }
      return { output: result.stdout };
    }

    return new Promise<StepResult>((resolve, reject) => {
      let killed = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const child = execFile(
        "bash",
        ["-c", command],
        {
          cwd,
          env: { ...process.env, ...env },
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (killTimer) clearTimeout(killTimer);
          if (killed) {
            reject(new Error("shell cancelled"));
            return;
          }
          if (error) {
            const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
            const msg = stderr?.toString().trim() || (error as Error).message;
            reject(new Error(`shell exit ${code ?? "?"}: ${msg}`));
            return;
          }
          resolve({ output: String(stdout) });
        },
      );

      const onAbort = () => {
        if (!child.pid) return;
        killed = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exited */
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, this.gracePeriodMs);
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
