import { readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';
import type { AgentRuntime } from '../runtime.js';
import type { Tool, ToolContext, ToolResult } from './interface.js';

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== 'object' || current[keys[i]] === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class AdminTool implements Tool {
  name = 'admin';
  description = 'Read or update agent configuration, and manage profiles.';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get_config', 'update_config', 'create_profile', 'list_profiles'],
        description: 'The action to perform.',
      },
      section: { type: 'string', description: 'Config section to return (for get_config).' },
      path: { type: 'string', description: 'Dotted config path to set (for update_config).' },
      value: { description: 'Value to set (for update_config / create_profile).' },
      name: { type: 'string', description: 'Profile name (for create_profile).' },
      profile: { type: 'object', description: 'Profile definition (for create_profile).' },
    },
    required: ['action'],
  };

  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;

    switch (action) {
      case 'get_config':
        return this.getConfig(args.section as string | undefined);
      case 'update_config':
        return this.updateConfig(args.path as string, args.value);
      case 'create_profile':
        return this.createProfile(args.name as string, args.profile as Record<string, unknown>);
      case 'list_profiles':
        return this.listProfiles();
      default:
        return { success: false, output: '', error: `Unknown action "${action}". Use get_config, update_config, create_profile, or list_profiles.` };
    }
  }

  private getConfig(section?: string): ToolResult {
    const config = this.runtime.getConfig();
    const data = section ? getNestedValue(config as unknown as Record<string, unknown>, section) : config;
    if (data === undefined) {
      return { success: false, output: '', error: `Section "${section}" not found in config.` };
    }
    return { success: true, output: YAML.stringify(data) };
  }

  private updateConfig(path: string, value: unknown): ToolResult {
    if (!path) {
      return { success: false, output: '', error: '"path" is required for update_config.' };
    }

    let raw: Record<string, unknown>;
    try {
      const content = readFileSync(this.runtime.configPath, 'utf-8');
      raw = (YAML.parse(content) as Record<string, unknown>) ?? {};
    } catch {
      raw = {};
    }

    setNestedValue(raw, path, value);

    // Validate round-trip
    const yaml = YAML.stringify(raw);
    try {
      YAML.parse(yaml);
    } catch (err) {
      return { success: false, output: '', error: `Generated invalid YAML: ${(err as Error).message}` };
    }

    writeFileSync(this.runtime.configPath, yaml, 'utf-8');
    console.log(`[admin] Updated config path "${path}"`);
    this.runtime.reload();

    return { success: true, output: `Config updated at "${path}" and reloaded.` };
  }

  private createProfile(name: string, profile: Record<string, unknown>): ToolResult {
    if (!name) {
      return { success: false, output: '', error: '"name" is required for create_profile.' };
    }
    if (!profile || typeof profile !== 'object') {
      return { success: false, output: '', error: '"profile" object is required for create_profile.' };
    }

    return this.updateConfig(`profiles.${name}`, profile);
  }

  private listProfiles(): ToolResult {
    const config = this.runtime.getConfig();
    const profiles = config.profiles;
    const names = Object.keys(profiles);

    if (!names.length) {
      return { success: true, output: 'No profiles configured.' };
    }

    const lines = names.map((name) => {
      const p = profiles[name];
      const parts: string[] = [name];
      if (p.model) parts.push(`model=${p.model}`);
      if (p.tools) parts.push(`tools=[${p.tools.join(', ')}]`);
      if (p.temperature !== undefined) parts.push(`temp=${p.temperature}`);
      return parts.join(' | ');
    });

    return { success: true, output: lines.join('\n') };
  }
}
