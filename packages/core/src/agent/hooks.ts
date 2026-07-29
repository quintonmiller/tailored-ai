import type { AgentConfig, AgentHook } from "../config.js";
import { applyVars, expandPrompt } from "../prompts/expand.js";
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

/**
 * Sync alias for the legacy {{key}}-only substitution. Kept for back-compat;
 * for full prompt expansion (includes + shell), use `expandPrompt` from `../prompts/expand.js`.
 */
export const applyTemplates = applyVars;

/**
 * Execute a list of hooks sequentially.
 *
 * Returns the hook outputs, whether a `skipIf` matched, and whether a hook
 * FAILED. Callers that use hooks to supply data must honor `failed` — a
 * beforeRun hook exists to put something in the prompt, so when it errors the
 * prompt's premise is false and running anyway invites the model to invent the
 * missing data. That is not hypothetical: a dead Gmail token made this hook
 * error every 30 minutes while the prompt still said "Below are my recent
 * emails", and the model duly hallucinated an inbox for weeks.
 *
 * A tool that reports `success: false` counts as failed even when it doesn't
 * throw — otherwise its empty output silently flows on as if it were real.
 */
export async function executeHooks(
  hooks: AgentHook[],
  allTools: Tool[],
  templateVars: Record<string, string>,
  sessionId: string,
  logPrefix = "[hooks]",
  promptsConfig?: AgentConfig["prompts"],
): Promise<{ outputs: string[]; skipped: boolean; failed: boolean; failure?: string }> {
  const outputs: string[] = [];

  const context: ToolContext = {
    sessionId,
    workingDirectory: process.cwd(),
    env: {},
  };

  for (const hook of hooks) {
    const tool = allTools.find((t: Tool) => t.name === hook.tool);
    if (!tool) {
      // A missing tool is a configuration problem (plugin disabled, tool
      // renamed), not the data problem this fail-closed path guards against —
      // and it produced no output before either. Skipping keeps a disabled
      // plugin from taking every unrelated hook down with it.
      console.error(`${logPrefix} Hook tool "${hook.tool}" not found, skipping hook`);
      outputs.push("");
      continue;
    }

    // Resolve templates in string-valued args. Uses full expandPrompt so hook args
    // can pull in {{include:...}} files or !`cmd` shell output (when allowed).
    const resolvedArgs: Record<string, unknown> = {};
    if (hook.args) {
      for (const [key, value] of Object.entries(hook.args)) {
        resolvedArgs[key] = typeof value === "string" ? await expandPrompt(value, templateVars, promptsConfig) : value;
      }
    }

    console.log(`${logPrefix} hook: ${hook.tool}(${JSON.stringify(resolvedArgs)})`);

    try {
      const result = await tool.execute(resolvedArgs, context);
      // A tool can report failure without throwing. Treat that as a failure too:
      // its output is empty, so `skipIf` won't match and the empty string would
      // otherwise be handed to the model as though it were real data.
      if (result.success === false) {
        const failure = `hook "${hook.tool}" returned an error: ${result.error ?? "(no detail)"}`;
        console.error(`${logPrefix} ${failure}`);
        if (hook.onError !== "continue") return { outputs, skipped: false, failed: true, failure };
        outputs.push("");
        continue;
      }

      const output = result.output || "";
      outputs.push(output);

      if (hook.skipIf) {
        const regex = new RegExp(hook.skipIf);
        if (regex.test(output)) {
          console.log(`${logPrefix} hook skipIf matched ("${hook.skipIf}"), skipping`);
          return { outputs, skipped: true, failed: false };
        }
      }
    } catch (err) {
      const failure = `hook "${hook.tool}" failed: ${(err as Error).message}`;
      console.error(`${logPrefix} ${failure}`);
      if (hook.onError !== "continue") return { outputs, skipped: false, failed: true, failure };
    }
  }

  return { outputs, skipped: false, failed: false };
}
