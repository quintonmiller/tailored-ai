export { loadConfig } from './config.js';
export { initDatabase } from './db/schema.js';
export { OllamaProvider } from './providers/ollama.js';
export { ExecTool } from './tools/exec.js';
export { ReadTool } from './tools/read.js';
export { WriteTool } from './tools/write.js';
export { WebFetchTool } from './tools/web-fetch.js';
export { WebSearchTool } from './tools/web-search.js';
export { TrelloTool } from './tools/trello.js';
export { GmailTool } from './tools/gmail.js';
export { DiscordChannel } from './channels/discord.js';
export { runAgentLoop } from './agent/loop.js';
export { newSession, loadSession, findOrCreateSession } from './agent/session.js';

export type { AgentConfig } from './config.js';
export type { AIProvider, ChatParams, ChatResponse, Message, ToolCall, ToolSchema } from './providers/interface.js';
export type { Tool, ToolContext, ToolResult } from './tools/interface.js';
export type { Channel, IncomingMessage } from './channels/interface.js';
export type { Session } from './agent/session.js';
