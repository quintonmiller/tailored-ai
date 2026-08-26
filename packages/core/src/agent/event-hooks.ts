/**
 * Hooks bound to runtime events.
 *
 * `beforeRun` and `afterRun` are two fixed points. This is the rest of the bus,
 * reachable from config: name any event, filter it, run a registered tool, and
 * — on an event that can be refused — let the tool's answer refuse it.
 *
 * The event catalog is deliberately TAI's own rather than a second one invented
 * for hooks. That is what makes a typo a `validateConfig` warning instead of a
 * hook that silently never fires, which is the failure this repo keeps
 * producing (see #561, where a whole trigger kind was advertised and never
 * dispatched).
 *
 * What a hook *is* stays what it was: a call to a registered tool, with the
 * runtime's context. A hook that spawns a process is a different handler type
 * and a separate decision — it hands config the ability to run arbitrary code,
 * which this deliberately does not.
 */

import type { AgentConfig, EventHook } from "../config.js";
import { toolOutputText } from "../content/types.js";
import { expandPrompt } from "../prompts/expand.js";
import type { Tool, ToolContext } from "../tools/interface.js";

/** One agent's hooks for one event. */
export interface ResolvedEventHooks {
  agent: string;
  event: string;
  hooks: EventHook[];
}

/**
 * Collect every config-declared event hook, across agents.
 *
 * Flat rather than nested by agent, because dispatch is by event: the bus
 * subscribes once per event name and then asks which agents care.
 */
export function resolveEventHooks(config: AgentConfig): ResolvedEventHooks[] {
  const out: ResolvedEventHooks[] = [];
  for (const [agent, block] of Object.entries(config.agents ?? {})) {
    const on = block?.hooks?.on;
    if (!on) continue;
    for (const [event, declared] of Object.entries(on)) {
      const hooks = Array.isArray(declared) ? declared : [declared];
      if (hooks.length > 0) out.push({ agent, event, hooks });
    }
  }
  return out;
}

/**
 * Does this payload match a hook's `when`?
 *
 * Exact by default, `/…/` for a regex. Exactness is the safer default for a
 * matcher that gates tool execution: an unanchored pattern quietly matching a
 * neighbouring tool name is the wrong kind of surprise in a security control,
 * and it is the mistake Claude Code's own matcher docs spend a paragraph
 * warning about.
 *
 * A field the payload does not have never matches. Saying "this hook wanted
 * something that is not there" is more useful than treating absence as a
 * wildcard, which would fire the hook on every event of that name.
 */
export function matchesWhen(payload: Record<string, unknown>, when: Record<string, string> | undefined): boolean {
  if (!when) return true;
  for (const [key, want] of Object.entries(when)) {
    const value = payload[key];
    if (value === undefined || value === null) return false;
    const actual = String(value);
    if (want.length > 1 && want.startsWith("/") && want.endsWith("/")) {
      try {
        if (!new RegExp(want.slice(1, -1)).test(actual)) return false;
      } catch {
        // A malformed regex matches nothing rather than everything. The
        // permissive reading of a broken pattern would silently widen a gate.
        return false;
      }
      continue;
    }
    if (actual !== want) return false;
  }
  return true;
}

export interface RunEventHooksOptions {
  hooks: EventHook[];
  payload: Record<string, unknown>;
  tools: Tool[];
  sessionId: string;
  /** Whether this event can be refused. Decides what a `denyIf` or an error means. */
  refusable: boolean;
  promptsConfig?: AgentConfig["prompts"];
  logPrefix?: string;
}

/**
 * Run one event's hooks in order.
 *
 * Returns a refusal when a hook asks for one, and stops at the first: a second
 * opinion after a refusal changes nothing, and running it would let a later
 * hook's side effects happen on an operation that is not going to occur.
 */
export async function runEventHooks(opts: RunEventHooksOptions): Promise<{ deny?: string }> {
  const prefix = opts.logPrefix ?? "[event-hooks]";
  const context: ToolContext = { sessionId: opts.sessionId, workingDirectory: process.cwd(), env: {} };

  for (const hook of opts.hooks) {
    if (!matchesWhen(opts.payload, hook.when)) continue;

    const tool = opts.tools.find((t) => t.name === hook.tool);
    if (!tool) {
      // A missing tool is a configuration problem — a disabled plugin, a
      // renamed tool — and it should not take an unrelated operation down.
      // Same reading `executeHooks` gives it.
      console.error(`${prefix} hook tool "${hook.tool}" not found, skipping`);
      continue;
    }

    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(hook.args ?? {})) {
      args[key] =
        typeof value === "string" ? await expandPrompt(value, stringVars(opts.payload), opts.promptsConfig) : value;
    }

    try {
      const result = await tool.execute(args, context);
      if (result.success === false) throw new Error(result.error ?? "(no detail)");

      const output = toolOutputText(result.output);
      if (opts.refusable && hook.denyIf && new RegExp(hook.denyIf).test(output)) {
        return { deny: output };
      }
    } catch (err) {
      const message = `hook "${hook.tool}" failed: ${(err as Error).message}`;
      console.error(`${prefix} ${message}`);
      // Fail closed on anything refusable, unless told otherwise. A policy
      // check that could not run has not passed, and reading its failure as
      // approval is precisely the gap #545 describes. Named rather than
      // generic, so a broken hook is diagnosable instead of a mystery refusal.
      if (opts.refusable && (hook.onError ?? "abort") === "abort") {
        return { deny: `Refused: a policy hook could not run — ${message}` };
      }
    }
  }
  return {};
}

/** Payload fields a hook's `args` templates can interpolate. */
function stringVars(payload: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    vars[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return vars;
}
