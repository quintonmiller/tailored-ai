import type { McpServerConfig } from "../config.js";
import type { ResourceManifest, ResourceOrigin } from "../resources/interface.js";
import type { ToolRegistry } from "../resources/tool-registry.js";
import type { Tool } from "../tools/interface.js";
import { type ConnectOptions, connectMcpServer, type McpConnection, rediscoverTools } from "./client.js";

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

  constructor(private readonly connect: ConnectFn = connectMcpServer) {}

  /** Drive the running server set to match config. Idempotent. */
  reconcile(host: McpHost): Promise<void> {
    const run = this.queue.then(() => this.reconcileInner(host));
    // Keep the chain alive past failures so the next call still runs.
    this.queue = run.catch(() => {});
    return run;
  }

  private async reconcileInner(host: McpHost): Promise<void> {
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
      try {
        const connection = await this.connect(id, cfg, {
          onToolListChanged: () => {
            this.refreshServer(host, id).catch((err) =>
              console.error(`[mcp:${id}] tool refresh failed: ${(err as Error).message}`),
            );
          },
        });
        this.active.set(id, { connection, cfg, signature: JSON.stringify(cfg), connectedAt: Date.now() });
        // Log the happy path: a connected server was previously silent, so
        // "no log lines" couldn't be told from "never ran" (#249).
        console.log(`[mcp:${id}] connected ${toolSummary(connection.tools)}`);
      } catch (err) {
        console.error(`[mcp:${id}] failed to connect: ${(err as Error).message}`);
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
