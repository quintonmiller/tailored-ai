import { resolve } from "node:path";
import type { AgentConfig } from "./config.js";
import type { AIProvider } from "./providers/interface.js";
import { createTaskBackend } from "./tasks/factory.js";
import type { TaskBackend } from "./tasks/interface.js";
import type { Tool } from "./tools/interface.js";
import { AdminTool } from "./tools/admin.js";
import { AskUserTool } from "./tools/ask-user.js";
import { BrowserTool } from "./tools/browser.js";
import { ClaudeCodeTool } from "./tools/claude-code.js";
import { createCustomTools } from "./tools/custom.js";
import { DelegateTool } from "./tools/delegate.js";
import { LoadSkillTool } from "./tools/load-skill.js";
import { ResourceAdminTool } from "./tools/resource-admin.js";
import { ExecTool } from "./tools/exec.js";
import { FactsTool } from "./tools/facts.js";
import { RecallTool } from "./tools/recall.js";
import { GmailTool } from "./tools/gmail.js";
import { GoogleCalendarTool } from "./tools/google-calendar.js";
import { GoogleDriveTool } from "./tools/google-drive.js";
import { MdToPdfTool } from "./tools/md-to-pdf.js";
import { MemoryTool } from "./tools/memory.js";
import { ReadTool } from "./tools/read.js";
import { TaskStatusTool } from "./tools/task-status.js";
import { RunWorkflowTool } from "./tools/run-workflow.js";
import { TasksTool, TaskQueryTool } from "./tools/tasks.js";
import { ProjectsTool } from "./tools/projects.js";
import { DocumentsTool } from "./tools/documents.js";
import { ExtractDocumentTool } from "./tools/extract-document.js";
import { WebFetchTool } from "./tools/web-fetch.js";
import { WebSearchTool } from "./tools/web-search.js";
import { WriteTool } from "./tools/write.js";
import { OpenAIProvider } from "./providers/openai.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { EmbeddingProvider } from "./providers/embedding.js";
import { OpenAICompatibleEmbeddingProvider } from "./providers/openai-embedding.js";
import type { AgentRuntime } from "./runtime.js";

export interface CreateToolsOptions {
  getDiscord?: () => any;
  getOwnerId?: () => string | undefined;
  db?: import("better-sqlite3").Database;
  /** Override the task backend. Defaults to `createTaskBackend(config, db)` when `db` is provided. */
  taskBackend?: TaskBackend;
  /** Optional embedding provider getter for semantic recall. */
  getEmbedder?: () => EmbeddingProvider | undefined;
}

/**
 * Build an embedding provider from config. Returns undefined when embeddings
 * are disabled (the default) or required config is missing.
 */
export function createEmbedder(config: AgentConfig): EmbeddingProvider | undefined {
  const cfg = config.memory?.embeddings;
  if (!cfg?.enabled) return undefined;
  if (!cfg.baseUrl || !cfg.model) {
    console.warn("[factories] memory.embeddings.enabled is true but baseUrl/model missing — disabling embeddings");
    return undefined;
  }
  return new OpenAICompatibleEmbeddingProvider({
    baseUrl: cfg.baseUrl,
    defaultModel: cfg.model,
    apiKey: cfg.apiKey,
    dim: cfg.dim,
  });
}

export function createTools(
  config: AgentConfig,
  contextDir: string,
  configPath?: string,
  opts?: CreateToolsOptions,
): Tool[] {
  const globalDir = resolve(contextDir, "global");
  const tools: Tool[] = [];
  if (config.tools.memory?.enabled !== false) {
    tools.push(new MemoryTool(globalDir));
  }
  if (config.tools.exec?.enabled !== false) {
    tools.push(new ExecTool(config.tools.exec?.allowedCommands));
  }
  if (config.tools.read?.enabled !== false) {
    tools.push(new ReadTool(config.tools.read?.allowedPaths));
  }
  if (config.tools.write?.enabled !== false) {
    tools.push(new WriteTool(config.tools.write?.allowedPaths));
  }
  if (config.tools.web_fetch?.enabled !== false) {
    tools.push(new WebFetchTool());
  }
  if (config.tools.web_search?.enabled && config.tools.web_search.apiKey) {
    tools.push(new WebSearchTool(config.tools.web_search.apiKey, config.tools.web_search.maxResults));
  }
  if (config.tools.facts?.enabled !== false && opts?.db) {
    tools.push(new FactsTool(opts.db));
  }
  if (config.tools.recall?.enabled !== false && opts?.db) {
    tools.push(
      new RecallTool(opts.db, {
        defaultTtlDays: config.tools.recall?.defaultTtlDays,
        getEmbedder: opts.getEmbedder,
        embedModel: config.memory?.embeddings?.model,
      }),
    );
  }
  if (config.tools.tasks?.enabled !== false) {
    const backend = opts?.taskBackend ?? (opts?.db ? createTaskBackend(config, opts.db) : undefined);
    if (backend) {
      tools.push(new TasksTool(backend, opts?.db), new TaskQueryTool(backend));
    }
  }
  const gogPassword = process.env.GOG_KEYRING_PASSWORD ?? "";
  if (config.tools.gmail?.enabled && config.tools.gmail.account) {
    tools.push(new GmailTool(config.tools.gmail.account, gogPassword));
  }
  if (config.tools.google_calendar?.enabled && config.tools.google_calendar.account) {
    tools.push(new GoogleCalendarTool(config.tools.google_calendar.account, gogPassword));
  }
  if (config.tools.claude_code?.enabled) {
    tools.push(new ClaudeCodeTool(config.tools.claude_code));
  }
  if (config.tools.browser?.enabled) {
    tools.push(new BrowserTool(config.tools.browser));
  }
  if (config.tools.md_to_pdf?.enabled) {
    tools.push(new MdToPdfTool());
  }
  if (config.tools.google_drive?.enabled && config.tools.google_drive.account) {
    tools.push(
      new GoogleDriveTool(
        config.tools.google_drive.account,
        gogPassword,
        config.tools.google_drive.folder_name,
        config.tools.google_drive.folder_id,
        configPath,
      ),
    );
  }
  if (config.tools.projects?.enabled !== false && opts?.db) {
    tools.push(new ProjectsTool(opts.db));
  }
  if (config.tools.documents?.enabled !== false && opts?.db) {
    const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
    tools.push(new DocumentsTool(opts.db, dir));
  }
  if (config.tools.extract_document?.enabled) {
    const dir = resolve(config.tools.projects?.directory ?? "./data/projects");
    tools.push(new ExtractDocumentTool({ db: opts?.db, projectsDir: dir }));
  }
  if (config.tools.ask_user?.enabled !== false) {
    tools.push(
      new AskUserTool({
        contextDir,
        getDiscord: opts?.getDiscord ?? (() => undefined),
        getOwnerId: opts?.getOwnerId ?? (() => undefined),
      }),
    );
  }
  if (config.custom_tools) {
    tools.push(...createCustomTools(config.custom_tools));
  }
  return tools;
}

export function createProvider(config: AgentConfig): { provider: AIProvider; model: string } {
  if (config.agent.defaultProvider === "openai_compatible" && config.providers.openai_compatible) {
    const cfg = config.providers.openai_compatible;
    return {
      provider: new OpenAIProvider(cfg.apiKey, cfg.baseUrl, {
        id: "openai_compatible",
        name: cfg.name ?? "OpenAI-compatible",
      }),
      model: cfg.defaultModel,
    };
  }
  if (config.agent.defaultProvider === "openai" && config.providers.openai) {
    return {
      provider: new OpenAIProvider(config.providers.openai.apiKey, config.providers.openai.baseUrl),
      model: config.providers.openai.defaultModel,
    };
  }
  if (config.agent.defaultProvider === "anthropic" && config.providers.anthropic) {
    return {
      provider: new AnthropicProvider(config.providers.anthropic.apiKey, config.providers.anthropic.baseUrl),
      model: config.providers.anthropic.defaultModel,
    };
  }
  throw new Error(`No supported provider configured for "${config.agent.defaultProvider}".`);
}

export function createMetaTools(runtime: AgentRuntime, contextDir: string, kbDir: string): Tool[] {
  const delegateTool = new DelegateTool({
    getConfig: () => runtime.getConfig(),
    db: runtime.db,
    getProvider: () => runtime.getProvider(),
    getTools: () => runtime.getTools(),
    contextDir,
    kbDir,
  });
  const taskStatusTool = new TaskStatusTool();
  const adminTool = new AdminTool(runtime);
  const runWorkflowTool = new RunWorkflowTool({
    getEngine: () => runtime.getWorkflowEngine(),
    getRegistry: () => runtime.getWorkflows(),
  });
  const resourceAdminTool = new ResourceAdminTool({ runtime });
  const loadSkillTool = new LoadSkillTool({ getSkillRegistry: () => runtime.getSkillRegistry() });
  return [delegateTool, taskStatusTool, adminTool, runWorkflowTool, resourceAdminTool, loadSkillTool];
}
