import { execFile } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export interface ClaudeCodeConfig {
  enabled: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  model?: string;
  timeoutMs?: number;
}

const MAX_OUTPUT_CHARS = 8000;

export class ClaudeCodeTool implements Tool {
  name = 'claude_code';
  description = 'Delegate a coding task to Claude Code. Provide a detailed prompt describing what to do.';
  parameters = {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task or question to send to Claude Code.',
      },
      session_id: {
        type: 'string',
        description: 'Resume a previous Claude Code session by ID.',
      },
      working_directory: {
        type: 'string',
        description: 'Working directory for Claude Code.',
      },
    },
    required: ['prompt'],
  };

  private config: ClaudeCodeConfig;

  constructor(config: ClaudeCodeConfig) {
    this.config = config;
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolResult> {
    const prompt = args.prompt as string;
    if (!prompt) {
      return { success: false, output: '', error: 'prompt is required.' };
    }

    const cliArgs = ['-p', prompt, '--output-format', 'json'];

    if (this.config.allowedTools?.length) {
      for (const tool of this.config.allowedTools) {
        cliArgs.push('--allowedTools', tool);
      }
    }

    if (this.config.disallowedTools?.length) {
      for (const tool of this.config.disallowedTools) {
        cliArgs.push('--disallowedTools', tool);
      }
    }

    if (this.config.maxTurns) {
      cliArgs.push('--max-turns', String(this.config.maxTurns));
    }

    if (this.config.model) {
      cliArgs.push('--model', this.config.model);
    }

    const sessionId = args.session_id as string | undefined;
    if (sessionId) {
      cliArgs.push('--resume', sessionId);
    }

    cliArgs.push('--dangerously-skip-permissions');

    const timeoutMs = this.config.timeoutMs ?? 300_000;
    const cwd = (args.working_directory as string) || process.cwd();

    try {
      const { stdout, stderr, code } = await this.run(cliArgs, cwd, timeoutMs);

      if (code !== 0) {
        const errMsg = stderr || stdout || 'Claude Code exited with an error';
        return { success: false, output: '', error: truncate(errMsg) };
      }

      return this.parseOutput(stdout);
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
  }

  private run(
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(
        'claude',
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          env: process.env,
        },
        (error, stdout, stderr) => {
          resolve({
            stdout,
            stderr,
            code: error ? (error as unknown as { code?: number }).code ?? 1 : 0,
          });
        }
      );
    });
  }

  private parseOutput(stdout: string): ToolResult {
    try {
      const data = JSON.parse(stdout) as {
        result?: string;
        session_id?: string;
        is_error?: boolean;
      };

      if (data.is_error) {
        return {
          success: false,
          output: '',
          error: truncate(data.result ?? 'Claude Code returned an error'),
        };
      }

      let output = data.result ?? stdout;
      if (data.session_id) {
        output += `\n\n[session_id: ${data.session_id}]`;
      }

      return { success: true, output: truncate(output) };
    } catch {
      // If JSON parsing fails, return raw output
      return { success: true, output: truncate(stdout) };
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + '\n\n[Truncated]';
}
