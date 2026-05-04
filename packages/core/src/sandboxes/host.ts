import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxPrepareOptions,
} from "./interface.js";

interface HostHandle extends SandboxHandle {
  readonly kind: "host";
  readonly env: Record<string, string>;
}

/**
 * No-op sandbox: tools execute directly on the host. Preserves current
 * behavior (this is the default). Useful as a baseline implementation and as
 * the target when no isolation is needed.
 */
export class HostSandbox implements Sandbox {
  readonly kind = "host" as const;

  async prepare(opts: SandboxPrepareOptions): Promise<HostHandle> {
    return { kind: "host", cwd: opts.cwd, env: opts.env ?? {} };
  }

  async exec(handle: SandboxHandle, command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    const h = handle as HostHandle;
    const cwd = opts?.cwd ?? h.cwd;
    const env = { ...process.env, ...h.env, ...(opts?.env ?? {}) };
    const timeout = opts?.timeoutMs ?? 30_000;

    return new Promise((resolveOut) => {
      const child = execFile(
        "bash",
        ["-c", command],
        { cwd, env, timeout, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const exitCode =
              "code" in err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
            resolveOut({ exitCode, stdout, stderr: stderr || (err as Error).message });
            return;
          }
          resolveOut({ exitCode: 0, stdout, stderr });
        },
      );
      if (opts?.signal) {
        opts.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      }
    });
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    return fs.readFile(this.resolve(handle, path), "utf8");
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const target = this.resolve(handle, path);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up on the host.
  }

  private resolve(handle: SandboxHandle, path: string): string {
    return isAbsolute(path) ? path : resolve(handle.cwd, path);
  }
}
