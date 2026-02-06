import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export class ReadTool implements Tool {
  name = 'read';
  description = 'Read the contents of a file.';
  parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to read.',
      },
    },
    required: ['path'],
  };

  private allowedPaths: string[];

  constructor(allowedPaths?: string[]) {
    this.allowedPaths = allowedPaths ?? [];
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const rawPath = args.path as string;
    if (!rawPath) {
      return { success: false, output: '', error: 'No path provided.' };
    }

    const fullPath = isAbsolute(rawPath)
      ? rawPath
      : resolve(context.workingDirectory, rawPath);

    if (this.allowedPaths.length > 0) {
      const allowed = this.allowedPaths.some((p) => fullPath.startsWith(p));
      if (!allowed) {
        return {
          success: false,
          output: '',
          error: `Path "${fullPath}" is not within allowed paths.`,
        };
      }
    }

    try {
      const content = await readFile(fullPath, 'utf-8');
      return { success: true, output: content };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to read file: ${(err as Error).message}`,
      };
    }
  }
}
