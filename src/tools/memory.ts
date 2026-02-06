import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './interface.js';

const FILENAME_RE = /^[a-zA-Z0-9_-]+\.md$/;

function sanitizeFilename(name: string): string | null {
  const base = basename(name);
  return FILENAME_RE.test(base) ? base : null;
}

export class MemoryTool implements Tool {
  name = 'memory';
  description = 'Save or retrieve persistent notes. Use this to remember facts across sessions.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'write'],
        description: 'Action to perform.',
      },
      filename: {
        type: 'string',
        description: 'Filename (e.g. "notes.md"). Required for read/write.',
      },
      content: {
        type: 'string',
        description: 'Content to write. Required for write.',
      },
    },
    required: ['action'],
  };

  private contextDir: string;

  constructor(contextDir: string) {
    this.contextDir = contextDir;
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args.action as string;

    if (action === 'list') {
      return this.list();
    }

    const filename = sanitizeFilename((args.filename as string) ?? '');
    if (!filename) {
      return { success: false, output: '', error: 'Invalid filename. Use alphanumeric, dash, underscore, ending in .md.' };
    }

    if (action === 'read') {
      return this.read(filename);
    }

    if (action === 'write') {
      const content = args.content as string;
      if (!content) {
        return { success: false, output: '', error: 'content is required for write.' };
      }
      return this.write(filename, content);
    }

    return { success: false, output: '', error: `Unknown action "${action}".` };
  }

  private async list(): Promise<ToolResult> {
    try {
      const entries = await readdir(this.contextDir);
      const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
      return { success: true, output: mdFiles.length ? mdFiles.join('\n') : '(no context files)' };
    } catch {
      return { success: true, output: '(no context files)' };
    }
  }

  private async read(filename: string): Promise<ToolResult> {
    try {
      const content = await readFile(resolve(this.contextDir, filename), 'utf-8');
      return { success: true, output: content };
    } catch (err) {
      return { success: false, output: '', error: `Failed to read: ${(err as Error).message}` };
    }
  }

  private async write(filename: string, content: string): Promise<ToolResult> {
    try {
      await writeFile(resolve(this.contextDir, filename), content, 'utf-8');
      return { success: true, output: `Saved ${filename}` };
    } catch (err) {
      return { success: false, output: '', error: `Failed to write: ${(err as Error).message}` };
    }
  }
}
