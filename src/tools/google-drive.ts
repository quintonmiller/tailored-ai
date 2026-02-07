import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import type { Tool, ToolContext, ToolResult } from './interface.js';

export interface GoogleDriveToolConfig {
  enabled: boolean;
  account: string;
  folder_name?: string;
  folder_id?: string;
}

export class GoogleDriveTool implements Tool {
  name = 'google_drive';
  description = 'Upload files to Google Drive and manage files. Actions: upload, list, search.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'The action: upload, list, search.',
      },
      file_path: {
        type: 'string',
        description: 'Local file path for upload action.',
      },
      name: {
        type: 'string',
        description: 'Override filename for upload.',
      },
      query: {
        type: 'string',
        description: 'Search query for search action.',
      },
    },
    required: ['action'],
  };

  private account: string;
  private gogKeyringPassword: string;
  private folderName: string;
  private folderId: string | undefined;
  private configPath: string | undefined;

  constructor(account: string, gogKeyringPassword: string, folderName?: string, folderId?: string, configPath?: string) {
    this.account = account;
    this.gogKeyringPassword = gogKeyringPassword;
    this.folderName = folderName ?? 'Agent Uploads';
    this.folderId = folderId;
    this.configPath = configPath;
  }

  private gog(args: string[], timeoutMs: number = 30_000): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      execFile(
        'gog',
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GOG_KEYRING_PASSWORD: this.gogKeyringPassword },
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

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) {
      return { success: false, output: '', error: 'No action provided.' };
    }

    try {
      switch (action) {
        case 'upload':
          return this.upload(args.file_path as string, args.name as string | undefined, context);
        case 'list':
          return this.list();
        case 'search':
          return this.search(args.query as string);
        default:
          return { success: false, output: '', error: `Unknown action: ${action}. Use: upload, list, search.` };
      }
    } catch (err) {
      return { success: false, output: '', error: (err as Error).message };
    }
  }

  private async ensureFolder(): Promise<string | null> {
    // If we have a cached folder ID, verify it still exists
    if (this.folderId) {
      const { code } = await this.gog([
        'drive', 'info', this.folderId,
        '--account', this.account,
        '--json', '--no-input',
      ]);
      if (code === 0) return this.folderId;
      // Folder no longer exists, clear it
      this.folderId = undefined;
    }

    // Search for existing folder by name
    const { stdout, code } = await this.gog([
      'drive', 'search', this.folderName,
      '--account', this.account,
      '--json', '--no-input',
    ]);

    if (code === 0 && stdout.trim()) {
      try {
        const results = JSON.parse(stdout);
        const files = Array.isArray(results) ? results : results.files ?? [];
        const folder = files.find((f: { mimeType?: string; name?: string }) =>
          f.mimeType === 'application/vnd.google-apps.folder' && f.name === this.folderName
        );
        if (folder?.id) {
          this.folderId = folder.id;
          this.persistFolderId(folder.id);
          return folder.id;
        }
      } catch {
        // JSON parse failed, try creating
      }
    }

    // Create the folder
    const mkdirResult = await this.gog([
      'drive', 'mkdir', this.folderName,
      '--account', this.account,
      '--json', '--no-input',
    ]);

    if (mkdirResult.code !== 0) {
      return null;
    }

    try {
      const created = JSON.parse(mkdirResult.stdout);
      const id = created.id ?? created.fileId;
      if (id) {
        this.folderId = id;
        this.persistFolderId(id);
        return id;
      }
    } catch {
      // Try to extract ID from non-JSON output
      const match = mkdirResult.stdout.match(/([a-zA-Z0-9_-]{20,})/);
      if (match) {
        this.folderId = match[1];
        this.persistFolderId(match[1]);
        return match[1];
      }
    }

    return null;
  }

  private persistFolderId(folderId: string): void {
    if (!this.configPath) return;
    try {
      const raw = readFileSync(this.configPath, 'utf-8');
      const doc = YAML.parseDocument(raw);
      doc.setIn(['tools', 'google_drive', 'folder_id'], folderId);
      writeFileSync(this.configPath, doc.toString());
    } catch {
      // Non-fatal: folder ID will be re-discovered on next run
    }
  }

  private async upload(filePath: string, name: string | undefined, context: ToolContext): Promise<ToolResult> {
    if (!filePath) return { success: false, output: '', error: 'file_path is required for upload.' };

    const resolvedPath = resolve(context.workingDirectory, filePath);
    if (!existsSync(resolvedPath)) {
      return { success: false, output: '', error: `File not found: ${resolvedPath}` };
    }

    const folderId = await this.ensureFolder();
    if (!folderId) {
      return { success: false, output: '', error: 'Failed to create or find upload folder.' };
    }

    const uploadArgs = [
      'drive', 'upload', resolvedPath,
      '--parent', folderId,
      '--account', this.account,
      '--json', '--no-input',
    ];
    if (name) {
      uploadArgs.push('--name', name);
    }

    const { stdout, stderr, code } = await this.gog(uploadArgs, 120_000);

    if (code !== 0) {
      return { success: false, output: '', error: stderr || 'gog drive upload failed' };
    }

    // Extract file ID from response
    let fileId: string | undefined;
    try {
      const data = JSON.parse(stdout);
      fileId = data.id ?? data.fileId;
    } catch {
      const match = stdout.match(/([a-zA-Z0-9_-]{20,})/);
      if (match) fileId = match[1];
    }

    if (!fileId) {
      return { success: true, output: `File uploaded but could not extract file ID.\n${stdout.slice(0, 500)}` };
    }

    // Get the shareable URL
    const urlResult = await this.gog([
      'drive', 'url', fileId,
      '--account', this.account,
      '--no-input',
    ]);

    const url = urlResult.code === 0 && urlResult.stdout.trim()
      ? urlResult.stdout.trim()
      : `https://drive.google.com/file/d/${fileId}/view`;

    return { success: true, output: `File uploaded.\nFile ID: ${fileId}\nURL: ${url}` };
  }

  private async list(): Promise<ToolResult> {
    const folderId = await this.ensureFolder();
    if (!folderId) {
      return { success: false, output: '', error: 'Failed to find upload folder.' };
    }

    const { stdout, stderr, code } = await this.gog([
      'drive', 'ls', folderId,
      '--account', this.account,
      '--json', '--no-input',
    ]);

    if (code !== 0) return { success: false, output: '', error: stderr || 'gog drive ls failed' };

    const output = stdout.length > 6000 ? stdout.slice(0, 6000) + '\n\n[Truncated]' : stdout;
    return { success: true, output: output || 'Folder is empty.' };
  }

  private async search(query: string): Promise<ToolResult> {
    if (!query) return { success: false, output: '', error: 'query is required for search.' };

    const { stdout, stderr, code } = await this.gog([
      'drive', 'search', query,
      '--account', this.account,
      '--json', '--no-input',
    ]);

    if (code !== 0) return { success: false, output: '', error: stderr || 'gog drive search failed' };

    const output = stdout.length > 6000 ? stdout.slice(0, 6000) + '\n\n[Truncated]' : stdout;
    return { success: true, output: output || `No results for "${query}".` };
  }
}
