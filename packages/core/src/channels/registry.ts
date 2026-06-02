import { Registry } from "../registry.js";
import type { AgentRuntime } from "../runtime.js";
import type { Channel } from "./interface.js";

export interface ChannelConnection {
  channel: Channel;
  disconnect: () => Promise<void>;
}

/**
 * Connect a channel and return its disconnect handle. Implementations read
 * their own config slice (`config.channels[id]`) and decide whether to start.
 * Returning undefined means "no-op" (e.g. config block exists but enabled:false).
 */
export type ChannelFactory = (
  runtime: AgentRuntime,
  config: Record<string, unknown>,
) => Promise<ChannelConnection | undefined>;

export const channelFactoryRegistry = new Registry<ChannelFactory>("channel");

/**
 * @deprecated Prefer the {@link Plugin} contract: call
 * `ctx.channels.register(id, factory)` from a plugin's `default(ctx)`. This
 * free function will be removed once internal consumers migrate — see #47.
 */
export function registerChannelFactory(id: string, factory: ChannelFactory): void {
  channelFactoryRegistry.register(id, factory);
}

export interface StartedChannel {
  name: string;
  channel: Channel;
  disconnect: () => Promise<void>;
}

/**
 * Start every registered channel whose config block has enabled: true. Used
 * by the CLI on server startup; embeds can call it the same way after
 * constructing the runtime. Errors from individual channels are logged and
 * skipped so one bad channel can't block the others.
 *
 * Built-in channels (e.g. Discord) register themselves into this registry on
 * module import, so they come up via the same path as plugin-supplied
 * channels — no special-case construction at the CLI level.
 */
export async function startRegisteredChannels(runtime: AgentRuntime): Promise<StartedChannel[]> {
  const started: StartedChannel[] = [];
  const allChannelsConfig = (runtime.getConfig().channels ?? {}) as Record<string, Record<string, unknown> | undefined>;

  for (const [id, factory] of channelFactoryRegistry.entriesList()) {
    const cfg = allChannelsConfig[id];
    if (!cfg || cfg.enabled !== true) continue;
    try {
      const conn = await factory(runtime, cfg);
      if (conn) {
        started.push({ name: id, channel: conn.channel, disconnect: conn.disconnect });
      }
    } catch (err) {
      console.warn(`[channel:${id}] Failed to start: ${(err as Error).message} — continuing without this channel`);
    }
  }
  return started;
}
