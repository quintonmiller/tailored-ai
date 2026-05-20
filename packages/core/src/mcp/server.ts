/**
 * MCP (Model Context Protocol) server implementation.
 *
 * Exposes TAI tools and capabilities as MCP tools via stdio or SSE transports.
 * Allows external MCP clients (e.g., Claude Desktop, Cursor, other agents)
 * to use TAI's tooling capabilities.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Tool as McpToolDef, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

export interface McpServerConfig {
  /** Unique identifier for this MCP server */
  id: string;
  /** Human-readable server name */
  name?: string;
  /** Server version */
  version?: string;
  /** Transport type */
  transport: "stdio" | "sse";
  /** For SSE: bind address */
  host?: string;
  /** For SSE: bind port */
  port?: number;
  /** Tools to expose via MCP */
  tools: Tool[];
  /** Tool context for execution */
  toolContext: Partial<ToolContext>;
  /** Whether to include tool descriptions in MCP schema */
  includeDescriptions?: boolean;
}

/**
 * MCP server that exposes TAI tools to external clients.
 */
export class McpServerAdapter {
  private _server: McpServer;
  private _config: McpServerConfig;
  private _transport: any = null;
  private _running = false;
  private _serverTools: Map<string, Tool> = new Map();

  constructor(config: McpServerConfig) {
    this._config = config;
    this._server = new McpServer({
      name: config.name ?? `tai-mcp-server-${config.id}`,
      version: config.version ?? "0.1.0",
    });

    // Register all tools with the MCP server
    this._registerTools(config.tools);
  }

  /**
   * Register tools with the MCP server.
   */
  private _registerTools(tools: Tool[]): void {
    for (const tool of tools) {
      this._serverTools.set(tool.name, tool);

      const mcpTool: McpToolDef = {
        name: tool.name,
        description: this._config.includeDescriptions ? tool.description : undefined,
        inputSchema: tool.parameters as any,
      };

      this._server.tool(tool.name, tool.description ?? "", tool.parameters as any, async (args) => {
        return this._executeTool(tool, args);
      });
    }
  }

  /**
   * Execute a TAI tool and convert the result to MCP format.
   */
  private async _executeTool(tool: Tool, args: Record<string, unknown>): Promise<CallToolResult> {
    try {
      const context: ToolContext = {
        sessionId: this._config.toolContext.sessionId ?? "mcp-server",
        workingDirectory: this._config.toolContext.workingDirectory ?? process.cwd(),
        env: this._config.toolContext.env ?? process.env as any,
        ...this._config.toolContext,
      };

      const result: ToolResult = await tool.execute(args, context);

      const content = [{
        type: "text",
        text: result.output,
      }];

      return {
        content,
        isError: !result.success,
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: `Error: ${(err as Error).message}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Start the MCP server.
   */
  async start(): Promise<void> {
    if (this._running) return;

    if (this._config.transport === "stdio") {
      this._transport = new StdioServerTransport();
      await this._server.connect(this._transport);
      this._running = true;
      console.log(`[mcp] Server "${this._config.id}" started on stdio`);
    } else if (this._config.transport === "sse") {
      // SSE transport requires an HTTP server - handled externally
      // We expose the transport for the caller to wire up
      const host = this._config.host ?? "127.0.0.1";
      const port = this._config.port ?? 3000;
      console.log(`[mcp] Server "${this._config.id}" configured for SSE at ${host}:${port}`);
      this._running = true;
    }
  }

  /**
   * Stop the MCP server.
   */
  async stop(): Promise<void> {
    if (this._transport) {
      await this._server.close();
      this._transport = null;
      this._running = false;
    }
  }

  /**
   * Get the underlying MCP server instance.
   */
  getServer(): McpServer {
    return this._server;
  }

  /**
   * Get the SSE transport for external HTTP server wiring.
   */
  createSseTransport(): SSEServerTransport {
    return new SSEServerTransport(
      { endpoint: `/mcp/${this._config.id}` },
      new URL(`http://${this._config.host ?? "127.0.0.1"}:${this._config.port ?? 3000}`),
    );
  }

  get running(): boolean {
    return this._running;
  }
}

/**
 * Factory to create an MCP server adapter.
 */
export function createMcpServer(config: McpServerConfig): McpServerAdapter {
  return new McpServerAdapter(config);
}
