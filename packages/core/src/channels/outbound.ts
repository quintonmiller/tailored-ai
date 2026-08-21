import type { MessageContent } from "../content/types.js";
import type { SurfaceCapabilities } from "./capabilities.js";

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
  /**
   * What this surface can show. Required, not optional, and that is the point:
   * an optional capability field is one nobody fills in and nobody reads, which
   * is how `AIProvider.supportsTools` spent its whole life. Surfaces with
   * nothing to declare spread {@link TEXT_ONLY_SURFACE} and are then honestly
   * described rather than merely undescribed.
   */
  readonly capabilities: SurfaceCapabilities;
  /**
   * Post a message to a channel/room/thread target.
   *
   * The `MessageContent` arm carries media. A plain string still means exactly
   * what it always meant, so every existing caller is unchanged — only callers
   * that have media to send reach for the wider arm.
   */
  send(target: string, content: string | MessageContent): Promise<void>;
  /** Direct-message a user by id. */
  sendDM(userId: string, content: string | MessageContent): Promise<void>;
}
