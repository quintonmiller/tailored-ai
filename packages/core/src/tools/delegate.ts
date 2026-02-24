import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import { executeHooks } from "../agent/hooks.js";
import { runAgentLoop } from "../agent/loop.js";
import { type ResolvedAgent, resolveAgent } from "../agent/agents.js";
import { newSession } from "../agent/session.js";
import { startTask } from "../agent/tasks.js";
import type { AgentConfig } from "../config.js";
import { ensureContextDir } from "../context.js";
import type { AIProvider } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface DelegateToolOptions {
  getConfig: () => AgentConfig;
  db: Database.Database;
  getProvider: () => AIProvider;
  getTools: () => Tool[];
  contextDir: string;
  kbDir: string;
}

export class DelegateTool implements Tool {
  name = "delegate";
  description = "Delegate a task to a sub-agent with a specific agent configuration.";
  parameters = {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent name to use for the sub-agent." },
      task: { type: "string", description: "The task to delegate to the sub-agent." },
      async: { type: "boolean", description: "If true, run in background and return a task ID." },
    },
    required: ["agent", "task"],
  };

  private getConfig: () => AgentConfig;
  private db: Database.Database;
  private getProvider: () => AIProvider;
  private getTools: () => Tool[];
  private contextDir: string;
  private kbDir: string;

  constructor(opts: DelegateToolOptions) {
    this.getConfig = opts.getConfig;
    this.db = opts.db;
    this.getProvider = opts.getProvider;
    this.getTools = opts.getTools;
    this.contextDir = opts.contextDir;
    this.kbDir = opts.kbDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Accept both "agent" and legacy "profile" parameter names
    const agentName = (args.agent ?? args.profile) as string;
    const task = args.task as string;
    const runAsync = args.async === true;

    if (!agentName || !task) {
      return { success: false, output: "", error: 'Both "agent" and "task" are required.' };
    }

    const config = this.getConfig();
    const allTools = this.getTools();

    let resolved: ResolvedAgent;
    try {
      resolved = resolveAgent(agentName, config, allTools, undefined, this.contextDir, this.kbDir);
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }

    // Ensure agent context dir exists before running sub-agent
    if (resolved.contextDir) {
      await ensureContextDir(resolved.contextDir);
    }

    const runDelegate = async (): Promise<string> => {
      const sessionKey = `delegate:${context.sessionId}:${randomUUID()}`;
      const session = newSession(this.db, resolved.model, resolved.provider, sessionKey);
      const logPrefix = `[delegate] [${agentName}]`;
      const allTools = this.getTools();

      // --- beforeRun hooks ---
      if (resolved.hooks.beforeRun.length > 0) {
        const { skipped } = await executeHooks(resolved.hooks.beforeRun, allTools, {}, session.id, logPrefix);
        if (skipped) return "(skipped by beforeRun hook)";
      }

      const response = await runAgentLoop(task, {
        provider: this.getProvider(),
        session,
        db: this.db,
        tools: resolved.tools,
        extraInstructions: resolved.instructions,
        maxToolRounds: resolved.maxToolRounds,
        maxHistoryTokens: config.agent.maxHistoryTokens,
        temperature: resolved.temperature,
        contextDir: this.contextDir,
        agentContextDir: resolved.contextDir,
        kbDir: resolve(this.kbDir, "global"),
        agentKbDir: resolved.kbDir,
        permissions: context.permissions,
        approvalHandler: context.approvalHandler,
      });

      // --- afterRun hooks ---
      if (resolved.hooks.afterRun.length > 0) {
        await executeHooks(resolved.hooks.afterRun, allTools, { response: response ?? "" }, session.id, logPrefix);
      }

      return response;
    };

    if (runAsync) {
      const info = startTask(task, runDelegate);
      return { success: true, output: `Background task started: ${info.id}` };
    }

    try {
      const response = await runDelegate();
      return { success: true, output: response };
    } catch (err) {
      return { success: false, output: "", error: `Sub-agent error: ${(err as Error).message}` };
    }
  }
}
