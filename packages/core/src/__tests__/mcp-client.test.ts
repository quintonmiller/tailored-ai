/**
 * Tests for the MCP client against a real SDK server over an in-memory
 * transport pair — discovery mapping, allowlists, name sanitization, call
 * result rendering, and error normalization, with no child processes.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../config.js";
import { connectMcpServer, type McpConnection, mcpToolName } from "../mcp/client.js";

const FIXTURE_TOOLS = [
  {
    name: "echo",
    description: "Echo the input back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    },
  },
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "weird/name with spaces",
    description: "Name needs sanitizing.",
    inputSchema: { type: "object", properties: {} },
  },
];

/** Start a fixture MCP server and connect the TAI client to it in-memory. */
async function connectFixture(cfg: McpServerConfig = {}, serverId = "fixture"): Promise<McpConnection> {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FIXTURE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "echo") {
      return { content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }] };
    }
    if (name === "add") {
      const { a, b } = args as { a: number; b: number };
      return { content: [{ type: "text", text: String(a + b) }] };
    }
    return { content: [{ type: "text", text: `unsupported: ${name}` }], isError: true };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return connectMcpServer(serverId, cfg, { createTransport: () => clientTransport });
}

describe("connectMcpServer", () => {
  it("discovers tools with namespaced names and passed-through schemas", async () => {
    const conn = await connectFixture();
    const names = conn.tools.map((t) => t.name);
    expect(names).toContain("mcp_fixture_echo");
    expect(names).toContain("mcp_fixture_add");
    expect(names).toContain("mcp_fixture_weird_name_with_spaces");

    const echo = conn.tools.find((t) => t.name === "mcp_fixture_echo")!;
    expect(echo.description).toBe("Echo the input back.");
    expect(echo.parameters).toEqual(FIXTURE_TOOLS[0].inputSchema);
    await conn.close();
  });

  it("respects the per-server tool allowlist", async () => {
    const conn = await connectFixture({ tools: ["add"] });
    expect(conn.tools.map((t) => t.name)).toEqual(["mcp_fixture_add"]);
    await conn.close();
  });

  it("executes a tool call and renders text content", async () => {
    const conn = await connectFixture();
    const echo = conn.tools.find((t) => t.name === "mcp_fixture_echo")!;
    const result = await echo.execute({ text: "hi" }, {} as never);
    expect(result).toEqual({ success: true, output: "echo: hi" });
    await conn.close();
  });

  it("maps isError results to failed ToolResults", async () => {
    const conn = await connectFixture();
    const weird = conn.tools.find((t) => t.name === "mcp_fixture_weird_name_with_spaces")!;
    const result = await weird.execute({}, {} as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain("unsupported");
    await conn.close();
  });

  it("normalizes transport/protocol failures into failed ToolResults", async () => {
    const conn = await connectFixture();
    const echo = conn.tools.find((t) => t.name === "mcp_fixture_echo")!;
    await conn.close(); // connection gone — calls must fail, not throw
    const result = await echo.execute({ text: "hi" }, {} as never);
    expect(result.success).toBe(false);
    expect(result.error).toContain("MCP call failed");
  });
});

describe("mcpToolName", () => {
  it("sanitizes to the provider-safe charset and caps at 64 chars", () => {
    expect(mcpToolName("my-server", "do.thing")).toBe("mcp_my-server_do_thing");
    expect(mcpToolName("a b", "c/d")).toBe("mcp_a_b_c_d");
    expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
  });
});
