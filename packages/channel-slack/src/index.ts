/**
 * Side-effect entry point. Importing this module registers Slack as the
 * "slack" channel factory in `@tailored-ai/core`'s channel registry, so the
 * runtime's `startRegisteredChannels` picks it up the same way it picks up
 * Discord (and any other channel plugin).
 *
 * To use, add this to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/channel-slack"
 *     channels:
 *       slack:
 *         enabled: true
 *         token: ${SLACK_BOT_TOKEN}
 *         appToken: ${SLACK_APP_TOKEN}
 *         respondToDMs: true
 *         respondToMentions: true
 */
import { registerChannelFactory } from "@tailored-ai/core";
import { SlackChannel } from "./channel.js";
import type { SlackChannelConfig } from "./types.js";

registerChannelFactory("slack", async (runtime, cfg) => {
  const channel = new SlackChannel({ runtime, config: cfg as SlackChannelConfig });
  await channel.connect();
  return {
    channel,
    disconnect: () => channel.disconnect(),
  };
});

export { SlackChannel } from "./channel.js";
export type { SlackChannelConfig } from "./types.js";
