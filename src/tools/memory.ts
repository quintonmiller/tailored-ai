import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './interface.js';
import { ensureContextDir } from '../context.js';

const FILENAME_RE = /^[a-zA-Z0-9_-]+\.md$/;

function sanitizeFilename(name: string): string | null {
  const base = basename(name);
  return FILENAME_RE.test(base) ? base : null;
}

async function listDir(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
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
      scope: {
        type: 'string',
        enum: ['global', 'profile'],
        description: 'Target scope. Default: profile if available, otherwise global.',
      },
    },
    required: ['action'],
  };

  private globalDir: string;

  constructor(globalDir: string) {
    this.globalDir = globalDir;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    const scope = args.scope as 'global' | 'profile' | undefined;
    const profileDir = context.profileContextDir;

    if (action === 'list') {
      return this.list(scope, profileDir);
    }

    const filename = sanitizeFilename((args.filename as string) ?? '');
    if (!filename) {
      return { success: false, output: '', error: 'Invalid filename. Use alphanumeric, dash, underscore, ending in .md.' };
    }

    if (action === 'read') {
      return this.read(filename, scope, profileDir);
    }

    if (action === 'write') {
      const content = args.content as string;
      if (!content) {
        return { success: false, output: '', error: 'content is required for write.' };
      }
      return this.write(filename, content, scope, profileDir);
    }

    return { success: false, output: '', error: `Unknown action "${action}".` };
  }

  private async list(scope: 'global' | 'profile' | undefined, profileDir?: string): Promise<ToolResult> {
    const lines: string[] = [];

    if (!scope || scope === 'global') {
      const globalFiles = await listDir(this.globalDir);
      for (const f of globalFiles) lines.push(`[global] ${f}`);
    }

    if ((!scope || scope === 'profile') && profileDir) {
      const profileFiles = await listDir(profileDir);
      for (const f of profileFiles) lines.push(`[profile] ${f}`);
    }

    return { success: true, output: lines.length ? lines.join('\n') : '(no context files)' };
  }

  private async read(filename: string, scope: 'global' | 'profile' | undefined, profileDir?: string): Promise<ToolResult> {
    // Determine which directory to read from
    const defaultDir = this.resolveDefaultDir(scope, profileDir);
    const fallbackDir = scope ? undefined : (defaultDir === profileDir ? this.globalDir : profileDir);

    try {
      const content = await readFile(resolve(defaultDir, filename), 'utf-8');
      return { success: true, output: content };
    } catch {
      // Try fallback if no explicit scope was given
      if (fallbackDir) {
        try {
          const content = await readFile(resolve(fallbackDir, filename), 'utf-8');
          return { success: true, output: content };
        } catch (err) {
          return { success: false, output: '', error: `Failed to read: ${(err as Error).message}` };
        }
      }
      return { success: false, output: '', error: `File not found: ${filename}` };
    }
  }

  private async write(filename: string, content: string, scope: 'global' | 'profile' | undefined, profileDir?: string): Promise<ToolResult> {
    const targetDir = this.resolveDefaultDir(scope, profileDir);

    try {
      await ensureContextDir(targetDir);
      await writeFile(resolve(targetDir, filename), content, 'utf-8');
      const label = targetDir === this.globalDir ? 'global' : 'profile';
      return { success: true, output: `Saved ${filename} [${label}]` };
    } catch (err) {
      return { success: false, output: '', error: `Failed to write: ${(err as Error).message}` };
    }
  }

  private resolveDefaultDir(scope: 'global' | 'profile' | undefined, profileDir?: string): string {
    if (scope === 'global') return this.globalDir;
    if (scope === 'profile' && profileDir) return profileDir;
    // Default: profile dir if available, otherwise global
    return profileDir ?? this.globalDir;
  }
}
