/**
 * MCP (Model Context Protocol) client implementation.
 *
 * Connects to external MCP servers via stdio or HTTP/SSE transports,
 * discovers available tools/resources/prompts, and bridges them
 * into TAI's tool registry.
 *
 * Uses @modelcontextprotocol/sdk for protocol compliance.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { CallToolResult, ListResourcesResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

export interface McpClientConfig {
  /** Unique identifier for this MCP connection */
  id: string;
  /** Human-readable description */
  name?: string;
  /** Transport type */
  transport: "stdio" | "sse";
  /** For stdio: command to execute */
  command?: string;
  /** For stdio: command arguments */
  args?: string[];
  /** For SSE: server URL */
  url?: string;
  /** Environment variables for stdio subprocess */
  env?: Record<string, string>;
  /** Timeout in ms for each tool call (default: 30000) */
  timeout?: number;
}

export interface McpToolInfo {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * MCP client wrapper that manages lifecycle and bridges MCP tools
 * into TAI's Tool interface.
 */
export class McpClient {
  private _client: Client | null = null;
  private _transport: any = null;
  private _config: McpClientConfig;
  private _connected = false;
  private _tools: McpToolInfo[] = [];

  constructor(config: McpClientConfig) {
    this._config = config;
  }

  get id(): string {
    return this._config.id;
  }

  get name(): string {
    return this._config.name ?? this._config.id;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to the MCP server. Must be called before using tools.
   */
  async connect(): Promise<void> {
    if (this._connected) return;

    this._client = new Client({
      name: `tai-mcp-client-${this._config.id}`,
      version: "0.1.0",
    });

    if (this._config.transport === "stdio") {
      if (!this._config.command) {
        throw new Error(`MCP client "${this._config.id}": stdio transport requires 'command'`);
      }
      this._transport = new StdioClientTransport({
        command: this._config.command,
        args: this._config.args ?? [],
        env: this._config.env,
      });
    } else if (this._config.transport === "sse") {
      if (!this._config.url) {
        throw new Error(`MCP client "${this._config.id}": SSE transport requires 'url'`);
      }
      this._transport = new SSEClientTransport(new URL(this._config.url));
    } else {
      throw new Error(`MCP client "${this._config.id}": unsupported transport "${this._config.transport}"`);
    }

    await this._client.connect(this._transport);
    this._connected = true;

    // Discover available tools
    await this._discoverTools();
  }

  /**
   * Disconnect from the MCP server.
   */
  async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.close();
      this._client = null;
      this._transport = null;
      this._connected = false;
      this._tools = [];
    }
  }

  /**
   * Discover all tools offered by the MCP server.
   */
  private async _discoverTools(): Promise<void> {
    if (!this._client) return;

    try {
      const result: ListToolsResult = await this._client.request({
        jsonrpc: "2.0",
        method: "tools/list",
      }, "tools/list");

      this._tools = (result.tools ?? []).map((tool) => ({
        id: `${this._config.id}:${tool.name}`,
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? {},
      }));
    } catch (err) {
      console.warn(`[mcp] Failed to list tools from ${this._config.id}: ${(err as Error).message}`);
      this._tools = [];
    }
  }

  /**
   * Get the list of discovered tools.
   */
  getTools(): McpToolInfo[] {
    return this._tools;
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this._client) {
      throw new Error(`MCP client "${this._config.id}" is not connected`);
    }

    const timeout = this._config.timeout ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const result = await this._client.request(
        {
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        "tools/call",
      );
      clearTimeout(timer);
      return result;
    } catch (err) {
      clearTimeout(timer);
      throw new Error(`MCP tool call "${toolName}" failed: ${(err as Error).message}`);
    }
  }

  /**
   * List resources from the MCP server.
   */
  async listResources(): Promise<ListResourcesResult> {
    if (!this._client) {
      throw new Error(`MCP client "${this._config.id}" is not connected`);
    }

    return this._client.request(
      { jsonrpc: "2.0", method: "resources/list" },
      "resources/list",
    );
  }

  /**
   * Create TAI Tool wrappers for all MCP tools.
   * These can be registered with the ToolRegistry.
   */
  createTaiTools(context: Partial<ToolContext>): Tool[] {
    return this._tools.map((mcpTool) =>
      this.createTaiTool(mcpTool, context),
    );
  }

  /**
   * Create a single TAI Tool wrapper for an MCP tool.
   */
  createTaiTool(mcpTool: McpToolInfo, context: Partial<ToolContext>): Tool {
    const client = this;
    const toolName = mcpTool.name;

    return {
      name: mcpTool.id,
      description: `[MCP:${this._config.id}] ${mcpTool.description}`,
      parameters: mcpTool.parameters,

      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
        try {
          const result = await client.callTool(toolName, args);

          // MCP returns content as an array of content blocks
          const content = result.content ?? [];
          const textParts: string[] = [];

          for (const block of content) {
            if (block.type === "text") {
              textParts.push(block.text ?? "");
            } else if (block.type === "image") {
              textParts.push(`[Image: ${block.mimeType || "unknown"}]`);
            } else {
              textParts.push(JSON.stringify(block));
            }
          }

          return {
            success: !result.isError,
            output: textParts.join("\n") || "(empty result)",
            error: result.isError ? "MCP tool returned error" : undefined,
          };
        } catch (err) {
          return {
            success: false,
            output: "",
            error: (err as Error).message,
          };
        }
      },
    };
  }
}

/**
 * Factory to create an MCP client from config.
 */
export function createMcpClient(config: McpClientConfig): McpClient {
  return new McpClient(config);
}
