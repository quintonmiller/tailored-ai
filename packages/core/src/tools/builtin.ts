/**
 * Built-in tool factories — every always-available tool that previously lived
 * as an if-chain in createTools() now registers through the same ToolFactory
 * registry that external plugins use. The only difference between a built-in
 * and a plugin tool is that built-ins are registered here on module import
 * (side-effect import from factories.ts) before any plugin loading happens.
 *
 * Construction args that need runtime state (db, contextDir, resolveOutbound,
 * …) flow through ToolFactoryContext. The factories read exactly what they
 * need from ctx — no more, no less.
 *
 * Importing this module side-effect-registers all built-in factories.
 */

import { resolve } from "node:path";
import { IdentityResolver } from "../rooms/identities.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { getRoomBackend, listRoomBackends, registerRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { createEgressPolicy } from "../security/egress-policy.js";
import { createTaskBackend } from "../tasks/factory.js";
import { AskUserTool } from "./ask-user.js";
import { BrowserTool } from "./browser.js";
import { ClaudeCodeTool } from "./claude-code.js";
import { CollectionsTool } from "./collections.js";
import { createCustomTools } from "./custom.js";
import { DocumentsTool } from "./documents.js";
import { EditTool } from "./edit.js";
import { ExecTool } from "./exec.js";
import { ExtractDocumentTool } from "./extract-document.js";
import { FactsTool } from "./facts.js";
import { MdToPdfTool } from "./md-to-pdf.js";
import { MemoryTool } from "./memory.js";
import { NotifyOwnerTool } from "./notify-owner.js";
import { ProjectsTool } from "./projects.js";
import { ReadTool } from "./read.js";
import { RecallTool } from "./recall.js";
import { RoomTool } from "./room.js";
import { TaskQueryTool, TasksTool } from "./tasks.js";
import { registerToolFactory } from "./tool-factories.js";
import { WebFetchTool } from "./web-fetch.js";
import { WebSearchTool } from "./web-search.js";
import { WriteTool } from "./write.js";

// ---------------------------------------------------------------------------
// Core read/write/exec tools — enabled by default (opt-out with enabled: false)
// ---------------------------------------------------------------------------

registerToolFactory("memory", (config, ctx) => {
  if (config.tools.memory?.enabled === false) return [];
  if (!ctx.contextDir) return [];
  const globalDir = resolve(ctx.contextDir, "global");
  return [new MemoryTool(globalDir)];
});

registerToolFactory("exec", (config) => {
  if (config.tools.exec?.enabled === false) return [];
  const scratchDir = process.env.TAI_HOME ? resolve(process.env.TAI_HOME, "exec-outputs") : undefined;
  return [new ExecTool(config.tools.exec?.allowedCommands, undefined, scratchDir)];
});

registerToolFactory("read", (config) => {
  if (config.tools.read?.enabled === false) return [];
  return [new ReadTool(config.tools.read?.allowedPaths)];
});

registerToolFactory("write", (config) => {
  if (config.tools.write?.enabled === false) return [];
  return [new WriteTool(config.tools.write?.allowedPaths)];
});

registerToolFactory("edit", (config) => {
  if (config.tools.edit?.enabled === false) return [];
  return [new EditTool(config.tools.edit?.allowedPaths ?? config.tools.write?.allowedPaths)];
});

registerToolFactory("web_fetch", (config) => {
  if (config.tools.web_fetch?.enabled === false) return [];
  return [new WebFetchTool(undefined, createEgressPolicy(config.security?.egress))];
});

// ---------------------------------------------------------------------------
// Optional built-ins — disabled by default (opt-in with enabled: true)
// ---------------------------------------------------------------------------

registerToolFactory("web_search", (config) => {
  if (!config.tools.web_search?.enabled) return [];
  if (!config.tools.web_search.apiKey) {
    console.warn(
      "[factories] tools.web_search.enabled is true but apiKey is empty (likely an unresolved ${ENV_VAR}); tool will not be registered.",
    );
    return [];
  }
  return [new WebSearchTool(config.tools.web_search.apiKey, config.tools.web_search.maxResults)];
});

registerToolFactory("facts", (config, ctx) => {
  if (config.tools.facts?.enabled === false) return [];
  if (!ctx.db) return [];
  return [new FactsTool(ctx.db, { getMemoryBackend: ctx.getMemoryBackend })];
});

registerToolFactory("recall", (config, ctx) => {
  if (config.tools.recall?.enabled === false) return [];
  if (!ctx.db) return [];
  return [
    new RecallTool(ctx.db, {
      defaultTtlDays: config.tools.recall?.defaultTtlDays,
      getEmbedder: ctx.getEmbedder,
      embedModel: config.memory?.embeddings?.model,
      getMemoryBackend: ctx.getMemoryBackend,
    }),
  ];
});

// tasks + task_query are coupled: they must share the same backend / resolver.
registerToolFactory("tasks", (config, ctx) => {
  if (config.tools.tasks?.enabled === false) return [];
  const resolver = ctx.taskBackendResolver;
  const backend = ctx.taskBackend ?? (ctx.db ? createTaskBackend(config, ctx.db) : undefined);
  const tasksOpts = ctx.events ? { events: ctx.events } : undefined;
  if (resolver) {
    return [new TasksTool(resolver, ctx.db, ctx.notifyTaskEvent, tasksOpts), new TaskQueryTool(resolver)];
  }
  if (backend) {
    return [new TasksTool(backend, ctx.db, ctx.notifyTaskEvent, tasksOpts), new TaskQueryTool(backend)];
  }
  return [];
});

registerToolFactory("notify_owner", (config, ctx) => {
  if (!config.tools.notify_owner?.enabled) return [];
  if (!ctx.resolveOutbound) {
    console.warn(
      "[factories] tools.notify_owner.enabled is true but no outbound accessor was wired by the host; tool will not be registered.",
    );
    return [];
  }
  const channel = config.tools.notify_owner.channel;
  const resolveOutbound = ctx.resolveOutbound;
  const getOwnerId = ctx.getOwnerId ?? (() => undefined);
  return [
    new NotifyOwnerTool(
      (id) => resolveOutbound(id ?? channel),
      (id) => getOwnerId(id ?? channel),
      ctx.getNotificationGate,
    ),
  ];
});

// The room tool registers whenever there's a database, NOT only when a room
// transport is connected. resolveAgent throws on unknown tool names
// (agents.ts), so an agent listing `room` would fail to resolve at all during
// a Discord outage — the tool itself reports "no backend connected" instead,
// which is a recoverable state rather than a broken agent.
registerToolFactory("room", (config, ctx) => {
  if (config.tools.room?.enabled === false) return [];
  if (!ctx.db) return [];
  const db = ctx.db;
  const store = new RoomStore(db);

  // The `local` backend is registered by AgentRuntime.getRoomStore(), which
  // only the long-running server path calls. Single-message and CLI runs build
  // tools without ever touching it, so the tool would come up with no backends
  // at all. Registering here too makes `room create` work in every mode.
  if (!getRoomBackend("local")) registerRoomBackend(new LocalRoomBackend(db, store));

  const getOwnerId = ctx.getOwnerId;
  const buildIdentities = () => {
    const ownerNativeIds: Record<string, string> = {};
    for (const backend of listRoomBackends()) {
      const id = getOwnerId?.(backend.id);
      if (id) ownerNativeIds[backend.id] = id;
    }
    return new IdentityResolver({
      agentNames: Object.keys(config.agents ?? {}),
      declared: config.rooms?.identities,
      ownerNativeIds,
      ownerLabel: config.rooms?.ownerLabel,
      defaultBackend: config.defaultChannel,
    });
  };
  return [
    new RoomTool({
      store,
      identities: buildIdentities,
      getNotificationGate: ctx.getNotificationGate,
      urgencyWindowHours: () => config.rooms?.urgencyWindowHours,
      defaultBackend: () => config.rooms?.defaultBackend,
      desks: () => config.rooms?.desks,
      deliverAgentMessage: ctx.deliverAgentMessage as
        | ((to: string, from: string, body: string) => Promise<string>)
        | undefined,
    }),
  ];
});

registerToolFactory("claude_code", (config) => {
  if (!config.tools.claude_code?.enabled) return [];
  return [new ClaudeCodeTool(config.tools.claude_code)];
});

registerToolFactory("browser", (config) => {
  if (!config.tools.browser?.enabled) return [];
  return [new BrowserTool(config.tools.browser)];
});

registerToolFactory("md_to_pdf", (config) => {
  if (!config.tools.md_to_pdf?.enabled) return [];
  return [new MdToPdfTool()];
});

registerToolFactory("projects", (config, ctx) => {
  if (config.tools.projects?.enabled === false) return [];
  if (!ctx.db) return [];
  return [new ProjectsTool(ctx.db)];
});

registerToolFactory("collections", (config, ctx) => {
  if (config.tools.collections?.enabled === false) return [];
  if (!ctx.db) return [];
  return [new CollectionsTool(ctx.db)];
});

registerToolFactory("documents", (config, ctx) => {
  if (config.tools.documents?.enabled === false) return [];
  if (!ctx.db) return [];
  const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
  return [new DocumentsTool(ctx.db, dir)];
});

registerToolFactory("extract_document", (config, ctx) => {
  if (!config.tools.extract_document?.enabled) return [];
  const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
  return [new ExtractDocumentTool({ db: ctx.db, projectsDir: dir })];
});

registerToolFactory("ask_user", (config, ctx) => {
  if (config.tools.ask_user?.enabled === false) return [];
  if (!ctx.contextDir) return [];
  return [
    new AskUserTool({
      contextDir: ctx.contextDir,
      // Event-driven delivery (#205): the tool emits question.asked and the
      // owner-notifier plugin (or any subscriber) delivers it.
      events: ctx.events,
      inboxFile: config.tools.ask_user?.inboxFile ?? "inbox.md",
    }),
  ];
});

// custom_tools: synthesised on-the-fly from config — no class instances exist
// until construction time.
registerToolFactory("__custom_tools__", (config) => {
  if (!config.custom_tools) return [];
  return createCustomTools(config.custom_tools);
});
