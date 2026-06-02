import type { AgentRuntime } from "../runtime.js";
import { channelFactoryRegistry, type StartedChannel } from "./registry.js";

/**
 * Per-channel lifecycle manager keyed by channel id. Computes the desired
 * set of running channels from the active config and reconciles it against
 * the currently-running set as a set difference: starts new channels, stops
 * removed ones, restarts those whose config changed.
 *
 * Closes the bug where a hot-reload that re-ran {@link startRegisteredChannels}
 * would call every registered factory again — leaving a second Slack Bolt
 * app listening on Socket Mode while the first kept running, so every
 * incoming message fired the agent loop twice (#58).
 *
 * Usage:
 *
 *     const channels = new ChannelLifecycleManager();
 *     await channels.reconcile(runtime);  // initial start
 *     runtime.onReload(() => channels.reconcile(runtime));  // hot-reload
 *
 * The manager is the source of truth for "which channels are running" —
 * callers that need a notifier or a channel handle should pull it from
 * `channels.get(id)`.
 */
export class ChannelLifecycleManager {
  private active = new Map<string, StartedChannel>();
  /** JSON-serialized config block per channel, used to detect updates. */
  private lastConfigSignature = new Map<string, string>();

  /**
   * Drive the active channel set to match the runtime's current config.
   * Safe to call repeatedly on the same config — idempotent.
   */
  async reconcile(runtime: AgentRuntime): Promise<void> {
    const blocks = (runtime.getConfig().channels ?? {}) as Record<string, Record<string, unknown> | undefined>;

    // Build the desired set: channels whose config block exists, has
    // enabled: true, AND has a registered factory.
    const desired = new Map<string, Record<string, unknown>>();
    for (const [id] of channelFactoryRegistry.entriesList()) {
      const cfg = blocks[id];
      if (cfg && cfg.enabled === true) desired.set(id, cfg);
    }

    // 1. Stop channels that are no longer desired OR whose config changed.
    //    Stopping config-changed channels here lets the "start" pass below
    //    bring them back up with fresh config.
    for (const [id, running] of [...this.active.entries()]) {
      const want = desired.get(id);
      const wantSig = want ? JSON.stringify(want) : undefined;
      const lastSig = this.lastConfigSignature.get(id);
      if (!want || wantSig !== lastSig) {
        try {
          await running.disconnect();
        } catch (err) {
          console.error(`[channel:${id}] Disconnect error: ${(err as Error).message}`);
        }
        this.active.delete(id);
        this.lastConfigSignature.delete(id);
      }
    }

    // 2. Start channels that are desired but not currently running.
    for (const [id, cfg] of desired.entries()) {
      if (this.active.has(id)) continue;
      const factory = channelFactoryRegistry.get(id);
      if (!factory) continue;
      try {
        const conn = await factory(runtime, cfg);
        if (conn) {
          this.active.set(id, { name: id, channel: conn.channel, disconnect: conn.disconnect });
          this.lastConfigSignature.set(id, JSON.stringify(cfg));
        }
      } catch (err) {
        console.error(`[channel:${id}] Failed to start: ${(err as Error).message}`);
      }
    }
  }

  /** Return the started channel for `id`, or undefined if not running. */
  get(id: string): StartedChannel | undefined {
    return this.active.get(id);
  }

  /** Snapshot of currently-running channels. */
  list(): StartedChannel[] {
    return [...this.active.values()];
  }

  /** Stop every running channel (e.g. process shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.active.entries()];
    this.active.clear();
    this.lastConfigSignature.clear();
    await Promise.all(
      all.map(async ([id, c]) => {
        try {
          await c.disconnect();
        } catch (err) {
          console.error(`[channel:${id}] Disconnect error: ${(err as Error).message}`);
        }
      }),
    );
  }
}
