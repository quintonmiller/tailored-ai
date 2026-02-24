import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import type { AgentRuntime } from "../runtime.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

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
  description = "Read or update agent configuration, and manage agents.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["get_config", "update_config", "create_agent", "list_agents"],
        description: "The action to perform.",
      },
      section: { type: "string", description: "Config section to return (for get_config)." },
      path: { type: "string", description: "Dotted config path to set (for update_config)." },
      value: { description: "Value to set (for update_config / create_agent)." },
      name: { type: "string", description: "Agent name (for create_agent)." },
      agent: { type: "object", description: "Agent definition (for create_agent)." },
    },
    required: ["action"],
  };

  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;

    switch (action) {
      case "get_config":
        return this.getConfig(args.section as string | undefined);
      case "update_config":
        return this.updateConfig(args.path as string, args.value);
      case "create_agent":
      case "create_profile": // backward compat alias
        return this.createAgent(args.name as string, (args.agent ?? args.profile) as Record<string, unknown>);
      case "list_agents":
      case "list_profiles": // backward compat alias
        return this.listAgents();
      default:
        return {
          success: false,
          output: "",
          error: `Unknown action "${action}". Use get_config, update_config, create_agent, or list_agents.`,
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
