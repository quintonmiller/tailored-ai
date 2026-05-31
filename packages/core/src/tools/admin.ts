import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { CustomToolConfig } from "../config.js";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

const VALID_TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const VALID_PARAM_TYPES = new Set(["string", "number", "integer", "boolean", "array"]);
const TEMPLATE_TOKEN = /\{\{(\w+)\}\}/g;

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current) || typeof current[keys[i]] !== "object" || current[keys[i]] === null) {
      current[keys[i]] = {};
    }
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Paths the agent is allowed to modify. Anything else is blocked.
const ALLOWED_WRITE_PREFIXES = [
  "agents.",
  "custom_tools.",
  "commands.",
  "cron.jobs",
  "cron.enabled",
  "agent.extraInstructions",
  "agent.temperature",
  "agent.maxToolRounds",
  "agent.maxHistoryTokens",
  "context.",
  "permissions.",
];

type CustomToolValidation = { ok: true; tool: CustomToolConfig } | { ok: false; error: string };

export function validateCustomTool(name: unknown, tool: unknown): CustomToolValidation {
  if (typeof name !== "string" || !name) {
    return { ok: false, error: '"name" is required and must be a string.' };
  }
  if (!VALID_TOOL_NAME.test(name)) {
    return {
      ok: false,
      error: `Invalid tool name "${name}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (letters, digits, underscore; cannot start with a digit).`,
    };
  }
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return { ok: false, error: '"tool" object is required.' };
  }
  const t = tool as Record<string, unknown>;
  if (typeof t.description !== "string" || !t.description.trim()) {
    return { ok: false, error: '"tool.description" is required and must be a non-empty string.' };
  }
  if (typeof t.command !== "string" || !t.command.trim()) {
    return { ok: false, error: '"tool.command" is required and must be a non-empty string.' };
  }
  if (t.parameters === undefined || t.parameters === null) {
    return { ok: false, error: '"tool.parameters" is required (use {} for a no-arg tool).' };
  }
  if (typeof t.parameters !== "object" || Array.isArray(t.parameters)) {
    return { ok: false, error: '"tool.parameters" must be an object of { <name>: { type, description } }.' };
  }
  const params = t.parameters as Record<string, unknown>;
  const cleanParams: Record<string, { type: string; description: string }> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (!VALID_TOOL_NAME.test(key)) {
      return { ok: false, error: `Invalid parameter name "${key}". Use only letters, digits, and underscore.` };
    }
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: `Parameter "${key}" must be an object with type + description.` };
    }
    const spec = raw as Record<string, unknown>;
    const type = typeof spec.type === "string" ? spec.type : undefined;
    if (!type || !VALID_PARAM_TYPES.has(type)) {
      return {
        ok: false,
        error: `Parameter "${key}" has invalid type "${type ?? "undefined"}". Use one of: ${[...VALID_PARAM_TYPES].join(", ")}.`,
      };
    }
    const desc = typeof spec.description === "string" ? spec.description : "";
    cleanParams[key] = { type, description: desc };
  }

  const command = t.command as string;
  const tokens = new Set<string>();
  for (const m of command.matchAll(TEMPLATE_TOKEN)) tokens.add(m[1]);
  const missing = [...tokens].filter((tok) => !(tok in cleanParams));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Command references {{${missing.join("}}, {{")}}} but those are not declared in parameters. Every {{token}} in command must match a key in parameters.`,
    };
  }
  const unused = Object.keys(cleanParams).filter((p) => !tokens.has(p));
  if (unused.length > 0) {
    return {
      ok: false,
      error: `Parameters [${unused.join(", ")}] are declared but never used in command. Reference each as {{${unused[0]}}} or remove it.`,
    };
  }

  let timeout_ms: number | undefined;
  if (t.timeout_ms !== undefined) {
    if (typeof t.timeout_ms !== "number" || !Number.isFinite(t.timeout_ms) || t.timeout_ms <= 0) {
      return { ok: false, error: '"tool.timeout_ms" must be a positive number when set.' };
    }
    timeout_ms = t.timeout_ms;
  }

  const cleaned: CustomToolConfig = {
    description: t.description,
    parameters: cleanParams,
    command,
    ...(timeout_ms !== undefined ? { timeout_ms } : {}),
  };
  return { ok: true, tool: cleaned };
}

/**
 * Read the raw YAML config (un-merged, without defaults) from the runtime's
 * config path. Returns an empty object if the file is missing.
 */
export function readRawConfig(configPath: string): Record<string, unknown> {
  try {
    const content = readFileSync(configPath, "utf-8");
    return (YAML.parse(content) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/**
 * Write a path-scoped patch to the raw YAML config and trigger a runtime
 * reload. Serialized via `runtime.withConfigLock`. `value === undefined`
 * deletes the path. Throws if the resulting YAML doesn't round-trip.
 */
export async function writeRawConfigPath(
  runtime: AgentRuntime,
  path: string,
  value: unknown | undefined,
): Promise<void> {
  return runtime.withConfigLock(() => {
    const raw = readRawConfig(runtime.configPath);
    if (value === undefined) {
      // Delete the path.
      const keys = path.split(".");
      let cur: Record<string, unknown> = raw;
      for (let i = 0; i < keys.length - 1; i++) {
        const next = cur[keys[i]];
        if (!next || typeof next !== "object") return;
        cur = next as Record<string, unknown>;
      }
      delete cur[keys[keys.length - 1]];
    } else {
      setNestedValue(raw, path, value);
    }
    const yaml = YAML.stringify(raw);
    YAML.parse(yaml); // validate round-trip
    writeFileSync(runtime.configPath, yaml, "utf-8");
    runtime.reload();
  });
}

function isWriteAllowed(path: string): boolean {
  return ALLOWED_WRITE_PREFIXES.some((prefix) => {
    if (path === prefix) return true;
    // Prefixes ending with "." are namespace prefixes — match anything under them
    if (prefix.endsWith(".")) return path.startsWith(prefix);
    // Otherwise require a separator (. or [) to prevent "cron.enabled" matching "cron.enabledFoo"
    return path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);
  });
}

export class AdminTool implements Tool {
  name = "admin";
  description =
    "Read or update agent configuration. Use create_tool to give yourself a new shell-backed tool, create_agent to define a new named agent, list_agents to list them, get_config to read a section, update_config for arbitrary writes.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get_config", "update_config", "create_agent", "create_tool", "list_agents"],
        description: "The action to perform.",
      },
      section: { type: "string", description: "Config section to return (for get_config)." },
      path: { type: "string", description: "Dotted config path to set (for update_config)." },
      value: { description: "Value to set (for update_config / create_agent)." },
      name: { type: "string", description: "Agent name (for create_agent) or tool name (for create_tool)." },
      agent: { type: "object", description: "Agent definition (for create_agent)." },
      tool: {
        type: "object",
        description:
          'Custom tool definition (for create_tool). Shape: { description: string, parameters: { <param>: { type: "string"|"number"|"boolean"|"array", description: string } }, command: string with {{param}} placeholders, timeout_ms?: number }. Every {{token}} in command must match a key in parameters.',
      },
    },
    required: ["action"],
  };

  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;

    switch (action) {
      case "get_config":
        return this.getConfig(args.section as string | undefined);
      case "update_config":
        return this.updateConfig(args.path as string, args.value);
      case "create_agent":
      case "create_profile": // backward compat alias
        return this.createAgent(args.name as string, (args.agent ?? args.profile) as Record<string, unknown>);
      case "create_tool":
        return this.createTool(args.name as string, args.tool as Record<string, unknown>, context);
      case "list_agents":
      case "list_profiles": // backward compat alias
        return this.listAgents();
      default:
        return {
          success: false,
          output: "",
          error: `Unknown action "${action}". Use get_config, update_config, create_agent, create_tool, or list_agents.`,
        };
    }
  }

  private getConfig(section?: string): ToolResult {
    const config = this.runtime.getConfig();
    const data = section ? getNestedValue(config as unknown as Record<string, unknown>, section) : config;
    if (data === undefined) {
      return { success: false, output: "", error: `Section "${section}" not found in config.` };
    }
    return { success: true, output: YAML.stringify(data) };
  }

  private async updateConfig(path: string, value: unknown): Promise<ToolResult> {
    if (!path) {
      return { success: false, output: "", error: '"path" is required for update_config.' };
    }

    if (!isWriteAllowed(path)) {
      return {
        success: false,
        output: "",
        error: `Cannot modify "${path}": path is not in the allowed set. Writable prefixes: ${ALLOWED_WRITE_PREFIXES.join(", ")}`,
      };
    }

    return this.runtime.withConfigLock(() => {
      let raw: Record<string, unknown>;
      try {
        const content = readFileSync(this.runtime.configPath, "utf-8");
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
        return { success: false, output: "", error: `Generated invalid YAML: ${(err as Error).message}` } as ToolResult;
      }

      writeFileSync(this.runtime.configPath, yaml, "utf-8");
      console.log(`[admin] Updated config path "${path}"`);
      this.runtime.reload();

      return { success: true, output: `Config updated at "${path}" and reloaded.` } as ToolResult;
    });
  }

  private async createAgent(name: string, agent: Record<string, unknown>): Promise<ToolResult> {
    if (!name) {
      return { success: false, output: "", error: '"name" is required for create_agent.' };
    }
    if (!agent || typeof agent !== "object") {
      return { success: false, output: "", error: '"agent" object is required for create_agent.' };
    }

    return this.updateConfig(`agents.${name}`, agent);
  }

  private async createTool(name: string, tool: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const validation = validateCustomTool(name, tool);
    if (!validation.ok) {
      return { success: false, output: "", error: validation.error };
    }
    const config = this.runtime.getConfig();
    const existingTool = this.runtime.getTools().find((t) => t.name === name);
    if (existingTool) {
      return {
        success: false,
        output: "",
        error: `A tool named "${name}" already exists. Pick a different name or use update_config to overwrite custom_tools.${name} deliberately.`,
      };
    }

    const agentName = context.agentName;
    const agentDef = agentName ? config.agents[agentName] : undefined;
    const needsAllowlistPatch = !!(agentDef?.tools && !agentDef.tools.includes(name));

    return this.runtime.withConfigLock(() => {
      let raw: Record<string, unknown>;
      try {
        const content = readFileSync(this.runtime.configPath, "utf-8");
        raw = (YAML.parse(content) as Record<string, unknown>) ?? {};
      } catch {
        raw = {};
      }

      setNestedValue(raw, `custom_tools.${name}`, validation.tool);

      let allowlistPatched = false;
      if (needsAllowlistPatch && agentName) {
        const current = (getNestedValue(raw, `agents.${agentName}.tools`) as string[] | undefined) ?? [
          ...(agentDef?.tools ?? []),
        ];
        if (!current.includes(name)) {
          current.push(name);
          setNestedValue(raw, `agents.${agentName}.tools`, current);
          allowlistPatched = true;
        }
      }

      const yaml = YAML.stringify(raw);
      try {
        YAML.parse(yaml);
      } catch (err) {
        return { success: false, output: "", error: `Generated invalid YAML: ${(err as Error).message}` } as ToolResult;
      }
      writeFileSync(this.runtime.configPath, yaml, "utf-8");
      console.log(
        `[admin] Created custom tool "${name}"${allowlistPatched ? ` (allowlisted on agent "${agentName}")` : ""}`,
      );
      this.runtime.reload();

      const lines: string[] = [];
      lines.push(`Tool "${name}" created and reloaded.`);
      lines.push(`description: ${validation.tool.description}`);
      const paramSummary = Object.entries(validation.tool.parameters)
        .map(([k, p]) => `${k}: ${p.type}`)
        .join(", ");
      lines.push(`parameters: { ${paramSummary} }`);
      lines.push(`command: ${validation.tool.command}`);
      if (validation.tool.timeout_ms !== undefined) lines.push(`timeout_ms: ${validation.tool.timeout_ms}`);
      if (allowlistPatched) {
        lines.push(`Added "${name}" to agent "${agentName}" tools allowlist.`);
      } else if (agentName && agentDef?.tools && agentDef.tools.includes(name)) {
        lines.push(`Already in agent "${agentName}" tools allowlist.`);
      } else if (agentName && agentDef?.tools === undefined) {
        lines.push(`Agent "${agentName}" has no explicit tools allowlist; tool is visible by default.`);
      }
      lines.push(`Call it on the next round as "${name}".`);

      return { success: true, output: lines.join("\n") } as ToolResult;
    });
  }

  private listAgents(): ToolResult {
    const config = this.runtime.getConfig();
    const agents = config.agents;
    const names = Object.keys(agents);

    if (!names.length) {
      return { success: true, output: "No agents configured." };
    }

    const lines = names.map((name) => {
      const a = agents[name];
      const parts: string[] = [name];
      if (a.model) parts.push(`model=${a.model}`);
      if (a.tools) parts.push(`tools=[${a.tools.join(", ")}]`);
      if (a.temperature !== undefined) parts.push(`temp=${a.temperature}`);
      return parts.join(" | ");
    });

    return { success: true, output: lines.join("\n") };
  }
}
