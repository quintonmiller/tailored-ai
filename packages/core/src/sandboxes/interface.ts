/**
 * Sandbox abstraction for routing tool side-effects (shell, file IO) through
 * an isolated execution environment.
 *
 * The default `host` sandbox is a no-op: tools execute directly on the host
 * machine, preserving current behavior. Pluggable backends like `docker` and
 * `podman` can wrap an agent's tool calls in a containerized environment with
 * bind-mounted working directories, separate filesystems, and resource limits.
 *
 * This interface is intentionally narrow: prepare → exec/read/write → cleanup.
 * Anything beyond that (network policy, GPU access, custom mounts) is provider-
 * specific and lives in the per-backend factory options.
 */

/**
 * Open string alias for sandbox kind identifiers. Built-ins are "host",
 * "docker", and "podman"; plugins may register any other string.
 */
export type SandboxKind = string;

export interface Mount {
  /** Path on the host. Relative paths resolve against the prepare() cwd. */
  hostPath: string;
  /** Path inside the sandbox. Relative paths resolve against the sandbox cwd. */
  sandboxPath: string;
  readonly?: boolean;
}

export interface SandboxPrepareOptions {
  /** Working directory bound to the sandbox. */
  cwd: string;
  mounts?: Mount[];
  /** Extra env vars merged at sandbox launch. */
  env?: Record<string, string>;
  /** Network policy. Backend-specific; e.g. docker accepts "host" or a network name. */
  network?: string;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Opaque-ish handle returned by `sandbox.prepare()`. Backends extend this with
 * their own runtime state (containerId, worktree path, etc.). Tools that route
 * through the sandbox should treat it as opaque.
 */
export interface SandboxHandle {
  readonly kind: SandboxKind;
  /** Working directory inside the sandbox. */
  readonly cwd: string;
}

export interface Sandbox {
  readonly kind: SandboxKind;
  prepare(opts: SandboxPrepareOptions): Promise<SandboxHandle>;
  exec(handle: SandboxHandle, command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  readFile(handle: SandboxHandle, path: string): Promise<string>;
  writeFile(handle: SandboxHandle, path: string, content: string): Promise<void>;
  cleanup(handle: SandboxHandle): Promise<void>;
}
