/**
 * Tests for McpManager — the per-server reconciler that mirrors
 * ChannelLifecycleManager: start desired servers, stop removed ones,
 * restart changed ones, and keep discovered tools synced into the tool
 * registry (including after a reload swaps in a fresh registry).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config.js";
import type { McpConnection } from "../mcp/client.js";
import { McpManager } from "../mcp/manager.js";
import { ToolRegistry } from "../resources/tool-registry.js";
import type { Tool } from "../tools/interface.js";

function fakeTool(name: string): Tool {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "ok" }),
  };
}

interface FakeHostOpts {
  servers: Record<string, McpServerConfig | undefined>;
}

function fakeHost(opts: FakeHostOpts) {
  const registry = new ToolRegistry();
  const host = {
    servers: opts.servers,
    registry,
    getConfig() {
      return { mcp: { servers: this.servers } };
    },
    getToolRegistry() {
      return this.registry;
    },
  };
  return host;
}

/** Connect stub that records connections and lets tests fail specific servers. */
function fakeConnect(toolsByServer: Record<string, string[]>, failServers: Set<string> = new Set()) {
  const connections: McpConnection[] = [];
  const closed: string[] = [];
  const connect = vi.fn(async (id: string): Promise<McpConnection> => {
    if (failServers.has(id)) throw new Error(`boom ${id}`);
    const conn: McpConnection = {
      serverId: id,
      tools: (toolsByServer[id] ?? []).map(fakeTool),
      close: async () => {
        closed.push(id);
      },
    };
    connections.push(conn);
    return conn;
  });
  return { connect, connections, closed };
}

describe("McpManager.reconcile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts enabled servers and registers their tools", async () => {
    const { connect } = fakeConnect({ alpha: ["mcp_alpha_echo", "mcp_alpha_add"] });
    const manager = new McpManager(connect);
    const host = fakeHost({ servers: { alpha: { command: "fake-server" } } });

    await manager.reconcile(host);

    expect(connect).toHaveBeenCalledTimes(1);
    const names = host.registry.list().map((t) => t.name);
    expect(names).toContain("mcp_alpha_echo");
    expect(names).toContain("mcp_alpha_add");
    expect(manager.list()).toEqual([{ serverId: "alpha", tools: ["mcp_alpha_echo", "mcp_alpha_add"] }]);
  });

  it("skips disabled entries and entries without exactly one transport", async () => {
    const { connect } = fakeConnect({});
    const manager = new McpManager(connect);
    const host = fakeHost({
      servers: {
        off: { command: "x", enabled: false },
        neither: {},
        both: { command: "x", url: "http://localhost:1234/mcp" },
      },
    });

    await manager.reconcile(host);

    expect(connect).not.toHaveBeenCalled();
  });

  it("is idempotent for unchanged config", async () => {
    const { connect, closed } = fakeConnect({ alpha: ["mcp_alpha_echo"] });
    const manager = new McpManager(connect);
    const host = fakeHost({ servers: { alpha: { command: "fake-server" } } });

    await manager.reconcile(host);
    await manager.reconcile(host);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(closed).toEqual([]);
  });

  it("restarts a server whose config changed and drops one that was removed", async () => {
    const { connect, closed } = fakeConnect({ alpha: ["mcp_alpha_echo"], beta: ["mcp_beta_b"] });
    const manager = new McpManager(connect);
    const host = fakeHost({
      servers: { alpha: { command: "fake-server" }, beta: { command: "other" } },
    });
    await manager.reconcile(host);

    host.servers = { alpha: { command: "fake-server", args: ["--new-flag"] } };
    await manager.reconcile(host);

    expect(closed.sort()).toEqual(["alpha", "beta"]);
    expect(connect).toHaveBeenCalledTimes(3); // alpha, beta, alpha-restart
    expect(host.registry.list().map((t) => t.name)).toEqual(["mcp_alpha_echo"]);
  });

  it("tolerates a failing server and keeps starting the rest, then retries next pass", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failures = new Set(["bad"]);
    const { connect } = fakeConnect({ bad: ["mcp_bad_x"], good: ["mcp_good_y"] }, failures);
    const manager = new McpManager(connect);
    const host = fakeHost({ servers: { bad: { command: "bad" }, good: { command: "good" } } });

    await manager.reconcile(host);
    expect(host.registry.list().map((t) => t.name)).toEqual(["mcp_good_y"]);
    expect(errSpy).toHaveBeenCalled();

    failures.clear();
    await manager.reconcile(host);
    expect(
      host.registry
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["mcp_bad_x", "mcp_good_y"]);
  });

  it("re-registers tools into a fresh registry after a runtime reload", async () => {
    const { connect, closed } = fakeConnect({ alpha: ["mcp_alpha_echo"] });
    const manager = new McpManager(connect);
    const host = fakeHost({ servers: { alpha: { command: "fake-server" } } });
    await manager.reconcile(host);

    // runtime.reload() swaps in a brand-new ToolRegistry; connections live on.
    host.registry = new ToolRegistry();
    await manager.reconcile(host);

    expect(closed).toEqual([]); // unchanged config — no reconnect
    expect(connect).toHaveBeenCalledTimes(1);
    expect(host.registry.list().map((t) => t.name)).toEqual(["mcp_alpha_echo"]);
  });

  it("stopAll closes connections and unregisters tools", async () => {
    const { connect, closed } = fakeConnect({ alpha: ["mcp_alpha_echo"] });
    const manager = new McpManager(connect);
    const host = fakeHost({ servers: { alpha: { command: "fake-server" } } });
    await manager.reconcile(host);

    await manager.stopAll(host);

    expect(closed).toEqual(["alpha"]);
    expect(host.registry.list()).toEqual([]);
    expect(manager.list()).toEqual([]);
  });
});
