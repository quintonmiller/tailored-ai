/**
 * MCP servers returning media.
 *
 * MCP has always spoken in `text` / `image` / `audio` / `resource` blocks; the
 * client used to answer every non-text block with `[image content (image/png)]`
 * because a tool result could only be a string. These tests cover the other
 * side of that — and, just as importantly, that a deployment with no media
 * store configured still behaves exactly as it did.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasMedia, toolOutputText } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import { connectMcpServer, type McpConnection } from "../mcp/client.js";
import { DiskMediaStore } from "../media/disk.js";
import type { MediaStore } from "../media/interface.js";

/** A one-pixel-ish PNG: real signature plus an IHDR carrying dimensions. */
function pngBase64(): string {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(120, 16);
  buf.writeUInt32BE(60, 20);
  return buf.toString("base64");
}

const TOOLS = [
  { name: "shoot", description: "Return an image.", inputSchema: { type: "object", properties: {} } },
  { name: "describe", description: "Return text.", inputSchema: { type: "object", properties: {} } },
  { name: "both", description: "Return text and an image.", inputSchema: { type: "object", properties: {} } },
];

async function connectFixture(mediaStore?: MediaStore): Promise<McpConnection> {
  const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const image = { type: "image", data: pngBase64(), mimeType: "image/png" };
    if (req.params.name === "shoot") return { content: [image] };
    if (req.params.name === "both") {
      return { content: [{ type: "text", text: "the current view" }, image] };
    }
    return { content: [{ type: "text", text: "just words" }] };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return connectMcpServer("fixture", {}, { createTransport: () => clientTransport, mediaStore });
}

describe("MCP results carrying media", () => {
  let db: Database.Database;
  let dir: string;
  let store: DiskMediaStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "tai-mcp-media-"));
    store = new DiskMediaStore({ db, dir });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores an image block and returns it as a media part", async () => {
    const conn = await connectFixture(store);
    const tool = conn.tools.find((t) => t.name.endsWith("shoot"));
    const result = await tool?.execute({}, {} as never);
    expect(result?.success).toBe(true);
    expect(hasMedia(result?.output as never)).toBe(true);
    await conn.close();
  });

  it("keeps text and image together, in order", async () => {
    const conn = await connectFixture(store);
    const tool = conn.tools.find((t) => t.name.endsWith("both"));
    const result = await tool?.execute({}, {} as never);
    if (typeof result?.output === "string") throw new Error("expected parts");
    expect(result?.output.parts[0]).toEqual({ type: "text", text: "the current view" });
    expect(result?.output.parts[1].type).toBe("media");
    await conn.close();
  });

  it("puts the real bytes in the store, recoverable by id", async () => {
    const conn = await connectFixture(store);
    const tool = conn.tools.find((t) => t.name.endsWith("shoot"));
    const result = await tool?.execute({}, {} as never);
    if (typeof result?.output === "string") throw new Error("expected parts");
    const part = result?.output.parts[0];
    if (part?.type !== "media") throw new Error("expected media");
    const stored = await store.get(part.media.id);
    expect(stored?.ref.mimeType).toBe("image/png");
    // Dimensions come from the bytes, not from what the server claimed.
    expect(stored?.ref.width).toBe(120);
    expect(stored?.ref.height).toBe(60);
    await conn.close();
  });

  it("leaves text-only results as plain strings", async () => {
    // The common case must stay byte-identical: same string, same repeat
    // signature, same truncation behaviour as before any of this existed.
    const conn = await connectFixture(store);
    const tool = conn.tools.find((t) => t.name.endsWith("describe"));
    const result = await tool?.execute({}, {} as never);
    expect(result?.output).toBe("just words");
    await conn.close();
  });

  it("falls back to the old marker when no store is configured", async () => {
    // A deployment that has not opted into media keeps working, and is told an
    // image arrived rather than being handed an empty result.
    const conn = await connectFixture(undefined);
    const tool = conn.tools.find((t) => t.name.endsWith("shoot"));
    const result = await tool?.execute({}, {} as never);
    expect(typeof result?.output).toBe("string");
    expect(toolOutputText(result?.output)).toContain("image content");
    await conn.close();
  });
});
