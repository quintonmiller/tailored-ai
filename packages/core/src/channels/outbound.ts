/**
 * The minimal outbound surface that cron, autopilot, and task-watcher need
 * from a channel. Built so a Slack / Telegram / iMessage channel can drop in
 * wherever Discord lives today without the consumers caring which transport
 * is on the other side.
 *
 * DiscordChannel satisfies this trivially (it already has `send` and `sendDM`).
 */
export interface OutboundNotifier {
  /** Stable id of the channel — used for logging and registry lookup. */
  readonly id: string;
  /** Post a message to a channel/room/thread target. */
  send(target: string, content: string): Promise<void>;
  /** Direct-message a user by id. */
  sendDM(userId: string, content: string): Promise<void>;
}
