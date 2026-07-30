import { readFileSync } from "node:fs";
import YAML from "yaml";
import type { CustomToolConfig } from "../config.js";
import { ConfigWriteRejected, updateRawConfig } from "../config-write.js";
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

/**
 * Paths the agent is allowed to modify. Anything else is blocked.
 *
 * Three prefixes were removed because each turned a config editor into
 * something else entirely. `admin` is a meta tool appended to every agent
 * (runtime.ts, `extraTools`), so an agent's `tools:` list cannot decline it —
 * whatever is writable here is writable by all of them.
 *
 * - `custom_tools.` was arbitrary host code. `CustomTool` runs its `command`
 *   through `bash -c` with no boundary and no sandbox routing, so an agent
 *   could write itself a shell and call it in the same run — tools re-resolve
 *   every round. For a container-sandboxed agent that is a complete escape.
 * - `permissions.` was the approval gate governing this very call. An agent
 *   that hit a prompt could set `defaultMode: auto` and retry.
 * - `context.` redirects where the prompt-injected context files are read from
 *   and written to, which is a way to rewrite every agent's instructions
 *   without touching a single agent.
 *
 * A human can still set all three by editing config.yaml. That is the
 * distinction being drawn: these are decisions for whoever runs the
 * deployment, not for something running inside it.
 */
const ALLOWED_WRITE_PREFIXES = [
  "agents.",
  "commands.",
  "cron.jobs",
  "cron.enabled",
  "agent.extraInstructions",
  "agent.temperature",
  "agent.maxToolRounds",
  "agent.maxHistoryTokens",
  "dashboard.",
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
 * reload. `value === undefined` deletes the path. Throws
 * {@link ConfigWriteRejected} — leaving the file untouched — if the result
 * would carry config that parses but is never read.
 */
export async function writeRawConfigPath(
  runtime: AgentRuntime,
  path: string,
  value: unknown | undefined,
): Promise<void> {
  await updateRawConfig(runtime, (raw) => {
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
        // `value` is accepted because the parameter schema advertises it for
        // create_agent, and a model that reads the schema and sends it should
        // not get "agent object is required" back.
        return this.createAgent(
          args.name as string,
          (args.agent ?? args.profile ?? args.value) as Record<string, unknown>,
        );
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

    // Checked before the write rather than inside it: this one needs the live
    // tool registry, which the shared writer deliberately knows nothing about.
    // Refused rather than warned. A `tools:` entry that names nothing is dead
    // weight at best; historically it threw and took the agent offline, and
    // even now it silently costs the agent a capability it was configured to
    // have. The write is the moment someone is looking, so it is the moment to
    // say so.
    const candidate = readRawConfig(this.runtime.configPath);
    setNestedValue(candidate, path, value);
    const badTools = this.unknownToolRefs(candidate);
    if (badTools.length > 0) {
      return {
        success: false,
        output: "",
        error:
          `Not written — unknown tool(s) ${badTools.map((t) => `"${t}"`).join(", ")}. ` +
          `Available: ${this.runtime
            .getResolvableTools()
            .map((t) => t.name)
            .join(", ")}`,
      };
    }

    try {
      const { warnings } = await updateRawConfig(this.runtime, (raw) => {
        setNestedValue(raw, path, value);
      });
      console.log(`[admin] Updated config path "${path}"`);
      const note = warnings.length > 0 ? `\nStill worth a look: ${warnings.join("; ")}` : "";
      return { success: true, output: `Config updated at "${path}" and reloaded.${note}` };
    } catch (err) {
      if (err instanceof ConfigWriteRejected) {
        return { success: false, output: "", error: err.message };
      }
      return { success: false, output: "", error: `Config not written: ${(err as Error).message}` };
    }
  }

  /**
   * Tool names in the pending config that no tool answers to.
   *
   * Checked against what the runtime can actually hand an agent — registry
   * plus meta tools — because that is the set `resolveAgent` uses. Validating
   * against `config.tools` alone reported `admin` and `delegate` as unknown,
   * which is how a correct config learned to look broken.
   *
   * `mcp_*` names are exempt: those appear only after a server connects, so an
   * agent configured ahead of discovery is right and we are early.
   */
  private unknownToolRefs(raw: Record<string, unknown>): string[] {
    const known = new Set(this.runtime.getResolvableTools().map((t) => t.name));
    const agents = raw.agents;
    if (!agents || typeof agents !== "object") return [];

    const bad = new Set<string>();
    for (const definition of Object.values(agents as Record<string, unknown>)) {
      const tools = (definition as { tools?: unknown } | null)?.tools;
      if (!Array.isArray(tools)) continue;
      for (const name of tools) {
        if (typeof name !== "string" || name.startsWith("mcp_")) continue;
        if (!known.has(name)) bad.add(name);
      }
    }
    return [...bad];
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

    // Deliberately NOT added to the calling agent's `tools:` list.
    //
    // Creating a tool and being allowed to run it are different decisions.
    // Self-granting collapsed them: an agent with no `exec` could write a
    // shell-backed tool and hand it to itself in one call, which is shell it
    // was never granted. The tool now honours the caller's boundary and
    // sandbox, so this is no longer an escape — but for an agent with no
    // declared boundary it is still an unbounded host shell, and whether an
    // agent gets one is not the agent's call.
    //
    // Said out loud in the result rather than done quietly, so the agent
    // knows why its new tool is not callable yet.
    const allowlistPatched = false;

    try {
      await updateRawConfig(this.runtime, (raw) => {
        setNestedValue(raw, `custom_tools.${name}`, validation.tool);
      });
    } catch (err) {
      if (err instanceof ConfigWriteRejected) {
        return { success: false, output: "", error: err.message };
      }
      return { success: false, output: "", error: `Tool not created: ${(err as Error).message}` };
    }
    console.log(
      `[admin] Created custom tool "${name}"${allowlistPatched ? ` (allowlisted on agent "${agentName}")` : ""}`,
    );

    {
      const lines: string[] = [];
      lines.push(`Tool "${name}" created and reloaded.`);
      lines.push(`description: ${validation.tool.description}`);
      const paramSummary = Object.entries(validation.tool.parameters)
        .map(([k, p]) => `${k}: ${p.type}`)
        .join(", ");
      lines.push(`parameters: { ${paramSummary} }`);
      lines.push(`command: ${validation.tool.command}`);
      if (validation.tool.timeout_ms !== undefined) lines.push(`timeout_ms: ${validation.tool.timeout_ms}`);
      if (needsAllowlistPatch && agentName) {
        lines.push(
          `NOT added to agent "${agentName}" tools allowlist — creating a tool and being allowed ` +
            `to run it are separate decisions. Ask Quinton to add "${name}" to that agent's tools list.`,
        );
      } else if (allowlistPatched) {
        lines.push(`Added "${name}" to agent "${agentName}" tools allowlist.`);
      } else if (agentName && agentDef?.tools && agentDef.tools.includes(name)) {
        lines.push(`Already in agent "${agentName}" tools allowlist.`);
      } else if (agentName && agentDef?.tools === undefined) {
        lines.push(`Agent "${agentName}" has no explicit tools allowlist; tool is visible by default.`);
      }
      lines.push(`Call it on the next round as "${name}".`);

      return { success: true, output: lines.join("\n") };
    }
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
