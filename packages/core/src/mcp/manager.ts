import type { McpServerConfig } from "../config.js";
import type { ResourceManifest, ResourceOrigin } from "../resources/interface.js";
import type { ToolRegistry } from "../resources/tool-registry.js";
import type { Tool } from "../tools/interface.js";
import { type ConnectOptions, connectMcpServer, isAuthFailure, type McpConnection, rediscoverTools } from "./client.js";

/**
 * The slice of AgentRuntime the manager needs. Narrowed for testability —
 * the real runtime satisfies it.
 */
export interface McpHost {
  getConfig(): { mcp?: { servers: { [id: string]: McpServerConfig | undefined } } };
  getToolRegistry(): ToolRegistry;
}

type ConnectFn = (id: string, cfg: McpServerConfig, opts?: ConnectOptions) => Promise<McpConnection>;

interface ActiveServer {
  connection: McpConnection;
  cfg: McpServerConfig;
  signature: string;
  connectedAt: number;
}

/** How long a connection must survive before its drop-backoff resets. */
const STABLE_CONNECTION_MS = 60_000;

/** Format a connected-tools summary for a log line: "(3 tools: a, b, c)". */
function toolSummary(tools: { name: string }[]): string {
  const names = tools.map((t) => t.name);
  const count = `${names.length} tool${names.length === 1 ? "" : "s"}`;
  return names.length ? `(${count}: ${names.join(", ")})` : `(${count})`;
}

/**
 * Per-server MCP lifecycle manager, modeled on {@link ChannelLifecycleManager}:
 * computes the desired server set from config and reconciles it against the
 * running set — starts new servers, stops removed ones, restarts changed ones
 * (config signature comparison). After every pass it syncs each connection's
 * discovered tools into the runtime's tool registry, so reconcile is also the
 * re-registration path after `runtime.reload()` swaps in a fresh registry.
 *
 * Wiring (CLI does this, mirroring channels):
 *
 *     const mcp = new McpManager();
 *     await mcp.reconcile(runtime);                       // initial start
 *     runtime.onReload(() => mcp.reconcile(runtime));     // hot-reload
 *     // on shutdown: await mcp.stopAll(runtime)
 *
 * A server that fails to connect is logged and skipped — the next reconcile
 * retries it. The agent loop re-resolves tools every iteration, so tools
 * from a slow-to-connect server appear mid-session without a restart.
 */
export class McpManager {
  private active = new Map<string, ActiveServer>();
  /** Serializes reconcile passes — overlapping runs would race start/stop. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Consecutive connect failures per server, with the earliest time to try
   * again. Retrying without this turns a permanently bad credential into a hot
   * loop — the drop handler below schedules a reconcile, which fails, which
   * schedules another.
   */
  private failures = new Map<string, { count: number; nextAttemptAt: number; auth: boolean }>();
  /**
   * Unexpected closes per server, kept separate from connect failures.
   *
   * They are different events and must not share a gate: a drop *schedules* a
   * reconnect, and if it also wrote the connect-backoff window it would block
   * the very attempt it just queued — correct only so long as the wall clock
   * advances in lockstep with the scheduler, which is a coincidence, not a
   * design. Escalates so a server that drops in a loop backs off too.
   */
  private drops = new Map<string, number>();

  constructor(
    private readonly connect: ConnectFn = connectMcpServer,
    /** Injectable for tests; real callers get the wall clock. */
    private readonly now: () => number = () => Date.now(),
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => {
      setTimeout(fn, ms).unref?.();
    },
  ) {}

  /** What each configured server is doing right now. For health surfaces. */
  status(): Array<{ id: string; connected: boolean; tools: number; retryInMs?: number; authFailure?: boolean }> {
    const out: Array<{ id: string; connected: boolean; tools: number; retryInMs?: number; authFailure?: boolean }> = [];
    const ids = new Set([...this.active.keys(), ...this.failures.keys()]);
    for (const id of ids) {
      const live = this.active.get(id);
      const fail = this.failures.get(id);
      out.push({
        id,
        connected: !!live,
        tools: live?.connection.tools.length ?? 0,
        ...(fail ? { retryInMs: Math.max(0, fail.nextAttemptAt - this.now()), authFailure: fail.auth } : {}),
      });
    }
    return out;
  }

  /**
   * A connection dropped on its own. Drop it from the active set so the next
   * reconcile genuinely restarts it — leaving it in place with an unchanged
   * signature is what made a dead server stay dead — then drive that reconcile.
   */
  private onServerDropped(host: McpHost, id: string): void {
    const running = this.active.get(id);
    if (!running) return; // already torn down deliberately
    this.active.delete(id);
    this.unregisterTools(host.getToolRegistry(), running.connection);
    // Reset the escalation only after the connection proved stable. Resetting
    // on "it connected" would mean a server that connects and immediately drops
    // retries every second forever — the hot loop this is meant to prevent.
    const wasStable = this.now() - running.connectedAt >= STABLE_CONNECTION_MS;
    const n = (wasStable ? 0 : (this.drops.get(id) ?? 0)) + 1;
    this.drops.set(id, n);
    const wait = Math.min(1000 * 2 ** (n - 1), 5 * 60_000);
    console.warn(
      `[mcp:${id}] connection lost — its tools are unregistered; reconnecting in ~${Math.round(wait / 1000)}s`,
    );
    this.schedule(() => {
      void this.reconcileAutomatic(host);
    }, wait);
  }

  /** Exponential, capped, and recorded so reconcile can skip an early retry. */
  private backoffFor(id: string, auth: boolean): number {
    const prev = this.failures.get(id);
    const count = (prev?.count ?? 0) + 1;
    // Auth failures start slower: nobody fixes a token in 30 seconds, and
    // hammering an endpoint with a known-bad credential is how you get rate
    // limited on top of being broken.
    const base = auth ? 5 * 60_000 : 30_000;
    const wait = Math.min(base * 2 ** (count - 1), 15 * 60_000);
    this.failures.set(id, { count, nextAttemptAt: this.now() + wait, auth });
    return wait;
  }

  /**
   * Drive the running server set to match config. Idempotent.
   *
   * Always attempts every failed server, ignoring any backoff. Callers are
   * startup and config reload — both human-driven, and the human may have just
   * fixed the credential that was failing. Making them wait out a backoff would
   * mean "fix the token, reload, nothing happens", which is worse than the
   * hammering the backoff exists to stop.
   */
  reconcile(host: McpHost): Promise<void> {
    const run = this.queue.then(() => this.reconcileInner(host, false));
    // Keep the chain alive past failures so the next call still runs.
    this.queue = run.catch(() => {});
    return run;
  }

  /** The self-driven retry after a dropped connection. Honours the backoff. */
  private reconcileAutomatic(host: McpHost): Promise<void> {
    const run = this.queue.then(() => this.reconcileInner(host, true));
    this.queue = run.catch(() => {});
    return run;
  }

  private async reconcileInner(host: McpHost, automatic: boolean): Promise<void> {
    const blocks = host.getConfig().mcp?.servers ?? {};
    const desired = new Map<string, McpServerConfig>();
    for (const [id, cfg] of Object.entries(blocks)) {
      if (!cfg || cfg.enabled === false) continue;
      // Exactly one transport — validateConfig warns on the rest.
      if (!cfg.command === !cfg.url) continue;
      desired.set(id, cfg);
    }

    // 1. Stop servers that are gone or whose config changed (restart below).
    for (const [id, running] of [...this.active.entries()]) {
      const want = desired.get(id);
      if (want && JSON.stringify(want) === running.signature) continue;
      this.unregisterTools(host.getToolRegistry(), running.connection);
      this.active.delete(id);
      try {
        await running.connection.close();
      } catch (err) {
        console.error(`[mcp:${id}] close error: ${(err as Error).message}`);
      }
      // Happy-path teardown logs too, so silence stays meaningful (#249).
      console.log(
        want ? `[mcp:${id}] config changed — reconnecting` : `[mcp:${id}] disconnected (removed from config)`,
      );
    }

    // 2. Start servers that are desired but not running.
    for (const [id, cfg] of desired.entries()) {
      if (this.active.has(id)) continue;
      const failed = this.failures.get(id);
      if (automatic && failed && this.now() < failed.nextAttemptAt) continue; // backing off, quietly
      try {
        const connection = await this.connect(id, cfg, {
          onToolListChanged: () => {
            this.refreshServer(host, id).catch((err) =>
              console.error(`[mcp:${id}] tool refresh failed: ${(err as Error).message}`),
            );
          },
          onClose: () => this.onServerDropped(host, id),
        });
        this.active.set(id, { connection, cfg, signature: JSON.stringify(cfg), connectedAt: this.now() });
        if (this.failures.delete(id)) {
          console.log(`[mcp:${id}] recovered`);
        }
        // Log the happy path: a connected server was previously silent, so
        // "no log lines" couldn't be told from "never ran" (#249).
        console.log(`[mcp:${id}] connected ${toolSummary(connection.tools)}`);
      } catch (err) {
        const auth = isAuthFailure(err);
        const wait = this.backoffFor(id, auth);
        const mins = Math.round(wait / 60_000);
        if (auth) {
          // Named as a credential problem, because the fix is a person minting
          // a new token — not something a retry will ever resolve. Says which
          // config key to look at, so the log line is actionable on its own.
          console.error(
            `[mcp:${id}] AUTH FAILED — the credential is rejected, and retrying will not fix it. ` +
              `Check mcp.servers.${id} (env/headers) and mint a new token. ` +
              `Retrying in ~${mins || 1}m anyway. (${(err as Error).message})`,
          );
        } else {
          console.error(`[mcp:${id}] failed to connect, retrying in ~${mins || 1}m: ${(err as Error).message}`);
        }
      }
    }

    // 3. Sync all live tools into the (possibly brand-new) tool registry.
    //    register() replaces same (id, version), so this is idempotent.
    const registry = host.getToolRegistry();
    for (const [id, running] of this.active.entries()) {
      for (const tool of running.connection.tools) {
        this.registerTool(registry, id, tool);
      }
    }
  }

  /** Re-list one server's tools after a list_changed notification. */
  private refreshServer(host: McpHost, id: string): Promise<void> {
    const run = this.queue.then(async () => {
      const running = this.active.get(id);
      if (!running) return;
      const registry = host.getToolRegistry();
      this.unregisterTools(registry, running.connection);
      const tools = await rediscoverTools(running.connection, running.cfg);
      for (const tool of tools) this.registerTool(registry, id, tool);
      console.log(`[mcp:${id}] tools updated ${toolSummary(tools)}`);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private registerTool(registry: ToolRegistry, serverId: string, tool: Tool): void {
    const manifest: ResourceManifest = {
      kind: "tool",
      id: tool.name,
      version: "0.0.0",
      description: tool.description,
      hotReload: true,
    };
    const origin: ResourceOrigin = {
      scheme: "mcp",
      uri: `mcp:${serverId}/${tool.name}`,
      loadedAt: Date.now(),
    };
    registry.register({ manifest, origin, body: tool });
  }

  private unregisterTools(registry: ToolRegistry, connection: McpConnection): void {
    for (const tool of connection.tools) {
      registry.unregister(tool.name);
    }
  }

  /**
   * Status snapshot — server id, discovered tool names, and the epoch-ms
   * timestamp the server connected. Drives the startup banner, the
   * `GET /api/mcp` route, and `tai doctor` (#249).
   */
  list(): Array<{ serverId: string; tools: string[]; connectedAt: number }> {
    return [...this.active.entries()].map(([serverId, s]) => ({
      serverId,
      tools: s.connection.tools.map((t) => t.name),
      connectedAt: s.connectedAt,
    }));
  }

  /** Close every connection and drop their tools (process shutdown). */
  async stopAll(host?: McpHost): Promise<void> {
    const all = [...this.active.entries()];
    this.active.clear();
    const registry = host?.getToolRegistry();
    await Promise.all(
      all.map(async ([id, s]) => {
        if (registry) this.unregisterTools(registry, s.connection);
        try {
          await s.connection.close();
        } catch (err) {
          console.error(`[mcp:${id}] close error: ${(err as Error).message}`);
        }
        console.log(`[mcp:${id}] disconnected (shutdown)`);
      }),
    );
  }
}
