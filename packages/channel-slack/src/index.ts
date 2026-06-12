/**
 * @tailored-ai/channel-slack
 *
 * Slack channel for Tailored AI agents, packaged as a register(ctx) plugin
 * (#47). The host invokes the default export with a {@link PluginContext}
 * during runtime construction; the plugin registers a channel factory the
 * runtime starts when `channels.slack.enabled: true`.
 *
 * To use, add the package to `config.yaml`:
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
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { SlackChannel } from "./channel.js";
import type { SlackChannelConfig } from "./types.js";

const plugin: Plugin = (ctx) => {
  ctx.channels.register("slack", async (runtime, cfg) => {
    const channel = new SlackChannel({ runtime, config: cfg as SlackChannelConfig });
    await channel.connect();
    return {
      channel,
      disconnect: () => channel.disconnect(),
    };
  });
};

export const meta: PluginMeta = {
  name: "Slack channel",
  description: "Talk to your agent from Slack (Bolt, Socket Mode). DMs and channel mentions.",
  registers: [{ kind: "channel", id: "slack", configKey: "channels.slack" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.channels.slack as SlackChannelConfig | undefined;
  if (!cfg?.enabled) return [];
  const warnings: string[] = [];
  if (!cfg.token) warnings.push("channels.slack.enabled is true but token (xoxb-…) is missing");
  if (!cfg.appToken) {
    warnings.push("channels.slack.enabled is true but appToken (xapp-…, Socket Mode) is missing");
  }
  return warnings;
}

export default plugin;

export { SlackChannel } from "./channel.js";
export type { SlackChannelConfig } from "./types.js";
