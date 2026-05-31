/**
 * Built-in Discord registration. Importing this module side-effect-registers
 * the Discord channel into the channel factory registry, so the CLI's
 * startRegisteredChannels picks it up the same way it picks up plugin
 * channels.
 */
import { DiscordChannel } from "./discord.js";
import type { OutboundNotifier } from "./outbound.js";
import { registerChannelFactory } from "./registry.js";

registerChannelFactory("discord", async (runtime, _cfg) => {
  const channel = new DiscordChannel({ runtime });
  await channel.connect();
  return {
    channel,
    disconnect: () => channel.disconnect(),
  };
});

/** Cast helper for callers that need the OutboundNotifier surface. */
export function asNotifier(channel: unknown): OutboundNotifier | undefined {
  const c = channel as { id?: unknown; send?: unknown; sendDM?: unknown };
  if (typeof c.id === "string" && typeof c.send === "function" && typeof c.sendDM === "function") {
    return channel as OutboundNotifier;
  }
  return undefined;
}
