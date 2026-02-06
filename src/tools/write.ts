import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export class WriteTool implements Tool {
  name = 'write';
  description = 'Write content to a file. Creates the file if it does not exist.';
  parameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to write.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the file.',
      },
    },
    required: ['path', 'content'],
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
    const content = args.content as string;

    if (!rawPath) {
      return { success: false, output: '', error: 'No path provided.' };
    }
    if (content === undefined || content === null) {
      return { success: false, output: '', error: 'No content provided.' };
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
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      return { success: true, output: `Wrote ${content.length} bytes to ${fullPath}` };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: `Failed to write file: ${(err as Error).message}`,
      };
    }
  }
}
