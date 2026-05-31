import type { Sandbox, SandboxHandle, SandboxKind, SandboxPrepareOptions } from "./interface.js";

export interface ActiveSandbox {
  id: string;
  kind: SandboxKind;
  cwd: string;
  agentName?: string;
  sessionId?: string;
  startedAt: string;
}

interface Entry extends ActiveSandbox {
  sandbox: Sandbox;
  handle: SandboxHandle;
}

let counter = 0;

/**
 * Tracks active sandbox prepare()/cleanup() pairs so the UI can list and
 * forcibly kill stuck containers. Wraps a Sandbox via `track()`.
 */
export class SandboxRegistry {
  private entries = new Map<string, Entry>();

  list(): ActiveSandbox[] {
    return Array.from(this.entries.values()).map(({ sandbox: _s, handle: _h, ...rest }) => rest);
  }

  /**
   * Wrap a sandbox so its prepare() registers and its cleanup() deregisters.
   * Records the supplied metadata against the resulting handle.
   */
  track(sandbox: Sandbox, meta: { agentName?: string; sessionId?: string }): Sandbox {
    const registry = this;
    const wrapped: Sandbox = {
      kind: sandbox.kind,
      async prepare(opts: SandboxPrepareOptions): Promise<SandboxHandle> {
        const handle = await sandbox.prepare(opts);
        const id = `sb_${++counter}_${Date.now().toString(36)}`;
        registry.entries.set(id, {
          id,
          kind: sandbox.kind,
          cwd: opts.cwd,
          agentName: meta.agentName,
          sessionId: meta.sessionId,
          startedAt: new Date().toISOString(),
          sandbox,
          handle,
        });
        (handle as { _registryId?: string })._registryId = id;
        return handle;
      },
      exec(handle, command, opts) {
        return sandbox.exec(handle, command, opts);
      },
      readFile(handle, path) {
        return sandbox.readFile(handle, path);
      },
      writeFile(handle, path, content) {
        return sandbox.writeFile(handle, path, content);
      },
      async cleanup(handle: SandboxHandle): Promise<void> {
        const id = (handle as { _registryId?: string })._registryId;
        if (id) registry.entries.delete(id);
        return sandbox.cleanup(handle);
      },
    };
    return wrapped;
  }

  /** Force-kill an active sandbox by registry id. Returns whether it existed. */
  async kill(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    try {
      await entry.sandbox.cleanup(entry.handle);
    } catch {
      /* best-effort */
    }
    return true;
  }
}

export const globalSandboxRegistry = new SandboxRegistry();
