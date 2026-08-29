/**
 * Binds config-declared hooks to the runtime bus.
 *
 * `hooks.beforeRun` / `hooks.afterRun` reach two fixed points in a turn.
 * `hooks.on` reaches the rest of the bus — and until this existed, everything
 * else took writing a plugin, which is a different job with a different
 * audience.
 *
 * A plugin rather than a core path because *how* config reaches the bus is an
 * opinion: the matcher syntax, the fail-closed default, the one-refusal-wins
 * rule. A deployment that wants different ones disables this and subscribes its
 * own handler. What is in core is the bus and the events, which is the part
 * nothing else can provide.
 */

import { type ResolvedEventHooks, resolveEventHooks, runEventHooks } from "../agent/event-hooks.js";
import { agentOfPayload, isWaterfallEvent, type Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

export interface ConfigHooksOptions {
  runtime: AgentRuntime;
}

/** The bus as seen through a name that is only known at runtime. */
type Payload = Record<string, unknown>;
interface UntypedBus {
  on(event: string, handler: (payload: Payload) => void): Subscription;
  onWaterfall(
    event: string,
    handler: (payload: Payload, next: (payload: Payload) => Promise<Payload>) => Promise<Payload>,
  ): Subscription;
}

export class ConfigHooks {
  private runtime: AgentRuntime;
  private subscriptions: Subscription[] = [];

  constructor(opts: ConfigHooksOptions) {
    this.runtime = opts.runtime;
    this.subscribe();
  }

  stop(): void {
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions = [];
  }

  /**
   * One subscription per distinct event name, not per hook.
   *
   * The bus clears on reload and every plugin re-runs, so this re-reads config
   * each time it is constructed and needs no reconciliation of its own.
   */
  private subscribe(): void {
    const declared = resolveEventHooks(this.runtime.getConfig());
    const byEvent = new Map<string, ResolvedEventHooks[]>();
    for (const entry of declared) {
      const list = byEvent.get(entry.event) ?? [];
      list.push(entry);
      byEvent.set(entry.event, list);
    }

    // One localized cast, and the honest reason for it: an event name read out
    // of config is a `string`, so the typed map cannot narrow it. Casting the
    // bus once here is better than spreading `as never` through the handlers,
    // where it would erase the payload types too.
    const bus = this.runtime.events as unknown as UntypedBus;

    for (const [event, entries] of byEvent) {
      if (isWaterfallEvent(event)) {
        this.subscriptions.push(
          bus.onWaterfall(event, async (payload, next) => {
            const { deny, args } = await this.run(entries, payload, true);
            // A refusal short-circuits rather than continuing the chain: handing
            // the payload on with `deny` set would let a later subscriber clear
            // it, and a refusal a subsequent link can undo is not one.
            if (deny) return { ...payload, deny };
            // A rewrite continues down the chain, because it is not a decision
            // — a later subscriber should see the corrected call and is free to
            // refuse it.
            return next(args ? { ...payload, args } : payload);
          }),
        );
        continue;
      }
      this.subscriptions.push(
        bus.on(event, (payload) => {
          void this.run(entries, payload, false);
        }),
      );
    }
  }

  /**
   * Run every declaring site's hooks for one occurrence.
   *
   * Two scopes. A hook under `agents.reviewer` fires on the reviewer's
   * occurrences and nobody else's; a hook under the top-level `hooks.on` fires
   * on all of them. The second exists because most events name no agent at all
   * — a task transition, a proposal opening, a compaction — and before it,
   * those bound cleanly under an agent and then never ran.
   *
   * The agent is read under either spelling. Four events say `agentName` where
   * the rest say `agent`, and the scoping used to look only for the latter, so
   * a hook on `agent.completed` never matched despite the payload naming the
   * agent right there.
   */
  private async run(
    entries: ResolvedEventHooks[],
    rawPayload: Record<string, unknown>,
    refusable: boolean,
  ): Promise<{ deny?: string; args?: Record<string, unknown> }> {
    const agent = agentOfPayload(rawPayload);
    // Normalised once, before matching: `when: { agent: … }` should mean the
    // same thing on every event rather than depending on which spelling that
    // event happens to use. Never overwrites a field the payload already has.
    const payload = agent && rawPayload.agent === undefined ? { ...rawPayload, agent } : rawPayload;
    const config = this.runtime.getConfig();
    // Resolved once per occurrence rather than per hook: it is the same answer
    // for every hook in this dispatch, and resolving an agent is not free.
    const toolContext = this.runtime.agentToolContext(agent);
    // Threaded across entries for the same reason it is threaded across hooks:
    // whoever looks next should see the call as it now stands.
    let current = payload;
    let rewritten: Record<string, unknown> | undefined;

    for (const entry of entries) {
      // `undefined` is the deployment's own, which is not scoped to anyone.
      if (entry.agent !== undefined && entry.agent !== agent) continue;
      const { deny, args } = await runEventHooks({
        event: entry.event,
        hooks: entry.hooks,
        payload: current,
        tools: this.runtime.getTools(),
        toolContext,
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "event-hook",
        refusable,
        promptsConfig: config.prompts,
        logPrefix: `[hooks:${entry.event}]`,
      });
      if (deny) return { deny };
      if (args) {
        rewritten = args;
        current = { ...current, args };
      }
    }
    return rewritten ? { args: rewritten } : {};
  }
}

/** Default-plugin entry point — loaded via `config.plugins: builtin:config-hooks`. */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const hooks = new ConfigHooks({ runtime: ctx.runtime });
  return () => hooks.stop();
};

export const meta: PluginMeta = {
  name: "Config hooks",
  description: "Runs `hooks.on` entries — config-declared hooks bound to runtime events.",
  registers: [{ kind: "eventSubscriber", id: "config-hooks" }],
};

export default plugin;
