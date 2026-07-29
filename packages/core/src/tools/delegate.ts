import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { type ResolvedAgent, resolveAgent } from "../agent/agents.js";
import { executeHooks } from "../agent/hooks.js";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { startTask } from "../agent/tasks.js";
import type { AgentConfig } from "../config.js";
import { ensureContextDir } from "../context.js";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface DelegateToolOptions {
  getConfig: () => AgentConfig;
  db: Database.Database;
  getTools: () => Tool[];
  contextDir: string;
  kbDir: string;
  /**
   * The runtime, so the sub-agent's loop options come from
   * {@link AgentRuntime.buildLoopOptions} rather than being rebuilt here.
   *
   * They used to be assembled by hand, and carried 13 of the ~25 fields the
   * real one sets — missing every confinement field. A sub-agent inherited no
   * sandbox, so delegating to a `sandbox: docker` agent ran its `write`/`exec`
   * on the host; no `workingDirectoryBoundary`, so a declared `fileBoundary`
   * did not apply; and no `agentName`, so its writes were attributed to nobody.
   * `delegate` is a meta tool on every agent, so that was reachable from
   * anywhere.
   */
  runtime: AgentRuntime;
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
  private getTools: () => Tool[];
  private contextDir: string;
  private kbDir: string;
  private runtime: AgentRuntime;

  constructor(opts: DelegateToolOptions) {
    this.getConfig = opts.getConfig;
    this.db = opts.db;
    this.getTools = opts.getTools;
    this.contextDir = opts.contextDir;
    this.kbDir = opts.kbDir;
    this.runtime = opts.runtime;
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

      // The same options a top-level turn for this agent would get — sandbox,
      // boundary, agent attribution, cwd, shutdown signal — instead of a
      // hand-rolled subset. `includeMetaTools: false` keeps the sub-agent's
      // tool set exactly its own `tools:` list, as before: this is a
      // confinement fix and should not hand a sub-agent `admin` or a second
      // `delegate` on the way past.
      const base = this.runtime.buildLoopOptions({
        session,
        agentName,
        includeMetaTools: false,
      });

      const response = await runAgentLoop(task, {
        ...base,
        // The caller's approver, so a sub-agent's gated call still reaches the
        // human who asked for the delegation rather than falling through to
        // `noHandlerAction`.
        permissions: context.permissions ?? base.permissions,
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
