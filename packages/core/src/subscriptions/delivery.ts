/**
 * How a due subscription becomes a turn.
 *
 * A room target goes through the room watcher, which applies the room's turn
 * order, in-flight guard, hourly ceiling and `pass` — the same path a
 * scheduled wake takes. A session target runs in the agent's own
 * `subscriptions:<agent>` session, the way a cron job does, under an hourly
 * ceiling of the same size as a room's, counted per agent.
 */
import { resolveAgent } from "../agent/agents.js";
import { runAgentLoop } from "../agent/loop.js";
import { findOrCreateSession } from "../agent/session.js";
import { ROOM_WATCHER_DEFAULTS, type RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { renderEventLines } from "./describe.js";
import type { DeliveryOutcome, EventWakeContext, SubscriptionDelivery } from "./types.js";

const HOUR_MS = 3_600_000;

export interface SubscriptionDeliveryOptions {
  runtime: AgentRuntime;
  /** Lazy, like the schedule runner's: rooms may start after this is built. */
  getRoomWatcher: () => RoomWatcher | undefined;
  now?: () => number;
}

export function createSubscriptionDelivery(opts: SubscriptionDeliveryOptions): SubscriptionDelivery {
  const now = opts.now ?? (() => Date.now());
  const sessionWakes = new Map<string, number[]>();

  return {
    async toRoom(agent: string, room: string, ctx: EventWakeContext): Promise<DeliveryOutcome> {
      const watcher = opts.getRoomWatcher();
      // Rooms may still be starting. Retried, and dropped with a warning if
      // they never come up.
      if (!watcher) return "at-ceiling";
      return watcher.runEventWake(agent, room, ctx);
    },

    async toSession(agent: string, ctx: EventWakeContext): Promise<DeliveryOutcome> {
      const { runtime } = opts;
      if (runtime.isAgentsPaused("autonomous")) return "at-ceiling";

      const limit = runtime.getConfig().rooms?.maxWakesPerHour ?? ROOM_WATCHER_DEFAULTS.maxWakesPerHour;
      const t = now();
      const recent = (sessionWakes.get(agent) ?? []).filter((at) => t - at < HOUR_MS);
      if (recent.length >= limit) {
        sessionWakes.set(agent, recent);
        console.warn(`[subscriptions] ${agent} is at its wake ceiling (${limit}/hour); holding its events.`);
        return "at-ceiling";
      }
      recent.push(t);
      sessionWakes.set(agent, recent);

      const resolved = resolveAgent(
        agent,
        runtime.getConfig(),
        runtime.getResolvableTools(),
        undefined,
        runtime.contextDir,
        undefined,
        runtime.buildResolveOptions(),
      );
      const session = findOrCreateSession(runtime.db, `subscriptions:${agent}`, resolved.model, resolved.provider);
      const prompt = [
        "Something you subscribe to happened. Nobody has asked you anything.",
        "",
        ...renderEventLines(ctx),
        "",
        "Act on it if it needs anything. If it does not, say so in one line and stop.",
        "Nobody is reading this session. If something here needs to reach a person, send it — a reply here goes nowhere on its own.",
      ].join("\n");
      console.log(`[subscriptions] waking ${agent} in its session for ${ctx.events.length} event(s)`);
      await runAgentLoop(prompt, runtime.buildLoopOptions({ session, agentName: agent }));
      return "ran";
    },
  };
}
