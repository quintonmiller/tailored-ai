import type { CustomToolConfig } from "../config.js";
import { runShellCommand, shellEscape } from "../shell.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

const DEFAULT_TIMEOUT_MS = 30_000;

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
      type: "object",
      properties,
      required: this.paramNames,
    };
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    // Build replacement map first, then substitute in one pass to prevent
    // a param value containing {{other}} from being interpolated again.
    const replacements = new Map<string, string>();
    for (const name of this.paramNames) {
      replacements.set(`{{${name}}}`, shellEscape(String(args[name] ?? "")));
    }

    const pattern = /\{\{\w+\}\}/g;
    const cmd = this.command.replace(pattern, (match) => replacements.get(match) ?? match);

    // Check for unresolved placeholders
    const unresolved = cmd.match(/\{\{(\w+)\}\}/g);
    if (unresolved) {
      return { success: false, output: "", error: `Unresolved placeholders: ${unresolved.join(", ")}` };
    }

    return runShellCommand(cmd, this.timeoutMs);
  }
}

export function createCustomTools(configs: Record<string, CustomToolConfig>): Tool[] {
  const tools: Tool[] = [];
  for (const [name, config] of Object.entries(configs)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      console.warn(
        `[custom_tools] Skipping "${name}": entry is not an object (got ${typeof config}). Fix it via admin.update_config or edit config.yaml.`,
      );
      continue;
    }
    const c = config as Partial<CustomToolConfig>;
    if (typeof c.command !== "string" || !c.command) {
      console.warn(`[custom_tools] Skipping "${name}": missing string "command".`);
      continue;
    }
    if (typeof c.description !== "string") {
      console.warn(`[custom_tools] Skipping "${name}": missing string "description".`);
      continue;
    }
    if (c.parameters === undefined || c.parameters === null) {
      // Tolerate omitted parameters as "no-arg tool"
      (c as CustomToolConfig).parameters = {};
    } else if (typeof c.parameters !== "object" || Array.isArray(c.parameters)) {
      console.warn(`[custom_tools] Skipping "${name}": "parameters" must be an object.`);
      continue;
    }
    try {
      tools.push(new CustomTool(name, c as CustomToolConfig));
    } catch (err) {
      console.warn(`[custom_tools] Skipping "${name}": ${(err as Error).message}`);
    }
  }
  return tools;
}
