import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  Mount,
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxPrepareOptions,
} from "./interface.js";

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A function that invokes the docker CLI. Threaded through the constructor for testability. */
export type DockerRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<DockerRunResult>;

export interface DockerSandboxOptions {
  /** Image to run the agent in. Required. */
  imageName: string;
  /** Default extra mounts (beyond the cwd bind). hostPath supports ~ expansion. */
  mounts?: Mount[];
  /** Default env vars merged at container launch. */
  env?: Record<string, string>;
  /** Docker network policy, e.g. "host" or a network name. */
  network?: string;
  /** Where the cwd bind-mount appears inside the container. Default "/work". */
  sandboxWorkdir?: string;
  /** Inject a fake runner for tests. Defaults to a real `execFile('docker', ...)`. */
  runner?: DockerRunner;
}

interface DockerHandle extends SandboxHandle {
  readonly kind: "docker";
  readonly containerId: string;
  /** Host path bound into the container at `cwd`. */
  readonly hostCwd: string;
}

const DEFAULT_SANDBOX_WORKDIR = "/work";

/**
 * Sandbox backed by a long-running Docker container with the host cwd
 * bind-mounted at `sandboxWorkdir` (default `/work`). One container per
 * `prepare()`; `exec()` runs `docker exec` inside it; `cleanup()` removes
 * the container. File reads/writes go to the host bind-mount path so the
 * sandbox doesn't need `docker cp` for the common case.
 */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;

  private opts: DockerSandboxOptions;
  private run: DockerRunner;

  constructor(opts: DockerSandboxOptions) {
    this.opts = opts;
    this.run = opts.runner ?? defaultDockerRunner;
  }

  async prepare(prep: SandboxPrepareOptions): Promise<DockerHandle> {
    const hostCwd = expandTilde(prep.cwd);
    const sandboxCwd = this.opts.sandboxWorkdir ?? DEFAULT_SANDBOX_WORKDIR;

    const args: string[] = ["run", "-d", "--rm"];
    if (this.opts.network) args.push(`--network=${this.opts.network}`);
    if (prep.network) args.push(`--network=${prep.network}`);

    // Bind the working directory.
    args.push("-v", `${hostCwd}:${sandboxCwd}`);
    args.push("-w", sandboxCwd);

    // Extra mounts — provider-level first, then prepare-level overrides.
    for (const m of [...(this.opts.mounts ?? []), ...(prep.mounts ?? [])]) {
      const host = expandTilde(m.hostPath);
      const ro = m.readonly ? ":ro" : "";
      args.push("-v", `${host}:${m.sandboxPath}${ro}`);
    }

    // Env vars — provider-level first, then prepare-level overrides.
    const env = { ...(this.opts.env ?? {}), ...(prep.env ?? {}) };
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }

    // Long-running entrypoint so `docker exec` can keep landing commands.
    args.push("--entrypoint", "sleep", this.opts.imageName, "infinity");

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(`docker run failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const containerId = result.stdout.trim().split("\n").pop() ?? "";
    if (!containerId) {
      throw new Error("docker run produced no container id");
    }

    return { kind: "docker", cwd: sandboxCwd, hostCwd, containerId };
  }

  async exec(handle: SandboxHandle, command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    const h = handle as DockerHandle;
    const cwd = opts?.cwd ?? h.cwd;

    const args: string[] = ["exec", "-w", cwd];
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push(h.containerId, "bash", "-c", command);

    const result = await this.run(args, { timeoutMs: opts?.timeoutMs });
    return result;
  }

  /**
   * Read a file via the host bind-mount path. Fast path; works as long as the
   * file is inside the cwd-bound directory.
   */
  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const h = handle as DockerHandle;
    const hostPath = isAbsolute(path) ? path : resolve(h.hostCwd, path);
    return fs.readFile(hostPath, "utf8");
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const h = handle as DockerHandle;
    const hostPath = isAbsolute(path) ? path : resolve(h.hostCwd, path);
    await fs.mkdir(dirname(hostPath), { recursive: true });
    await fs.writeFile(hostPath, content, "utf8");
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    const h = handle as DockerHandle;
    const result = await this.run(["rm", "-f", h.containerId]);
    if (result.exitCode !== 0) {
      // Don't throw — cleanup is best-effort. Log and move on.
      console.warn(
        `[docker-sandbox] cleanup of ${h.containerId} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }
}

const defaultDockerRunner: DockerRunner = (args, opts) =>
  new Promise((resolveOut) => {
    execFile(
      "docker",
      args,
      { timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          const code =
            "code" in err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolveOut({ exitCode: code, stdout, stderr: stderr || (err as Error).message });
          return;
        }
        resolveOut({ exitCode: 0, stdout, stderr });
      },
    );
  });

function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}
