import { activateSkill, deactivateSkill } from "../agent/active-skill.js";
import type { ResourceManifest } from "../resources/interface.js";
import type { SkillRegistry } from "../resources/skill.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface LoadSkillToolOptions {
  getSkillRegistry: () => SkillRegistry;
}

/**
 * Activates a skill on-demand inside the agent loop. Returns the full SKILL.md
 * body (instructions) so the agent has the operating procedure in-context.
 *
 * Side effects:
 *   - Sets `context.activeSkill.current` so the loop can enforce the skill's
 *     allowed-tools list on subsequent tool calls.
 *   - Records `rootPath` (when known). Recorded only — no tool reads it. See
 *     `ActiveSkillRecord.rootPath`.
 *
 * Calling with `name: "__deactivate__"` clears the active skill (the agent can
 * use this when it's done with the loaded skill's task).
 */
export class LoadSkillTool implements Tool {
  name = "load_skill";
  description =
    "Activate a skill from the catalog. Returns the skill's full instructions (SKILL.md body) and narrows the tool set if the skill declares allowed-tools.";
  parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill id from the catalog, or `__deactivate__` to clear the active skill.",
      },
    },
    required: ["name"],
  };

  constructor(private readonly opts: LoadSkillToolOptions) {}

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return { success: false, output: "", error: "name is required" };
    }
    if (!ctx.activeSkill) {
      return {
        success: false,
        output: "",
        error: "load_skill called but no activeSkill state was provided by the loop",
      };
    }
    if (name === "__deactivate__") {
      const wasActive = ctx.activeSkill.current?.id;
      deactivateSkill(ctx.activeSkill);
      return {
        success: true,
        output: wasActive ? `deactivated skill: ${wasActive}` : "no skill was active",
      };
    }

    const registry = this.opts.getSkillRegistry();
    const def = registry.get(name);
    if (!def) {
      // Try the matching manifest list — some skills may not have a parsed body.
      const list = registry.listWithManifests().find((r) => r.manifest.id === name);
      if (!list) {
        return {
          success: false,
          output: "",
          error: `unknown skill "${name}". Use the skill catalog (in the system prompt) to find available names.`,
        };
      }
    }

    const entry = registry.listWithManifests().find((r) => r.manifest.id === name);
    const manifest = entry?.manifest;
    const rootPath = inferRootPath(manifest, entry?.origin?.localPath);
    const allowedTools = def?.toolRefs ?? [];

    activateSkill(ctx.activeSkill, {
      id: name,
      allowedTools,
      rootPath,
    });

    const instructions = def?.instructions ?? "";
    // Says only what is true. This used to append ` — scoped to: ${rootPath}`,
    // which told the model it was confined to a directory nothing enforced,
    // and disclosed the install path to do it. `tools narrowed to:` stays —
    // the loop really does gate on that list.
    const header = `[skill activated: ${name}${allowedTools.length > 0 ? ` — tools narrowed to: ${allowedTools.join(", ")}` : ""}]`;
    return {
      success: true,
      output: `${header}\n\n${instructions}`.trim(),
    };
  }
}

function inferRootPath(manifest: ResourceManifest | undefined, localPath: string | undefined): string | undefined {
  if (localPath) return localPath;
  void manifest;
  return undefined;
}
