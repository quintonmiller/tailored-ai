import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

export function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export interface ShellResult {
  success: boolean;
  output: string;
  error?: string;
}

export function runShellCommand(cmd: string, timeoutMs?: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        resolve({ success: false, output: stdout, error: stderr || (err as Error).message });
      } else {
        resolve({ success: true, output: stdout + (stderr ? `\n[stderr] ${stderr}` : '') });
      }
    });
  });
}
