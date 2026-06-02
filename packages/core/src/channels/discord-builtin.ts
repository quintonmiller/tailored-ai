/**
 * Built-in Discord channel registration. Seeded into every runtime's
 * channel registry by {@link registerCoreBuiltins}. Embedders calling
 * runtime construction manually should let that aggregator run; if they
 * want to seed Discord directly into a custom context they can call
 * {@link registerDiscordChannel} instead.
 */
import type { PluginContext } from "../plugin-context.js";
import { DiscordChannel } from "./discord.js";
import type { OutboundNotifier } from "./outbound.js";
import type { ChannelFactory } from "./registry.js";

const discordFactory: ChannelFactory = async (runtime, _cfg) => {
  const channel = new DiscordChannel({ runtime });
  await channel.connect();
  return {
    channel,
    disconnect: () => channel.disconnect(),
  };
};

/**
 * Register the built-in Discord channel against the given PluginContext.
 */
export function registerDiscordChannel(ctx: PluginContext): void {
  ctx.channels.register("discord", discordFactory);
}

/** Cast helper for callers that need the OutboundNotifier surface. */
export function asNotifier(channel: unknown): OutboundNotifier | undefined {
  const c = channel as { id?: unknown; send?: unknown; sendDM?: unknown };
  if (typeof c.id === "string" && typeof c.send === "function" && typeof c.sendDM === "function") {
    return channel as OutboundNotifier;
  }
  return undefined;
}
