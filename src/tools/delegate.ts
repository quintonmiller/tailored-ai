import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AIProvider } from '../providers/interface.js';
import type { AgentConfig } from '../config.js';
import type { Tool, ToolContext, ToolResult } from './interface.js';
import { resolveProfile } from '../agent/profiles.js';
import { newSession } from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';

export interface DelegateToolOptions {
  config: AgentConfig;
  db: Database.Database;
  provider: AIProvider;
  allTools: Tool[];
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
    },
    required: ['profile', 'task'],
  };

  private config: AgentConfig;
  private db: Database.Database;
  private provider: AIProvider;
  private allTools: Tool[];
  private contextDir: string;

  constructor(opts: DelegateToolOptions) {
    this.config = opts.config;
    this.db = opts.db;
    this.provider = opts.provider;
    this.allTools = opts.allTools;
    this.contextDir = opts.contextDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const profileName = args.profile as string;
    const task = args.task as string;

    if (!profileName || !task) {
      return { success: false, output: '', error: 'Both "profile" and "task" are required.' };
    }

    let resolved;
    try {
      resolved = resolveProfile(profileName, this.config, this.allTools);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }

    const sessionKey = `delegate:${context.sessionId}:${randomUUID()}`;
    const session = newSession(this.db, resolved.model, resolved.provider, sessionKey);

    try {
      const response = await runAgentLoop(task, {
        provider: this.provider,
        session,
        db: this.db,
        tools: resolved.tools,
        extraInstructions: resolved.instructions,
        maxToolRounds: resolved.maxToolRounds,
        maxHistoryTokens: this.config.agent.maxHistoryTokens,
        temperature: resolved.temperature,
        contextDir: this.contextDir,
      });

      return { success: true, output: response };
    } catch (err) {
      return { success: false, output: '', error: `Sub-agent error: ${(err as Error).message}` };
    }
  }
}
