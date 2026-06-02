/**
 * Built-in Discord channel registration. Importing this module for side
 * effects is the legacy path — recommended is to call
 * {@link registerDiscordChannel} against your runtime's PluginContext
 * during boot. The side-effect call below stays during the deprecation
 * window so existing consumers don't break; tracked in #47.
 */
import type { PluginContext } from "../plugin-context.js";
import { DiscordChannel } from "./discord.js";
import type { OutboundNotifier } from "./outbound.js";
import { type ChannelFactory, registerChannelFactory } from "./registry.js";

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
 * Call this from the host (CLI / embedder) once before starting channels.
 */
export function registerDiscordChannel(ctx: PluginContext): void {
  ctx.channels.register("discord", discordFactory);
}

/**
 * @deprecated Importing this module for side effects is going away. Prefer
 * calling {@link registerDiscordChannel} against your runtime's
 * PluginContext during boot. See #47.
 */
registerChannelFactory("discord", discordFactory);

/** Cast helper for callers that need the OutboundNotifier surface. */
export function asNotifier(channel: unknown): OutboundNotifier | undefined {
  const c = channel as { id?: unknown; send?: unknown; sendDM?: unknown };
  if (typeof c.id === "string" && typeof c.send === "function" && typeof c.sendDM === "function") {
    return channel as OutboundNotifier;
  }
  return undefined;
}
