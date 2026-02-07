import { execFile } from 'node:child_process';
import type { CustomToolConfig } from '../config.js';
import type { Tool, ToolContext, ToolResult } from './interface.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB

function shellEscape(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export class CustomTool implements Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  private command: string;
  private timeoutMs: number;
  private paramNames: string[];

  constructor(name: string, config: CustomToolConfig) {
    this.name = name;
    this.description = config.description;
    this.command = config.command;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    this.paramNames = Object.keys(config.parameters);
    const properties: Record<string, { type: string; description: string }> = {};
    for (const [key, param] of Object.entries(config.parameters)) {
      properties[key] = { type: param.type, description: param.description };
    }

    this.parameters = {
      type: 'object',
      properties,
      required: this.paramNames,
    };
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    // Build replacement map first, then substitute in one pass to prevent
    // a param value containing {{other}} from being interpolated again.
    const replacements = new Map<string, string>();
    for (const name of this.paramNames) {
      replacements.set(`{{${name}}}`, shellEscape(String(args[name] ?? '')));
    }

    const pattern = /\{\{\w+\}\}/g;
    let cmd = this.command.replace(pattern, (match) => replacements.get(match) ?? match);

    // Check for unresolved placeholders
    const unresolved = cmd.match(/\{\{(\w+)\}\}/g);
    if (unresolved) {
      return { success: false, output: '', error: `Unresolved placeholders: ${unresolved.join(', ')}` };
    }

    return new Promise((resolve) => {
      execFile('bash', ['-c', cmd], { timeout: this.timeoutMs, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
        if (err) {
          resolve({ success: false, output: stdout, error: stderr || (err as Error).message });
        } else {
          resolve({ success: true, output: stdout + (stderr ? `\n[stderr] ${stderr}` : '') });
        }
      });
    });
  }
}

export function createCustomTools(configs: Record<string, CustomToolConfig>): Tool[] {
  return Object.entries(configs).map(([name, config]) => new CustomTool(name, config));
}
