/**
 * MCP Manager — orchestrates MCP clients and servers.
 *
 * Provides a unified lifecycle for all MCP connections:
 * connect, disconnect, discover tools, and bridge to TAI's tool registry.
 */
import type { McpClient, McpClientConfig } from "./client.js";
import type { McpServerAdapter, McpServerConfig } from "./server.js";
import { createMcpClient, McpClient as _McpClient } from "./client.js";
import { createMcpServer, McpServerAdapter as _McpServerAdapter } from "./server.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import type { ToolRegistry } from "../resources/tool-registry.js";

export interface McpManagerConfig {
  /** MCP client configurations */
  clients?: McpClientConfig[];
  /** MCP server configurations */
  servers?: McpServerConfig[];
}

export interface McpConnection {
  type: "client" | "server";
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
}

/**
 * Manages MCP clients and servers, handling lifecycle and tool bridging.
 */
export class McpManager {
  private _clients: Map<string, McpClient> = new Map();
  private _servers: Map<string, McpServerAdapter> = new Map();
  private _connections: McpConnection[] = [];

  /**
   * Register an MCP client configuration.
   */
  registerClient(config: McpClientConfig): McpClient {
    const client = createMcpClient(config);
    this._clients.set(config.id, client);
    this._connections.push({
      type: "client",
      id: config.id,
      status: "disconnected",
    });
    return client;
  }

  /**
   * Register an MCP server configuration.
   */
  registerServer(config: McpServerConfig): McpServerAdapter {
    const server = createMcpServer(config);
    this._servers.set(config.id, server);
    this._connections.push({
      type: "server",
      id: config.id,
      status: "disconnected",
    });
    return server;
  }

  /**
   * Connect all registered MCP clients.
   */
  async connectClients(): Promise<void> {
    for (const [id, client] of this._clients) {
      try {
        this._updateStatus(id, "client", "connecting");
        await client.connect();
        this._updateStatus(id, "client", "connected");
        console.log(`[mcp] Client "${id}" connected`);
      } catch (err) {
        this._updateStatus(id, "client", "error", (err as Error).message);
        console.error(`[mcp] Client "${id}" connection failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Start all registered MCP servers.
   */
  async startServers(): Promise<void> {
    for (const [id, server] of this._servers) {
      try {
        this._updateStatus(id, "server", "connecting");
        await server.start();
        this._updateStatus(id, "server", "connected");
        console.log(`[mcp] Server "${id}" started`);
      } catch (err) {
        this._updateStatus(id, "server", "error", (err as Error).message);
        console.error(`[mcp] Server "${id}" start failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Disconnect all MCP clients.
   */
  async disconnectClients(): Promise<void> {
    for (const [id, client] of this._clients) {
      try {
        await client.disconnect();
        this._updateStatus(id, "client", "disconnected");
      } catch (err) {
        console.error(`[mcp] Client "${id}" disconnect error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Stop all MCP servers.
   */
  async stopServers(): Promise<void> {
    for (const [id, server] of this._servers) {
      try {
        await server.stop();
        this._updateStatus(id, "server", "disconnected");
      } catch (err) {
        console.error(`[mcp] Server "${id}" stop error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Shutdown all MCP connections.
   */
  async shutdown(): Promise<void> {
    await this.disconnectClients();
    await this.stopServers();
  }

  /**
   * Get all MCP tools as TAI Tool instances, ready for registration.
   */
  getMcpTools(context: Partial<ToolContext>): Tool[] {
    const tools: Tool[] = [];
    for (const client of this._clients.values()) {
      if (client.connected) {
        tools.push(...client.createTaiTools(context));
      }
    }
    return tools;
  }

  /**
   * Register MCP tools with the tool registry.
   */
  registerToolsWithRegistry(registry: ToolRegistry, context: Partial<ToolContext>): void {
    const tools = this.getMcpTools(context);
    for (const tool of tools) {
      registry.registerBuiltin(tool, { id: tool.name });
    }
  }

  /**
   * Get connection status for all MCP connections.
   */
  getConnections(): McpConnection[] {
    return this._connections;
  }

  /**
   * Get a specific client by ID.
   */
  getClient(id: string): McpClient | undefined {
    return this._clients.get(id);
  }

  /**
   * Get a specific server by ID.
   */
  getServer(id: string): McpServerAdapter | undefined {
    return this._servers.get(id);
  }

  private _updateStatus(id: string, type: "client" | "server", status: McpConnection["status"], error?: string): void {
    const idx = this._connections.findIndex((c) => c.id === id && c.type === type);
    if (idx >= 0) {
      this._connections[idx] = { type, id, status, error };
    }
  }
}

/**
 * Factory to create an MCP manager from config.
 */
export function createMcpManager(config: McpManagerConfig): McpManager {
  const manager = new McpManager();

  for (const clientConfig of config.clients ?? []) {
    manager.registerClient(clientConfig);
  }

  for (const serverConfig of config.servers ?? []) {
    manager.registerServer(serverConfig);
  }

  return manager;
}
