import { App, LogLevel } from "@slack/bolt";
import type { AgentRuntime, Channel, MediaRef, OutboundNotifier, ProjectRef } from "@tailored-ai/core";
import { executeHooks, runAgentLoop } from "@tailored-ai/core";
import type { SlackChannelConfig } from "./types.js";

/**
 * Slack's recommended max for a single message is 3000 chars (chat.postMessage
 * accepts more but rejects oversized rich layouts). Splitting on newlines
 * keeps code blocks readable.
 */
const MAX_MESSAGE_LENGTH = 3000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (cut < MAX_MESSAGE_LENGTH / 2) cut = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    if (cut < MAX_MESSAGE_LENGTH / 2) cut = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}

export interface SlackChannelOptions {
  runtime: AgentRuntime;
  config: SlackChannelConfig;
}

/**
 * Bolt-based Slack channel. Listens on Socket Mode (no public webhook
 * required), routes direct messages and @-mentions to the agent loop, and
 * implements `OutboundNotifier` so cron / autopilot / task-watcher can
 * post replies through the same transport.
 *
 * Intentionally narrower than the Discord channel — no slash commands, no
 * /context/tasks built-ins, no command parsing. Those live as TODOs in the
 * README; the goal here is a readable reference implementation.
 */
/** The subset of Slack's file object this channel uses. */
interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  url_private?: string;
}

export class SlackChannel implements Channel, OutboundNotifier {
  readonly id = "slack";
  readonly type = "slack";

  private app: App;
  private runtime: AgentRuntime;
  private config: SlackChannelConfig;
  private botUserId: string | undefined;
  private processing = new Set<string>();

  constructor(opts: SlackChannelOptions) {
    this.runtime = opts.runtime;
    this.config = opts.config;
    if (!opts.config.token) throw new Error("channels.slack.token is required");
    if (!opts.config.appToken) {
      throw new Error("channels.slack.appToken is required (Socket Mode app-level token)");
    }
    this.app = new App({
      token: opts.config.token,
      appToken: opts.config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    this.app.message(async ({ message, client }) => {
      // The message event has many subtypes — keep it simple: respond only
      // to plain user messages and direct messages from users.
      if (message.subtype && message.subtype !== "bot_message" && message.subtype !== undefined) return;
      // `files` without `text` used to be dropped here, so an image posted
      // with no caption never reached the agent at all — not as an empty
      // message, not as anything. That is the bug this whole feature exists to
      // stop, so the guard now admits a message that carries only files.
      if (!("user" in message) || !message.user) return;
      const files = "files" in message ? ((message.files as SlackFile[] | undefined) ?? []) : [];
      if ((!("text" in message) || !message.text) && files.length === 0) return;
      const user = message.user;
      const text = "text" in message && message.text ? message.text : "";
      const channelId = message.channel;
      const isDM = message.channel_type === "im";

      // Resolve bot user id lazily so we can detect mentions of ourselves.
      if (!this.botUserId) {
        const auth = await client.auth.test();
        this.botUserId = auth.user_id;
      }

      // Skip our own messages — never loop.
      if (user === this.botUserId) return;

      // Workspace allowlist
      if (this.config.allowedTeams?.length) {
        const team = "team" in message ? (message as { team?: string }).team : undefined;
        if (team && !this.config.allowedTeams.includes(team)) return;
      }

      const isMention = text.includes(`<@${this.botUserId}>`);
      if (isDM) {
        if (this.config.respondToDMs === false) return;
      } else if (this.config.respondToMentions === false || !isMention) {
        return;
      }

      // Strip the bot mention so the prompt is clean.
      const content = text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
      if (!content && files.length === 0) return;
      const media = await this.storeFiles(files);

      const projectCtx = this.resolveProject(channelId, isDM);
      const userKey = this.runtime.makeSessionKey({ channelId: "slack", userId: user, project: projectCtx });
      if (this.processing.has(userKey)) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: message.ts,
          text: "I'm still working on your previous message, hold on...",
        });
        return;
      }
      this.processing.add(userKey);
      const source = isDM ? "DM" : channelId;
      console.log(`[slack] ${user} (${source}): "${content.slice(0, 80)}"`);

      try {
        const response = await this.runAgent(userKey, content, projectCtx, media);
        if (!response) return;
        const chunks = splitMessage(response);
        for (const chunk of chunks) {
          await client.chat.postMessage({
            channel: channelId,
            thread_ts: isDM ? undefined : message.ts,
            text: chunk,
          });
        }
        console.log(`[slack] Replied to ${user}: "${response.slice(0, 80)}"`);
      } catch (err) {
        console.error(`[slack] Error handling message from ${user}:`, (err as Error).message);
        await client.chat
          .postMessage({
            channel: channelId,
            thread_ts: isDM ? undefined : message.ts,
            text: "Sorry, I hit an error processing your message.",
          })
          .catch(() => {});
      } finally {
        this.processing.delete(userKey);
      }
    });

    await this.app.start();
    console.log("[slack] Connected (Socket Mode)");
  }

  async disconnect(): Promise<void> {
    await this.app.stop();
    console.log("[slack] Disconnected");
  }

  async send(target: string, content: string): Promise<void> {
    for (const chunk of splitMessage(content)) {
      await this.app.client.chat.postMessage({ channel: target, text: chunk });
    }
  }

  async sendDM(userId: string, content: string): Promise<void> {
    const im = await this.app.client.conversations.open({ users: userId });
    const channel = im.channel?.id;
    if (!channel) throw new Error(`Could not open IM with user ${userId}`);
    await this.send(channel, content);
  }

  private resolveProject(channelId: string, isDM: boolean): ProjectRef | null {
    const mappings = this.config.projectMappings;
    if (!mappings?.length) return null;
    let mapped: string | null = null;
    for (const m of mappings) {
      if ("channel" in m && m.channel === channelId) {
        mapped = m.project;
        break;
      }
      if ("dm" in m && m.dm === true && isDM) {
        mapped = m.project;
        break;
      }
    }
    if (!mapped) return null;
    const ref = this.runtime.getProjectByName(mapped);
    if (!ref) {
      console.warn(`[slack] projectMappings names "${mapped}" but it is unknown or has no path — using global`);
      return null;
    }
    return ref;
  }

  /**
   * Download Slack files into the media store.
   *
   * `url_private` needs the bot token — an unauthenticated fetch gets Slack's
   * sign-in HTML with a 200, which would sail past a naive `res.ok` check and
   * store a login page as the user's screenshot. Hence the explicit
   * Authorization header and the content-type check.
   */
  private async storeFiles(files: SlackFile[]): Promise<MediaRef[]> {
    const store = this.runtime.getMediaStore();
    if (!store || files.length === 0) return [];
    const refs: MediaRef[] = [];
    for (const file of files) {
      if (!file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.config.token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (res.headers.get("content-type")?.includes("text/html")) {
          throw new Error("got HTML — the download was not authorized");
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        refs.push(await store.put(bytes, { mimeType: file.mimetype, name: file.name }));
      } catch (err) {
        console.warn(`[slack] could not store file ${file.name ?? "(unnamed)"}: ${(err as Error).message}`);
      }
    }
    return refs;
  }

  private async runAgent(
    userKey: string,
    content: string,
    project: ProjectRef | null,
    media: MediaRef[] = [],
  ): Promise<string | undefined> {
    // A Slack message is a person talking, so only `scope: all` stops it. The
    // reply says so rather than going quiet — an agent that silently ignores
    // you reads as broken, not paused.
    if (this.runtime.isAgentsPaused("human")) {
      const state = this.runtime.getPauseState();
      return `Agents are paused (scope: ${state.pause_scope ?? "all"})${state.paused_at ? ` since ${state.paused_at}` : ""}, so nothing ran.`;
    }

    const session = this.runtime.findOrCreateSession({ key: userKey, project });
    const hooks = this.runtime.resolveHooks({});
    const logPrefix = `[slack] [${userKey}]`;

    if (hooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(hooks.beforeRun, this.runtime.getTools(), {}, session.id, logPrefix);
      if (skipped) return undefined;
    }

    const loopOpts = this.runtime.buildLoopOptions({ session, project });
    const response = await runAgentLoop(media.length ? { text: content, media } : content, {
      ...loopOpts,
      ...this.runtime.defaultLoopObservers({ prefix: logPrefix }),
    });

    if (hooks.afterRun.length > 0) {
      await executeHooks(hooks.afterRun, this.runtime.getTools(), { response: response ?? "" }, session.id, logPrefix);
    }
    return response;
  }
}

export { splitMessage as _splitMessageForTests };
