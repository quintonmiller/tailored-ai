import type { McpServerConfig } from "../config.js";
import type { Tool, ToolResult } from "../tools/interface.js";

/**
 * MCP client — connects to one configured server, discovers its tools, and
 * wraps each as a TAI {@link Tool}. The `@modelcontextprotocol/sdk` package
 * is an optional dependency loaded dynamically on first connect (same
 * pattern as pdf-parse / playwright), so core compiles and runs without it;
 * structural types below stand in for the SDK's so no SDK types leak into
 * core's published declarations.
 */

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Structural slice of the SDK's Client — only what core calls. */
interface SdkClient {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number },
  ): Promise<{ content?: unknown; isError?: boolean }>;
  setNotificationHandler(schema: unknown, handler: () => void): void;
  fallbackNotificationHandler?: (notification: { method: string }) => Promise<void>;
}

interface SdkModules {
  Client: new (info: { name: string; version: string }) => SdkClient;
  StdioClientTransport: new (opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stderr?: "ignore" | "inherit" | "pipe";
  }) => unknown;
  StreamableHTTPClientTransport: new (
    url: URL,
    opts?: { requestInit?: { headers?: Record<string, string> } },
  ) => unknown;
  getDefaultEnvironment: () => Record<string, string>;
}

let sdkPromise: Promise<SdkModules> | undefined;

/**
 * Import the SDK's client entry points once. The `as string` specifiers keep
 * tsc from statically resolving the optional dependency — core must compile
 * in environments where the package isn't installed.
 */
async function loadSdk(): Promise<SdkModules> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      try {
        const [client, stdio, http] = await Promise.all([
          import("@modelcontextprotocol/sdk/client/index.js" as string),
          import("@modelcontextprotocol/sdk/client/stdio.js" as string),
          import("@modelcontextprotocol/sdk/client/streamableHttp.js" as string),
        ]);
        return {
          Client: client.Client,
          StdioClientTransport: stdio.StdioClientTransport,
          StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
          getDefaultEnvironment: stdio.getDefaultEnvironment,
        } as SdkModules;
      } catch (err) {
        sdkPromise = undefined; // allow retry after the user installs
        throw new Error(
          `MCP support requires the "@modelcontextprotocol/sdk" package (optional dependency). ` +
            `Install it next to @tailored-ai/core: npm install @modelcontextprotocol/sdk — (${(err as Error).message})`,
        );
      }
    })();
  }
  return sdkPromise;
}

/** A live connection to one MCP server plus its discovered TAI tools. */
export interface McpConnection {
  serverId: string;
  /** Discovered tools, already filtered by the server's `tools` allowlist and named `mcp_<server>_<tool>`. */
  tools: Tool[];
  close(): Promise<void>;
}

export interface ConnectOptions {
  /**
   * Called when the server emits `notifications/tools/list_changed` — the
   * manager re-discovers and re-registers. Best-effort: servers aren't
   * required to send it.
   */
  onToolListChanged?: () => void;
  /**
   * Called when the connection drops on its own — the stdio child exited, or
   * the HTTP endpoint stopped answering.
   *
   * Nothing watched for this before, and the consequence was not a noisy log
   * but a permanently dead server: the connection stayed in the manager's
   * active set with an unchanged config signature, so reconcile skipped it
   * forever. Its tools stayed registered and every call returned
   * "MCP call failed", which the agent cannot distinguish from a bad request.
   */
  onClose?: () => void;
  /** Test seam: bypass config-driven transport construction. */
  createTransport?: () => Promise<unknown> | unknown;
}

/**
 * Whether a failure means "a human must go and fix a credential".
 *
 * Worth separating from every other failure because the response differs: a
 * 503 wants a retry, an expired token wants a person. Notion PATs expire (a
 * year at most), so this is a scheduled outage the deployment should be able to
 * name rather than discover through an agent behaving oddly.
 */
export function isAuthFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b(401|403)\b|unauthorized|forbidden|invalid[_ -]?(token|api[_ -]?key|credentials)|authentication failed|expired[_ -]?token/i.test(
    msg,
  );
}

/**
 * Connect to one MCP server described by config, list its tools, and wrap
 * them as TAI tools. Throws on unreachable server, bad config, or missing
 * SDK — the manager catches per-server so one bad server doesn't take the
 * rest down.
 */
export async function connectMcpServer(
  serverId: string,
  cfg: McpServerConfig,
  opts: ConnectOptions = {},
): Promise<McpConnection> {
  const sdk = await loadSdk();

  let transport: unknown;
  if (opts.createTransport) {
    transport = await opts.createTransport();
  } else if (cfg.command) {
    transport = new sdk.StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      // The SDK spawns with a minimal safe env when none is given; an
      // explicit env REPLACES that set, so merge to keep PATH etc. intact.
      env: cfg.env ? { ...sdk.getDefaultEnvironment(), ...cfg.env } : undefined,
      cwd: cfg.cwd,
      stderr: "ignore",
    });
  } else if (cfg.url) {
    transport = new sdk.StreamableHTTPClientTransport(
      new URL(cfg.url),
      cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
    );
  } else {
    throw new Error(`mcp.servers.${serverId}: needs either "command" or "url"`);
  }

  const client = new sdk.Client({ name: "tailored-ai", version: "0.0.0" });
  await client.connect(transport);

  if (opts.onClose) {
    // Assigned defensively: `onclose` is on the SDK's Protocol base class, but
    // the structural type here deliberately does not model the whole SDK.
    (client as unknown as { onclose?: () => void }).onclose = () => opts.onClose?.();
  }

  if (opts.onToolListChanged) {
    // Catch-all handler instead of a schema-bound one so we don't need the
    // SDK's zod schemas (which would defeat the structural-type isolation).
    client.fallbackNotificationHandler = async (notification) => {
      if (notification.method === "notifications/tools/list_changed") opts.onToolListChanged?.();
    };
  }

  const tools = await discoverTools(client, serverId, cfg);
  const connection: McpConnection = {
    serverId,
    tools,
    close: () => client.close(),
  };
  connectionClients.set(connection, client);
  return connection;
}

/** Re-list a connection's tools (after a list_changed notification). */
export async function rediscoverTools(connection: McpConnection, cfg: McpServerConfig): Promise<Tool[]> {
  const inner = connectionClients.get(connection);
  if (!inner) return connection.tools;
  const tools = await discoverTools(inner, connection.serverId, cfg);
  connection.tools = tools;
  return tools;
}

/** Client handle per connection, kept out of the public McpConnection shape. */
const connectionClients = new WeakMap<McpConnection, SdkClient>();

async function discoverTools(client: SdkClient, serverId: string, cfg: McpServerConfig): Promise<Tool[]> {
  const listed = await client.listTools();
  const allow = cfg.tools && cfg.tools.length > 0 ? new Set(cfg.tools) : undefined;
  const tools: Tool[] = [];
  for (const t of listed.tools) {
    if (allow && !allow.has(t.name)) continue;
    tools.push(wrapMcpTool(client, serverId, t, cfg));
  }
  return tools;
}

function wrapMcpTool(
  client: SdkClient,
  serverId: string,
  mcpTool: { name: string; description?: string; inputSchema?: Record<string, unknown> },
  cfg: McpServerConfig,
): Tool {
  return {
    name: mcpToolName(serverId, mcpTool.name),
    description: truncateDescription(mcpTool.description ?? `${mcpTool.name} (MCP tool from ${serverId})`),
    parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
    async execute(args): Promise<ToolResult> {
      try {
        const result = await client.callTool({ name: mcpTool.name, arguments: args }, undefined, {
          timeout: cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        });
        const output = renderContent(result.content);
        if (result.isError) {
          return { success: false, output, error: output || "MCP tool reported an error" };
        }
        return { success: true, output };
      } catch (err) {
        return { success: false, output: "", error: `MCP call failed: ${(err as Error).message}` };
      }
    },
  };
}

/**
 * `mcp_<server>_<tool>`, sanitized to the provider-safe charset
 * `[a-zA-Z0-9_-]` and capped at 64 chars (OpenAI's function-name limit).
 */
export function mcpToolName(serverId: string, toolName: string): string {
  const sane = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp_${sane(serverId)}_${sane(toolName)}`.slice(0, 64);
}

/** Tool descriptions stay short for local-model compatibility. */
function truncateDescription(desc: string): string {
  const oneLine = desc.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}...` : oneLine;
}

/**
 * Flatten an MCP content array (text / image / audio / resource blocks)
 * into the string a TAI ToolResult carries. Non-text blocks become short
 * markers — the loop's tool results are text-only today.
 */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : String(content);
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    switch (block?.type) {
      case "text":
        parts.push(String(block.text ?? ""));
        break;
      case "resource": {
        const res = block.resource as Record<string, unknown> | undefined;
        if (res && typeof res.text === "string") parts.push(res.text);
        else parts.push(`[resource: ${res?.uri ?? "unknown"}]`);
        break;
      }
      case "resource_link":
        parts.push(`[resource link: ${block.uri ?? "unknown"}]`);
        break;
      case "image":
      case "audio":
        parts.push(`[${block.type} content (${block.mimeType ?? "unknown type"})]`);
        break;
      default:
        parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}
