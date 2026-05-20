/**
 * MCP (Model Context Protocol) module.
 *
 * Provides client and server support for integrating with MCP-compatible
 * tools and services, bridging them into TAI's tool registry.
 *
 * @module mcp
 */
export { McpClient, createMcpClient } from "./client.js";
export type { McpClientConfig, McpToolInfo } from "./client.js";

export { McpServerAdapter, createMcpServer } from "./server.js";
export type { McpServerConfig } from "./server.js";

export { McpManager, createMcpManager } from "./manager.js";
export type { McpManagerConfig, McpConnection } from "./manager.js";
