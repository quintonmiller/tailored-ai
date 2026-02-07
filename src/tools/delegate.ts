import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AIProvider } from '../providers/interface.js';
import type { AgentConfig } from '../config.js';
import type { Tool, ToolContext, ToolResult } from './interface.js';
import { resolveProfile } from '../agent/profiles.js';
import { newSession } from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';
import { startTask } from '../agent/tasks.js';
import { ensureContextDir } from '../context.js';

export interface DelegateToolOptions {
  getConfig: () => AgentConfig;
  db: Database.Database;
  getProvider: () => AIProvider;
  getTools: () => Tool[];
  contextDir: string;
}

export class DelegateTool implements Tool {
  name = 'delegate';
  description = 'Delegate a task to a sub-agent with a specific profile.';
  parameters = {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'Profile name to use for the sub-agent.' },
      task: { type: 'string', description: 'The task to delegate to the sub-agent.' },
      async: { type: 'boolean', description: 'If true, run in background and return a task ID.' },
    },
    required: ['profile', 'task'],
  };

  private getConfig: () => AgentConfig;
  private db: Database.Database;
  private getProvider: () => AIProvider;
  private getTools: () => Tool[];
  private contextDir: string;

  constructor(opts: DelegateToolOptions) {
    this.getConfig = opts.getConfig;
    this.db = opts.db;
    this.getProvider = opts.getProvider;
    this.getTools = opts.getTools;
    this.contextDir = opts.contextDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const profileName = args.profile as string;
    const task = args.task as string;
    const runAsync = args.async === true;

    if (!profileName || !task) {
      return { success: false, output: '', error: 'Both "profile" and "task" are required.' };
    }

    const config = this.getConfig();
    const allTools = this.getTools();

    let resolved;
    try {
      resolved = resolveProfile(profileName, config, allTools, undefined, this.contextDir);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    // Ensure profile context dir exists before running sub-agent
    if (resolved.contextDir) {
      await ensureContextDir(resolved.contextDir);
    }

    const runDelegate = (): Promise<string> => {
      const sessionKey = `delegate:${context.sessionId}:${randomUUID()}`;
      const session = newSession(this.db, resolved.model, resolved.provider, sessionKey);

      return runAgentLoop(task, {
        provider: this.getProvider(),
        session,
        db: this.db,
        tools: resolved.tools,
        extraInstructions: resolved.instructions,
        maxToolRounds: resolved.maxToolRounds,
        maxHistoryTokens: config.agent.maxHistoryTokens,
        temperature: resolved.temperature,
        contextDir: this.contextDir,
        profileContextDir: resolved.contextDir,
      });
    };

    if (runAsync) {
      const info = startTask(task, runDelegate);
      return { success: true, output: `Background task started: ${info.id}` };
    }

    try {
      const response = await runDelegate();
      return { success: true, output: response };
    } catch (err) {
      return { success: false, output: '', error: `Sub-agent error: ${(err as Error).message}` };
    }
  }
}
