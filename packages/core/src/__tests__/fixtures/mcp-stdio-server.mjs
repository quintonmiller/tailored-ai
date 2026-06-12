// Minimal MCP server over stdio for the integration test — two tools, one
// of which reads an env var so the test can verify config env threading.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stdio-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "Reply with pong.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "read_env",
      description: "Return the FIXTURE_SECRET env var.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "ping") {
    return { content: [{ type: "text", text: "pong" }] };
  }
  if (req.params.name === "read_env") {
    return { content: [{ type: "text", text: process.env.FIXTURE_SECRET ?? "(unset)" }] };
  }
  return { content: [{ type: "text", text: "unknown tool" }], isError: true };
});

await server.connect(new StdioServerTransport());
