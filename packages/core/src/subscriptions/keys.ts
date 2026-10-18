/**
 * Two small helpers config validation and the dispatcher both need, kept apart
 * from the dispatcher so `config.ts` — which nearly everything imports — does
 * not pull in the room watcher through it.
 */
import { parseEvery } from "../schedules/when.js";
import type { EventSubscriptionConfig } from "./types.js";

/**
 * A subscription's identity across restarts: everything that decides which
 * events it receives and where they go. Change any of it and pending events
 * belong to a subscription that no longer exists.
 */
export function subscriptionKey(sub: EventSubscriptionConfig): string {
  const when = sub.when
    ? Object.keys(sub.when)
        .sort()
        .map((k) => `${k}=${sub.when?.[k]}`)
        .join("&")
    : "";
  const target = !sub.target || sub.target === "session" ? "session" : `room:${sub.target.room}`;
  return [sub.agent, sub.on, when, sub.deliver ?? "queue", target, sub.window ?? "", sub.every ?? ""].join("|");
}

/** `5m`, `30 seconds`, `2h` → milliseconds, or undefined when it is not a plain duration. */
export function parseWindow(window: string): number | undefined {
  try {
    const rec = parseEvery(`every ${window.trim()}`);
    return rec.mode === "interval" ? rec.seconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}
