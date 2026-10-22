/**
 * How a due subscription becomes a turn.
 *
 * A room target goes through the room watcher, which applies the room's turn
 * order, in-flight guard, hourly ceiling and `pass` — the same path a
 * scheduled wake takes. A session target runs in the agent's own
 * `subscriptions:<agent>` session through `runtime.wakeAgent`, the way a
 * plugin's own turn does, so the two share one hourly ceiling per agent, the
 * size of a room's.
 */
import type { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { renderEventLines } from "./describe.js";
import type { DeliveryOutcome, EventWakeContext, SubscriptionDelivery } from "./types.js";

export interface SubscriptionDeliveryOptions {
  runtime: AgentRuntime;
  /** Lazy, like the schedule runner's: rooms may start after this is built. */
  getRoomWatcher: () => RoomWatcher | undefined;
}

export function createSubscriptionDelivery(opts: SubscriptionDeliveryOptions): SubscriptionDelivery {
  return {
    async toRoom(agent: string, room: string, ctx: EventWakeContext): Promise<DeliveryOutcome> {
      const watcher = opts.getRoomWatcher();
      // Rooms may still be starting. Retried, and dropped with a warning if
      // they never come up.
      if (!watcher) return "at-ceiling";
      return watcher.runEventWake(agent, room, ctx);
    },

    async toSession(agent: string, ctx: EventWakeContext): Promise<DeliveryOutcome> {
      const prompt = [
        "Something you subscribe to happened. Nobody has asked you anything.",
        "",
        ...renderEventLines(ctx),
        "",
        "Act on it if it needs anything. If it does not, say so in one line and stop.",
        "Nobody is reading this session. If something here needs to reach a person, send it — a reply here goes nowhere on its own.",
      ].join("\n");
      const outcome = await opts.runtime.wakeAgent(agent, {
        prompt,
        sessionKey: `subscriptions:${agent}`,
        wake: ctx.wake ?? { kind: "subscription" },
      });
      // A pause passes like a ceiling does: the dispatcher holds the events and
      // tries again.
      return outcome === "paused" ? "at-ceiling" : outcome;
    },
  };
}
