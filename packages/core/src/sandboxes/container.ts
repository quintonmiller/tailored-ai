import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  Mount,
  Sandbox,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxKind,
  SandboxPrepareOptions,
} from "./interface.js";

export interface ContainerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A function that invokes a container CLI (docker / podman). Threaded for testability. */
export type ContainerRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<ContainerRunResult>;

export interface ContainerSandboxOptions {
  /** Image to run the agent in. Required. */
  imageName: string;
  /** Default extra mounts (beyond the cwd bind). hostPath supports ~ expansion. */
  mounts?: Mount[];
  /** Default env vars merged at container launch. */
  env?: Record<string, string>;
  /** Network policy, e.g. "host" or a named network. */
  network?: string;
  /** Where the cwd bind-mount appears inside the container. Default "/work". */
  sandboxWorkdir?: string;
  /** Inject a fake runner for tests. Defaults to the supplied default. */
  runner?: ContainerRunner;
}

export interface ContainerHandle extends SandboxHandle {
  readonly containerId: string;
  /** Host path bound into the container at `cwd`. */
  readonly hostCwd: string;
}

const DEFAULT_SANDBOX_WORKDIR = "/work";

/**
 * Shared implementation for docker/podman sandboxes. Both CLIs are
 * surface-compatible enough that a single class handles them with a
 * `kind` (handle tag) and `bin` (CLI binary) injected by the subclass.
 */
export class ContainerSandbox implements Sandbox {
  readonly kind: SandboxKind;

  protected opts: ContainerSandboxOptions;
  protected run: ContainerRunner;
  protected bin: string;

  constructor(kind: SandboxKind, bin: string, opts: ContainerSandboxOptions) {
    this.kind = kind;
    this.bin = bin;
    this.opts = opts;
    this.run = opts.runner ?? defaultRunner(bin);
  }

  async prepare(prep: SandboxPrepareOptions): Promise<ContainerHandle> {
    const hostCwd = expandTilde(prep.cwd);
    const sandboxCwd = this.opts.sandboxWorkdir ?? DEFAULT_SANDBOX_WORKDIR;

    const args: string[] = ["run", "-d", "--rm"];

    // Run as the host's uid:gid so commits/writes to bind-mounted files
    // don't show up as root-owned on the host and so git's
    // "dubious ownership" guard accepts the worktree. process.getuid is
    // not available on Windows; fall back to root in that case (no real
    // ownership mismatch on Windows containers anyway).
    if (typeof process.getuid === "function" && typeof process.getgid === "function") {
      args.push("--user", `${process.getuid()}:${process.getgid()}`);
    }

    if (this.opts.network) args.push(`--network=${this.opts.network}`);
    if (prep.network) args.push(`--network=${prep.network}`);

    args.push("-v", `${hostCwd}:${sandboxCwd}`);
    args.push("-w", sandboxCwd);

    for (const m of [...(this.opts.mounts ?? []), ...(prep.mounts ?? [])]) {
      const host = expandTilde(m.hostPath);
      const ro = m.readonly ? ":ro" : "";
      args.push("-v", `${host}:${m.sandboxPath}${ro}`);
    }

    // Set HOME to a writable spot — the image's user 1000 has no /home
    // entry so pnpm/git try to mkdir $HOME and fail without this.
    const env = { HOME: "/tmp", ...(this.opts.env ?? {}), ...(prep.env ?? {}) };
    for (const [k, v] of Object.entries(env)) {
      args.push("-e", `${k}=${v}`);
    }

    args.push("--entrypoint", "sleep", this.opts.imageName, "infinity");

    const result = await this.run(args);
    if (result.exitCode !== 0) {
      throw new Error(
        `${this.bin} run failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    const containerId = result.stdout.trim().split("\n").pop() ?? "";
    if (!containerId) {
      throw new Error(`${this.bin} run produced no container id`);
    }

    return { kind: this.kind, cwd: sandboxCwd, hostCwd, containerId } as ContainerHandle;
  }

  async exec(handle: SandboxHandle, command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    const h = handle as ContainerHandle;
    // Callers (the exec tool) pass `opts.cwd = context.workingDirectory`
    // which is the HOST worktree path. The container only has /work
    // (the bind mount), so we translate host → container space here.
    // Without this, `docker exec -w /host/path/worktree` fails because that
    // path doesn't exist inside the container.
    const requestedCwd = opts?.cwd ?? h.cwd;
    const cwd =
      requestedCwd === h.hostCwd || requestedCwd.startsWith(`${h.hostCwd}/`)
        ? h.cwd + requestedCwd.slice(h.hostCwd.length)
        : requestedCwd;

    const args: string[] = ["exec", "-w", cwd];
    if (opts?.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("-e", `${k}=${v}`);
      }
    }
    args.push(h.containerId, "bash", "-c", command);

    return this.run(args, { timeoutMs: opts?.timeoutMs });
  }

  async readFile(handle: SandboxHandle, path: string): Promise<string> {
    const h = handle as ContainerHandle;
    const hostPath = isAbsolute(path) ? path : resolve(h.hostCwd, path);
    return fs.readFile(hostPath, "utf8");
  }

  async writeFile(handle: SandboxHandle, path: string, content: string): Promise<void> {
    const h = handle as ContainerHandle;
    const hostPath = isAbsolute(path) ? path : resolve(h.hostCwd, path);
    await fs.mkdir(dirname(hostPath), { recursive: true });
    await fs.writeFile(hostPath, content, "utf8");
  }

  async cleanup(handle: SandboxHandle): Promise<void> {
    const h = handle as ContainerHandle;
    const result = await this.run(["rm", "-f", h.containerId]);
    if (result.exitCode !== 0) {
      console.warn(
        `[${this.kind}-sandbox] cleanup of ${h.containerId} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }
}

function defaultRunner(bin: string): ContainerRunner {
  return (args, opts) =>
    new Promise((resolveOut) => {
      const child = execFile(
        bin,
        args,
        { timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 },
        (err: Error | null, stdout: string, stderr: string) => {
          if (err) {
            const code =
              "code" in err && typeof (err as { code?: unknown }).code === "number"
                ? (err as { code: number }).code
                : 1;
            resolveOut({ exitCode: code, stdout, stderr: stderr || (err as Error).message });
            return;
          }
          resolveOut({ exitCode: 0, stdout, stderr });
        },
      );
      // Same reason as the host sandbox: an unclosed stdin pipe makes any
      // stdin-reading command inside the container hang until the timeout.
      // `docker exec` without `-i` gets no stdin anyway, so closing it here
      // only removes a way for the wrapper itself to stall.
      child.stdin?.end();
    });
}

function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? "";
    return home + p.slice(1);
  }
  return p;
}
