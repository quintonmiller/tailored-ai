import type { AgentHook } from "../config.js";
import type { Tool, ToolContext } from "../tools/interface.js";

export interface ResolvedHooks {
  beforeRun: AgentHook[];
  afterRun: AgentHook[];
}

export const EMPTY_HOOKS: ResolvedHooks = { beforeRun: [], afterRun: [] };

/** Normalize undefined / single / array hook config to a flat array. */
export function normalizeHooks(hooks: AgentHook | AgentHook[] | undefined): AgentHook[] {
  if (!hooks) return [];
  return Array.isArray(hooks) ? hooks : [hooks];
}

/** Returns true if the hooks config has any beforeRun or afterRun entries. */
export function hasHooks(hooks: ResolvedHooks): boolean {
  return hooks.beforeRun.length > 0 || hooks.afterRun.length > 0;
}

/** Merge profile hooks with override hooks (e.g. cron job hooks). Profile hooks run first. */
export function mergeHooks(
  profileHooks?: { beforeRun?: AgentHook | AgentHook[]; afterRun?: AgentHook | AgentHook[] },
  overrideHooks?: { beforeRun?: AgentHook | AgentHook[]; afterRun?: AgentHook | AgentHook[] },
): ResolvedHooks {
  return {
    beforeRun: [...normalizeHooks(profileHooks?.beforeRun), ...normalizeHooks(overrideHooks?.beforeRun)],
    afterRun: [...normalizeHooks(profileHooks?.afterRun), ...normalizeHooks(overrideHooks?.afterRun)],
  };
}

/** Replace all {{key}} placeholders in text with values from vars. */
export function applyTemplates(text: string, vars: Record<string, string>): string {
  if (!text.includes("{{")) return text;
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/** Execute a list of hooks sequentially. Returns outputs and whether a skipIf matched. */
export async function executeHooks(
  hooks: AgentHook[],
  allTools: Tool[],
  templateVars: Record<string, string>,
  sessionId: string,
  logPrefix = "[hooks]",
): Promise<{ outputs: string[]; skipped: boolean }> {
  const outputs: string[] = [];

  const context: ToolContext = {
    sessionId,
    workingDirectory: process.cwd(),
    env: {},
  };

  for (const hook of hooks) {
    const tool = allTools.find((t: Tool) => t.name === hook.tool);
    if (!tool) {
      console.error(`${logPrefix} Hook tool "${hook.tool}" not found, skipping hook`);
      continue;
    }

    // Resolve templates in string-valued args
    const resolvedArgs: Record<string, unknown> = {};
    if (hook.args) {
      for (const [key, value] of Object.entries(hook.args)) {
        resolvedArgs[key] = typeof value === "string" ? applyTemplates(value, templateVars) : value;
      }
    }

    console.log(`${logPrefix} hook: ${hook.tool}(${JSON.stringify(resolvedArgs)})`);

    try {
      const result = await tool.execute(resolvedArgs, context);
      const output = result.output || "";
      outputs.push(output);

      if (hook.skipIf) {
        const regex = new RegExp(hook.skipIf);
        if (regex.test(output)) {
          console.log(`${logPrefix} hook skipIf matched ("${hook.skipIf}"), skipping`);
          return { outputs, skipped: true };
        }
      }
    } catch (err) {
      console.error(`${logPrefix} hook "${hook.tool}" failed:`, (err as Error).message);
    }
  }

  return { outputs, skipped: false };
}
