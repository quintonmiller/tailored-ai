import { execFile } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export class ExecTool implements Tool {
  name = 'exec';
  description = 'Run a shell command and return its output.';
  parameters = {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
    },
    required: ['command'],
  };

  private allowedCommands: string[];
  private timeoutMs: number;

  constructor(allowedCommands?: string[], timeoutMs: number = 30_000) {
    this.allowedCommands = allowedCommands ?? [];
    this.timeoutMs = timeoutMs;
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const command = args.command as string;
    if (!command) {
      return { success: false, output: '', error: 'No command provided.' };
    }

    if (this.allowedCommands.length > 0) {
      // Reject shell metacharacters to prevent chaining/piping past the allowlist
      if (/[;|&`$(){}<>!#\n]/.test(command)) {
        return {
          success: false,
          output: '',
          error: `Command rejected: shell operators are not allowed when an allowlist is active.`,
        };
      }
      const bin = command.split(/\s+/)[0];
      if (!this.allowedCommands.includes(bin)) {
        return {
          success: false,
          output: '',
          error: `Command "${bin}" is not in the allowlist: ${this.allowedCommands.join(', ')}`,
        };
      }
    }

    return new Promise((resolve) => {
      execFile(
        'bash',
        ['-c', command],
        {
          cwd: context.workingDirectory,
          env: { ...process.env, ...context.env },
          timeout: this.timeoutMs,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              success: false,
              output: stdout,
              error: stderr || error.message,
            });
          } else {
            resolve({
              success: true,
              output: stdout + (stderr ? `\n[stderr]: ${stderr}` : ''),
            });
          }
        }
      );
    });
  }
}
