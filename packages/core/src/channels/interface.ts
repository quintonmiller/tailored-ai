import type { MessageContent } from "../content/types.js";
import type { SurfaceCapabilities } from "./capabilities.js";

/**
 * A message arriving from a transport.
 *
 * This interface was exported for a long time and **constructed by nothing** —
 * every surface (Discord, Slack, the CLI, the HTTP API, webhooks, rooms, cron,
 * delegate, agent-to-agent DMs) flattened its own way to a bare `string` before
 * calling `runAgentLoop`. It is kept, and now carries the fields a channel
 * actually has, because attachments need somewhere to live that is not a
 * string.
 */
export interface IncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  isDM: boolean;
  isMention: boolean;
  replyTo?: string;
  /**
   * Media that arrived with the message — Discord `attachments[]`, Slack
   * `files[]`, a UI upload. Already stored, so this is a reference rather than
   * a payload.
   */
  media?: import("../content/types.js").MediaRef[];
}

export interface Channel {
  id: string;
  type: string;

  /**
   * What this transport can show. See `SurfaceCapabilities` — required for the
   * same reason it is required on `OutboundNotifier`, and the two are the same
   * struct because they describe the same surface from two angles.
   */
  readonly capabilities: SurfaceCapabilities;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /**
   * Deliver a message. The `MessageContent` arm carries media; implementations
   * run it through `renderForSurface` so the degradation ladder is applied in
   * one shared place rather than reinvented per transport.
   */
  send(target: string, content: string | MessageContent): Promise<void>;

  /**
   * Optional capability: signal the user that the agent is working on a reply
   * (typing indicator, reaction, status update — transport's choice). Returns
   * a "stop" function the caller invokes once the work is finished; calling
   * stop more than once must be safe. Channels that have no equivalent
   * concept simply omit the method.
   */
  indicateWorking?(target: string): () => void;

  /**
   * Optional capability: expose this transport's named destinations as rooms,
   * so several agents and humans can hold one conversation in one place.
   * Present only while connected — a room backend wrapping a dead client is
   * worse than none. Transports with no group concept omit it.
   */
  rooms?: import("../rooms/types.js").RoomBackend;
}
