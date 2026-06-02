/**
 * Configuration shape this channel reads from `config.channels.slack`. The
 * field names mirror Discord's where they overlap (`enabled`, `owner`,
 * `projectMappings`, `respondToDMs`, `respondToMentions`) so config flows
 * remain symmetric.
 */
export interface SlackChannelConfig {
  enabled?: boolean;
  /**
   * Bot token (`xoxb-...`). Sent on every Web API call. Required.
   * Env-substituted via the standard `${SLACK_BOT_TOKEN}` syntax.
   */
  token?: string;
  /**
   * App-level token (`xapp-...`) with `connections:write`. Required for
   * Socket Mode, which is the only transport this MVP supports. Without it
   * you'd need a public HTTP endpoint for events.
   */
  appToken?: string;
  /** Slack user id of the bot owner. Reserved — not used in the MVP. */
  owner?: string;
  /** Reply to direct messages (default true). */
  respondToDMs?: boolean;
  /** Reply to channel mentions (default true). DMs ignore this. */
  respondToMentions?: boolean;
  /**
   * Workspaces this bot may serve. Empty / unset means "all installed."
   * Each entry is a Slack team id (e.g. `T01234567`).
   */
  allowedTeams?: string[];
  /**
   * Project mappings, same shape as `channels.discord.projectMappings`:
   * `channel` binds a Slack channel id (`C01234`), `dm: true` matches any
   * direct message. First match wins.
   */
  projectMappings?: Array<({ channel: string } | { dm: true }) & { project: string }>;
}
