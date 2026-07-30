/**
 * What happens when an MCP server dies or its credential stops working.
 *
 * Neither was handled. Nothing registered an `onclose`, so a dropped connection
 * stayed in the manager's active set with an unchanged config signature — and
 * reconcile skips anything whose signature matches, so it was never restarted.
 * The server stayed dead until a config change or a process restart, its tools
 * stayed registered, and every call returned "MCP call failed" to the agent.
 *
 * An expired credential looked identical to a network blip, which matters
 * because only one of them can be fixed by waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config.js";
import type { McpConnection } from "../mcp/client.js";
import { isAuthFailure } from "../mcp/client.js";
import { McpManager } from "../mcp/manager.js";
import { ToolRegistry } from "../resources/tool-registry.js";
import type { Tool } from "../tools/interface.js";

let logs: string[];

beforeEach(() => {
  logs = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
  }
});

afterEach(() => vi.restoreAllMocks());

const tool = (name: string): Tool =>
  ({ name, description: "d", parameters: {}, execute: async () => ({ success: true, output: "" }) }) as Tool;

function makeHost(servers: Record<string, McpServerConfig>) {
  const registry = new ToolRegistry();
  return {
    registry,
    host: { getConfig: () => ({ mcp: { servers } }), getToolRegistry: () => registry },
  };
}

const CFG: McpServerConfig = { command: "npx", args: ["-y", "server"] } as McpServerConfig;

describe("McpManager — a dropped connection comes back", () => {
  it("reconnects after the server drops, instead of staying dead forever", async () => {
    const { host, registry } = makeHost({ notion: CFG });
    let connects = 0;
    let drop: (() => void) | undefined;
    const pending: Array<() => void> = [];

    const mgr = new McpManager(
      async (id, _cfg, opts) => {
        connects++;
        drop = opts?.onClose;
        return { serverId: id, tools: [tool("mcp_notion_search")], close: async () => {} } as McpConnection;
      },
      () => 0, // frozen clock: backoff never expires on its own
      (fn) => pending.push(fn), // capture the scheduled retry instead of waiting
    );

    await mgr.reconcile(host);
    expect(connects).toBe(1);
    expect(registry.list().map((t) => t.name)).toContain("mcp_notion_search");

    // The server dies.
    drop?.();
    // Its tools must not linger — a registered tool that always fails is worse
    // than an absent one, because the model keeps choosing it.
    expect(registry.list().map((t) => t.name)).not.toContain("mcp_notion_search");
    expect(logs.join("\n")).toContain("connection lost");

    // The scheduled retry actually reconnects.
    expect(pending).toHaveLength(1);
    pending[0]();
    await new Promise((r) => setTimeout(r, 5));
    expect(connects).toBe(2);
  });

  it("does not resurrect a server that was deliberately removed from config", async () => {
    const servers: Record<string, McpServerConfig> = { notion: CFG };
    const { host } = makeHost(servers);
    let drop: (() => void) | undefined;
    const mgr = new McpManager(async (id, _c, opts) => {
      drop = opts?.onClose;
      return { serverId: id, tools: [], close: async () => {} } as McpConnection;
    });

    await mgr.reconcile(host);
    delete servers.notion;
    await mgr.reconcile(host); // deliberate teardown

    // A late close callback from the torn-down connection must be a no-op.
    drop?.();
    expect(logs.join("\n")).not.toContain("connection lost");
  });
});

describe("McpManager — a rejected credential says so", () => {
  it("names it as an auth failure and says retrying will not help", async () => {
    const { host } = makeHost({ notion: CFG });
    const mgr = new McpManager(async () => {
      throw new Error("HTTP 401 Unauthorized");
    });

    await mgr.reconcile(host);

    const said = logs.join("\n");
    expect(said).toContain("AUTH FAILED");
    expect(said).toContain("mcp.servers.notion");
    expect(said).toContain("will not fix it");
  });

  it("reports an ordinary failure as retryable, without crying wolf", async () => {
    const { host } = makeHost({ notion: CFG });
    const mgr = new McpManager(async () => {
      throw new Error("ECONNREFUSED");
    });

    await mgr.reconcile(host);

    const said = logs.join("\n");
    expect(said).toContain("failed to connect");
    expect(said).not.toContain("AUTH FAILED");
  });

  it("always retries on an explicit reconcile — you may have just fixed the token", async () => {
    // The backoff must never make "fix the credential, reload config" a no-op.
    // Startup and config reload are human-driven; only self-driven retries wait.
    const { host } = makeHost({ notion: CFG });
    let attempts = 0;
    const mgr = new McpManager(
      async () => {
        attempts++;
        throw new Error("401 unauthorized");
      },
      () => 0, // clock frozen: a backoff, if applied, would never elapse
    );

    await mgr.reconcile(host);
    await mgr.reconcile(host);
    await mgr.reconcile(host);

    expect(attempts).toBe(3);
  });

  it("escalates the wait when a server keeps dropping, rather than spinning", async () => {
    const { host } = makeHost({ notion: CFG });
    const waits: number[] = [];
    let drop: (() => void) | undefined;
    const mgr = new McpManager(
      async (id, _c, opts) => {
        drop = opts?.onClose;
        return { serverId: id, tools: [], close: async () => {} } as McpConnection;
      },
      () => 0, // never stable, so the counter must not reset
      (fn, ms) => {
        waits.push(ms);
        fn();
      },
    );

    await mgr.reconcile(host);
    drop?.();
    await new Promise((r) => setTimeout(r, 5));
    drop?.();
    await new Promise((r) => setTimeout(r, 5));

    expect(waits.length).toBeGreaterThanOrEqual(2);
    // A flapping server must not retry at a fixed 1s forever.
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });

  it("retries once the backoff has elapsed", async () => {
    const { host } = makeHost({ notion: CFG });
    let attempts = 0;
    let clock = 0;
    const mgr = new McpManager(
      async () => {
        attempts++;
        throw new Error("ECONNREFUSED");
      },
      () => clock,
    );

    await mgr.reconcile(host);
    clock = 60 * 60_000; // an hour later
    await mgr.reconcile(host);

    expect(attempts).toBe(2);
  });

  it("announces recovery, so the log shows the outage ending", async () => {
    const { host } = makeHost({ notion: CFG });
    let clock = 0;
    let fail = true;
    const mgr = new McpManager(
      async (id) => {
        if (fail) throw new Error("ECONNREFUSED");
        return { serverId: id, tools: [], close: async () => {} } as McpConnection;
      },
      () => clock,
    );

    await mgr.reconcile(host);
    fail = false;
    clock = 60 * 60_000;
    await mgr.reconcile(host);

    expect(logs.join("\n")).toContain("recovered");
  });

  it("surfaces per-server state for a health view", async () => {
    const { host } = makeHost({ notion: CFG });
    const mgr = new McpManager(async () => {
      throw new Error("403 forbidden");
    });

    await mgr.reconcile(host);
    const [s] = mgr.status();

    expect(s.id).toBe("notion");
    expect(s.connected).toBe(false);
    expect(s.authFailure).toBe(true);
  });
});

describe("isAuthFailure", () => {
  it("recognises the shapes a rejected credential actually arrives in", () => {
    for (const m of [
      "HTTP 401 Unauthorized",
      "Request failed: 403",
      "invalid_token",
      "invalid api key",
      "authentication failed",
      "expired token",
    ]) {
      expect(isAuthFailure(new Error(m))).toBe(true);
    }
  });

  it("does not claim a transport problem is a credential problem", () => {
    for (const m of ["ECONNREFUSED", "socket hang up", "timeout after 30000ms", "500 Internal Server Error"]) {
      expect(isAuthFailure(new Error(m))).toBe(false);
    }
  });
});
