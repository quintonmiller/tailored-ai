import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";

/**
 * Close a child's stdin, optionally writing to it first, without letting the
 * child's own behaviour fault this process.
 *
 * Writing to a pipe whose reader has gone raises `EPIPE`, and an `EPIPE` on a
 * stream with no `error` listener is an **uncaught exception** — it does not
 * reject the surrounding promise, it takes the process down. So a hook script
 * that exits without reading its input, which is a completely ordinary hook,
 * could kill the runtime that ran it
 * ([#606](https://github.com/quintonmiller/tailored-ai/issues/606)).
 *
 * The child's exit code is still the answer and must survive this. A child that
 * runs, ignores stdin and exits 2 has refused; losing that verdict to a
 * plumbing error on the input pipe would be the worse bug. So the error is
 * swallowed and the caller's `close` handler resolves exactly as it would have.
 *
 * `EPIPE` and `ERR_STREAM_DESTROYED` are the expected shapes of "the child is
 * already gone" and stay silent. Anything else is unexpected enough to log
 * once, but still never thrown — an input-pipe problem is not worth failing an
 * operation that otherwise completed.
 */
export function closeChildStdin(child: ChildProcess, input?: string): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    console.warn(`[shell] writing to child stdin failed: ${err.message}`);
  });
  try {
    stdin.end(input);
  } catch (err) {
    // A synchronous throw on an already-destroyed stream, for the same reason.
    console.warn(`[shell] closing child stdin failed: ${(err as Error).message}`);
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ShellResult {
  success: boolean;
  output: string;
  error?: string;
}

export function runShellCommand(cmd: string, timeoutMs?: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-c", cmd],
      { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, output: stdout, error: stderr || (err as Error).message });
        } else {
          resolve({ success: true, output: stdout + (stderr ? `\n[stderr] ${stderr}` : "") });
        }
      },
    );
  });
}
