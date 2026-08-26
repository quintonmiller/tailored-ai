/**
 * Makes the `tool_called` workflow trigger fire.
 *
 * It has been a declared trigger kind for some time — in `WorkflowTriggerDef`,
 * validated by the loader, and advertised through the resource trigger registry
 * as "Fires when a specific tool is invoked". Nothing dispatched it (#561). A
 * deployment could write the config, watch it validate, see it in the UI, and
 * get nothing: no warning, no error, no run.
 *
 * It could not be fixed on its own, which is why it sat. Every other trigger
 * kind that fires has a poller; this one needs to know when a tool ran, and
 * until `agent.post_tool_use` existed there was no tool-level event on the bus
 * to hear. Now there is, and this is its first consumer — a subscriber, not a
 * poller, because the loop already says when a call happened.
 *
 * A plugin rather than a core path, for the ordinary reason: firing a workflow
 * off a tool call is an opinion, and a deployment that wants a different one
 * disables this and subscribes its own handler.
 */

import type { Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

export interface ToolCalledTriggerOptions {
  runtime: AgentRuntime;
}

export class ToolCalledTrigger {
  private runtime: AgentRuntime;
  private subscription: Subscription | undefined;

  constructor(opts: ToolCalledTriggerOptions) {
    this.runtime = opts.runtime;
    this.subscription = this.runtime.events.on("agent.post_tool_use", (e) => {
      this.handle(e.tool, e.args, e.output);
    });
  }

  stop(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
  }

  /**
   * Run every workflow whose `tool_called` trigger names this tool.
   *
   * The registry is walked per event rather than indexed once: workflows
   * hot-reload from disk, and a cached map would go stale exactly when someone
   * is editing a workflow to test it — which is the moment they are least
   * likely to suspect a cache.
   */
  private handle(tool: string, args: Record<string, unknown>, output: string): void {
    const engine = this.runtime.getWorkflowEngine();
    // No engine on this path (a CLI single-message run, say). Nothing to start,
    // and nothing worth warning about on every tool call.
    if (!engine) return;

    for (const wf of this.runtime.getWorkflows().list()) {
      const fires = (wf.definition.triggers ?? []).some((t) => t.kind === "tool_called" && t.tool === tool);
      if (!fires) continue;
      // Fire and forget, deliberately. The tool has already returned and the
      // model is waiting on the loop; making a turn wait for a workflow would
      // turn an observer into a step in the critical path.
      engine
        .runWorkflow(wf.definition.name, { tool, args, output }, "programmatic")
        .catch((err: Error) => console.error(`[tool-called] workflow "${wf.definition.name}" failed: ${err.message}`));
    }
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins: builtin:tool-called-trigger`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const trigger = new ToolCalledTrigger({ runtime: ctx.runtime });
  return () => trigger.stop();
};

export const meta: PluginMeta = {
  name: "Tool-called trigger",
  description: "Runs workflows whose `tool_called` trigger names a tool the agent just used.",
  registers: [{ kind: "eventSubscriber", id: "tool-called-trigger" }],
};

export default plugin;
