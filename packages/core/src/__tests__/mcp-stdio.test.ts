/**
 * Integration test: the real config-driven stdio path — TAI spawns a fixture
 * MCP server as a child process, discovers its tools, calls one, and shuts
 * the child down on close. Covers transport construction (command/args/env)
 * that the in-memory tests bypass.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectMcpServer } from "../mcp/client.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-stdio-server.mjs");

describe("connectMcpServer over stdio", () => {
  it("spawns the server, discovers tools, calls one, and threads env through", async () => {
    const conn = await connectMcpServer("stdio", {
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_SECRET: "s3cret" },
    });
    try {
      expect(conn.tools.map((t) => t.name).sort()).toEqual(["mcp_stdio_ping", "mcp_stdio_read_env"]);

      const ping = conn.tools.find((t) => t.name === "mcp_stdio_ping")!;
      expect(await ping.execute({}, {} as never)).toEqual({ success: true, output: "pong" });

      const readEnv = conn.tools.find((t) => t.name === "mcp_stdio_read_env")!;
      expect(await readEnv.execute({}, {} as never)).toEqual({ success: true, output: "s3cret" });
    } finally {
      await conn.close();
    }
  }, 20_000);
});
