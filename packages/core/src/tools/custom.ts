import { homedir } from "node:os";
import { join } from "node:path";
import type { CustomToolConfig } from "../config.js";
import { runShellCommand, shellEscape } from "../shell.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";
import { checkExecBoundary } from "./sandbox-boundary.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class CustomTool implements Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;

  private command: string;
  private timeoutMs: number;
  private paramNames: string[];
  private defaults: Record<string, string | number | boolean | undefined>;

  constructor(name: string, config: CustomToolConfig) {
    this.name = name;
    this.description = config.description;
    this.command = config.command;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    this.paramNames = Object.keys(config.parameters);
    this.defaults = {};
    const properties: Record<string, { type: string; description: string }> = {};
    // A parameter with a default is optional by definition — declaring it
    // required while the description says "Default 3" forces the model to
    // invent a value for something it was told it could leave out.
    const required: string[] = [];
    for (const [key, param] of Object.entries(config.parameters)) {
      properties[key] = { type: param.type, description: param.description };
      if (param.default !== undefined) this.defaults[key] = param.default;
      const isRequired = param.required ?? param.default === undefined;
      if (isRequired) required.push(key);
    }

    this.parameters = {
      type: "object",
      properties,
      required,
    };
  }

  /**
   * Run the command, under the same rules as `exec`.
   *
   * This used to take its context and discard it — the parameter was named
   * `_context` — and end at `runShellCommand`, which is `bash -c` on the host.
   * So a custom tool was an unsandboxed host shell no matter what the calling
   * agent's `sandbox` or `fileBoundary` said, and for a container-sandboxed
   * agent that was a complete escape. The agent did not have to be adversarial
   * to find it: one asked, in a room, whether it should "update the tool to use
   * the host's playwright path instead" because its container lacked browser
   * binaries. That would have worked, and nothing would have reported it.
   *
   * A boundary a well-meaning agent can walk through while trying to help is
   * not a boundary. Same two guards `exec` applies, in the same order.
   *
   * The load-bearing one is the second: for an agent with `sandbox: docker` the
   * command now runs INSIDE the container instead of on the host, which is the
   * escape. `checkExecBoundary` is narrower than its name suggests — it catches
   * a parent-repo escape from a worktree-shaped boundary and nothing else — so
   * it closes a real hole for worktree agents but is not general confinement.
   */
  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Build replacement map first, then substitute in one pass to prevent
    // a param value containing {{other}} from being interpolated again.
    const replacements = new Map<string, string>();
    for (const name of this.paramNames) {
      const supplied = args[name];
      const value = supplied === undefined || supplied === "" ? this.defaults[name] : supplied;
      replacements.set(`{{${name}}}`, shellEscape(expandHome(String(value ?? ""))));
    }

    // Consume any quotes already wrapping the placeholder.
    //
    // Anyone writing a shell template quotes their variables — `ls "{{path}}"`
    // is the correct-looking thing to write, and it is what a model writes.
    // But the value is escaped on the way in, so the two layers combined to
    // `ls "'/home/quint/…'"` and the quotes became part of the filename. The
    // command then failed with "No such file or directory" for a directory
    // that plainly existed, and the agent reasonably concluded the path was
    // wrong. Escaping still happens; it just is not doubled.
    const pattern = /(["']?)(\{\{\w+\}\})\1/g;
    const cmd = this.command.replace(pattern, (_match, _quote, placeholder: string) => {
      return replacements.get(placeholder) ?? placeholder;
    });

    // Check for unresolved placeholders
    const unresolved = cmd.match(/\{\{(\w+)\}\}/g);
    if (unresolved) {
      return { success: false, output: "", error: `Unresolved placeholders: ${unresolved.join(", ")}` };
    }

    // Checked AFTER substitution, so a boundary cannot be escaped by smuggling
    // the path in through a parameter.
    const boundaryCheck = checkExecBoundary(cmd, context);
    if (!boundaryCheck.ok) {
      console.warn(`[custom_tools] ${this.name} rejected: ${boundaryCheck.error}`);
      return { success: false, output: "", error: boundaryCheck.error };
    }

    if (context.sandbox && context.sandboxHandle) {
      const result = await context.sandbox.exec(context.sandboxHandle, cmd, {
        cwd: context.workingDirectory,
        env: context.env,
        timeoutMs: this.timeoutMs,
      });
      const output = result.stdout + (result.stderr ? `\n[stderr]: ${result.stderr}` : "");
      if (result.exitCode !== 0) {
        return { success: false, output, error: result.stderr || `exit code ${result.exitCode}` };
      }
      return { success: true, output };
    }

    return runShellCommand(cmd, this.timeoutMs);
  }
}

/**
 * Expand a leading `~` to the home directory.
 *
 * Escaping a value quotes it, and bash does not expand `~` inside quotes — so
 * a perfectly ordinary `~/research/notes` arrives as a literal filename
 * starting with a tilde and fails. People and models both write `~`; the shell
 * itself would have expanded it, and quoting is our doing, not theirs.
 *
 * Only a leading `~/` (or a bare `~`) is touched, which is the shell's own
 * rule — a tilde anywhere else in a string is just a character.
 */
function expandHome(value: string): string {
  if (value !== "~" && !value.startsWith("~/")) return value;
  return join(homedir(), value.slice(1));
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
