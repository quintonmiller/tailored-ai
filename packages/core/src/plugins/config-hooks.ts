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
import { isWaterfallEvent, type Subscription } from "../events.js";
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
            const deny = await this.run(entries, payload, true);
            // A refusal short-circuits rather than continuing the chain: handing
            // the payload on with `deny` set would let a later subscriber clear
            // it, and a refusal a subsequent link can undo is not one.
            return deny ? { ...payload, deny } : next(payload);
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
   * Run every declaring agent's hooks for one occurrence.
   *
   * Scoped by `payload.agent`: a hook declared under `agents.reviewer` fires on
   * the reviewer's turns and nobody else's. An event with no agent on it — a
   * task or schedule event — matches nothing, which is why those are better
   * served by a plugin today.
   */
  private async run(
    entries: ResolvedEventHooks[],
    payload: Record<string, unknown>,
    refusable: boolean,
  ): Promise<string | undefined> {
    const agent = typeof payload.agent === "string" ? payload.agent : undefined;
    const config = this.runtime.getConfig();

    for (const entry of entries) {
      if (entry.agent !== agent) continue;
      const { deny } = await runEventHooks({
        hooks: entry.hooks,
        payload,
        tools: this.runtime.getTools(),
        sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "event-hook",
        refusable,
        promptsConfig: config.prompts,
        logPrefix: `[hooks:${entry.event}]`,
      });
      if (deny) return deny;
    }
    return undefined;
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
