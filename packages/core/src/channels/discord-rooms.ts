/**
 * Discord as a room backend.
 *
 * A "room" here is a guild text channel: the bot posts into it as one account
 * for every agent, so who is speaking rides in the message text as an envelope
 * (see `rooms/envelope.ts`) rather than in the transport author.
 *
 * This class is deliberately separate from {@link DiscordChannel}. The channel
 * owns the DM/mention conversation loop; this owns the multi-party surface, and
 * only needs a logged-in `Client` to work. Both share one gateway connection.
 */

import {
  ChannelType,
  type Client,
  type Message as DiscordMessage,
  Events,
  type Guild,
  OverwriteType,
  PermissionFlagsBits,
  type TextChannel,
  WebhookClient,
} from "discord.js";
import { formatEnvelope, parseEnvelope } from "../rooms/envelope.js";
import type { RoomStore } from "../rooms/store.js";
import type {
  CreateRoomOptions,
  OutboundRoomMessage,
  Room,
  RoomBackend,
  RoomCapabilities,
  RoomMember,
  RoomMessage,
} from "../rooms/types.js";
import { formatRoomRef } from "../rooms/types.js";

const MAX_MESSAGE_LENGTH = 2000;

/** Discord clamps `messages.fetch` at 100 regardless of what you ask for. */
const MAX_FETCH_LIMIT = 100;

/**
 * Snowflakes are monotonically increasing integers, but their DECIMAL STRING
 * form is not fixed width — it grew from 17 to 18 to 19 digits as Discord
 * aged. `RoomStore` compares cursors with `<` in SQL, i.e. lexicographically,
 * where "950..." (18 digits) sorts after "1046..." (19 digits) and an agent
 * would silently stop advancing. Left-padding to the width of u64 max
 * (18446744073709551615 — 20 digits) makes string order match numeric order
 * for every snowflake Discord can ever mint.
 */
const SNOWFLAKE_WIDTH = 20;

/** Name the webhook carries in channel settings, so it is recognisable later. */
const WEBHOOK_NAME = "TAI rooms";

/**
 * Discord rejects a webhook display name containing "discord" or "clyde", and
 * caps it at 80 characters. Fall back to the bot's own name when a label is
 * unusable rather than failing the send — a message under the wrong name still
 * beats a message that never arrives.
 */
function webhookUsername(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const cleaned = label.trim().slice(0, 80);
  if (!cleaned) return undefined;
  return /discord|clyde/i.test(cleaned) ? cleaned.replace(/discord|clyde/gi, "-") : cleaned;
}

function padSnowflake(id: string): string {
  return id.padStart(SNOWFLAKE_WIDTH, "0");
}

function unpadSnowflake(cursor: string): string {
  return cursor.replace(/^0+/, "") || "0";
}

/**
 * Discord rejects messages over 2000 characters. `splitMessage` in discord.ts
 * is module-private, so this is the same rule kept local: break on a newline,
 * fall back to a space, hard-cut only when neither lands in the back half.
 */
function splitForDiscord(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

export interface DiscordRoomBackendOptions {
  /** Guild to create rooms in. Required only when the bot is in several. */
  guildId?: string;
  /** Mirror of `channels.discord.allowedGuilds` — applied to inbound traffic. */
  allowedGuilds?: string[];
  /**
   * Where webhook credentials are remembered, and how our own webhook posts are
   * told apart from a foreign one on the way back in. Without a store the
   * backend falls back to text-prefix identity.
   */
  store?: RoomStore;
  /** Avatar to post an identity under, when one is configured. */
  avatarFor?: (label: string) => string | undefined;
  /**
   * Discord account id behind an identity label, when it has one. Humans do;
   * agents post through a webhook and have no account, so they never will.
   * Used to turn "@quinton" into a real mention that actually notifies.
   */
  nativeIdFor?: (label: string) => string | undefined;
  /** Inverse of {@link DiscordRoomBackendOptions.nativeIdFor}, for inbound mentions. */
  labelForNativeId?: (nativeId: string) => string | undefined;
  /**
   * Known identity labels, so `[note] ...` in a human's message stays body text
   * instead of inventing a speaker. Wire this to `IdentityResolver.isKnown`.
   */
  isKnownIdentity?: (label: string) => boolean;
}

export class DiscordRoomBackend implements RoomBackend {
  readonly id = "discord";
  readonly capabilities: RoomCapabilities = {
    create: true,
    members: true,
    push: true,
    history: true,
    // Set once a webhook exists for the room; see ensureWebhook.
    nativeSpeakers: true,
    threads: true,
  };

  private readonly webhooks = new Map<string, WebhookClient>();

  constructor(
    private readonly client: Client,
    private readonly opts: DiscordRoomBackendOptions = {},
  ) {}

  async listRooms(): Promise<Room[]> {
    const rooms: Room[] = [];
    for (const guild of this.scopedGuilds()) {
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText) continue;
        rooms.push(this.toRoom(channel));
      }
    }
    return rooms;
  }

  async getRoom(id: string): Promise<Room | null> {
    const channel = await this.client.channels.fetch(id).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildText) return null;
    return this.toRoom(channel);
  }

  async createRoom(opts: CreateRoomOptions): Promise<Room> {
    const guild = this.requireGuild();
    const channel = await guild.channels.create({
      name: opts.name,
      type: ChannelType.GuildText,
      topic: opts.purpose,
    });

    // Seeding is best-effort: one bad id should not discard a created room the
    // caller is about to be told about.
    for (const memberId of opts.members ?? []) {
      try {
        await this.addMember(channel.id, memberId);
      } catch (err) {
        console.warn(`[discord:rooms] Could not add "${memberId}" to #${channel.name}: ${(err as Error).message}`);
      }
    }

    return { ...this.toRoom(channel), createdBy: opts.createdBy };
  }

  /**
   * Membership derived from channel permission overwrites, NOT from the guild
   * member list: listing members needs the privileged GuildMembers intent,
   * which has to be toggled on in the Discord developer portal and reviewed
   * once a bot is in 100 guilds. Overwrites need no privileged intent and
   * answer the question that actually matters for a private room — who was
   * explicitly granted access.
   *
   * The tradeoff: a PUBLIC channel has no member overwrites at all, so this
   * returns an empty list. That is "unknown", not "nobody"; callers must not
   * read it as an authoritative roster.
   */
  async listMembers(id: string): Promise<RoomMember[]> {
    const channel = await this.requireTextChannel(id);

    const members: RoomMember[] = [];
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== OverwriteType.Member) continue;
      if (!overwrite.allow.has(PermissionFlagsBits.ViewChannel)) continue;

      // Non-privileged: fetching a single user by id is always allowed.
      const user = await this.client.users.fetch(overwrite.id).catch(() => null);
      members.push({
        id: overwrite.id,
        label: user?.username ?? overwrite.id,
        kind: user ? (user.bot ? "agent" : "human") : "unknown",
      });
    }
    return members;
  }

  /**
   * Discord caps a channel topic at 1024 characters, and a room purpose is
   * really a prompt — it can be longer. Truncate what people see; agents still
   * get the whole thing from the database.
   */
  async setPurpose(id: string, purpose: string): Promise<void> {
    const channel = await this.requireTextChannel(id);
    const trimmed = purpose.trim();
    await channel.setTopic(trimmed.length > 1024 ? `${trimmed.slice(0, 1021)}...` : trimmed);
  }

  async addMember(id: string, memberId: string): Promise<void> {
    if (!/^\d+$/.test(memberId)) {
      throw new Error(`Discord grants room access by user id; "${memberId}" is not a snowflake.`);
    }
    const channel = await this.requireTextChannel(id);
    await channel.permissionOverwrites.edit(memberId, { ViewChannel: true, SendMessages: true });
  }

  /**
   * A webhook lets every agent appear as its own participant, with its own name
   * and picture, instead of one bot account prefixing "[planner]" onto the
   * text. One webhook per channel is enough — the display name is a per-message
   * override, not a property of the webhook.
   *
   * Returns null when we cannot have one (no store to remember it in, or the
   * bot lacks Manage Webhooks), and the caller falls back to text prefixes.
   */
  private async ensureWebhook(channelId: string): Promise<WebhookClient | null> {
    const store = this.opts.store;
    if (!store) return null;

    const ref = formatRoomRef({ backend: this.id, id: channelId });
    const cached = this.webhooks.get(channelId);
    if (cached) return cached;

    const saved = store.getWebhook(ref);
    if (saved) {
      const client = new WebhookClient({ id: saved.id, token: saved.token });
      this.webhooks.set(channelId, client);
      return client;
    }

    try {
      const channel = await this.requireTextChannel(channelId);
      // Reuse one we made earlier before creating another — a restart that lost
      // the row should not leave a trail of webhooks on the channel.
      const existing = await channel.fetchWebhooks();
      const mine = existing.find((w) => w.owner?.id === this.client.user?.id && w.token);
      const hook = mine ?? (await channel.createWebhook({ name: WEBHOOK_NAME }));
      if (!hook.token) return null;

      store.setWebhook(ref, { id: hook.id, token: hook.token });
      const client = new WebhookClient({ id: hook.id, token: hook.token });
      this.webhooks.set(channelId, client);
      console.log(`[discord:rooms] Speaking as individual participants in #${channel.name} via webhook.`);
      return client;
    } catch (err) {
      console.warn(
        `[discord:rooms] Could not set up a webhook for ${channelId} (${(err as Error).message}) — falling back to "[speaker]" text prefixes. Grant Manage Webhooks to give each agent its own name.`,
      );
      return null;
    }
  }

  /**
   * Write an addressee the way Discord will act on it.
   *
   * A human with an account becomes `<@id>`, which highlights and notifies
   * them. An agent has no account — it speaks through a webhook — so it stays
   * plain `@label`, which is exactly right: agents are woken by the room
   * watcher, not by Discord.
   */
  private renderAddressee(label: string): string {
    const nativeId = this.opts.nativeIdFor?.(label);
    return nativeId ? `<@${nativeId}>` : `@${label}`;
  }

  /**
   * The account ids a message deliberately addresses. Passed as the mention
   * allowlist so those pings land while `@everyone` in a body stays inert.
   */
  private mentionedIds(to: string[] | undefined): string[] {
    const ids: string[] = [];
    for (const label of to ?? []) {
      const nativeId = this.opts.nativeIdFor?.(label);
      if (nativeId && !ids.includes(nativeId)) ids.push(nativeId);
    }
    return ids;
  }

  async removeMember(id: string, memberId: string): Promise<void> {
    if (!/^\d+$/.test(memberId)) {
      throw new Error(`Discord grants room access by user id; "${memberId}" is not a snowflake.`);
    }
    const channel = await this.requireTextChannel(id);
    await channel.permissionOverwrites.delete(memberId);
  }

  async post(id: string, message: OutboundRoomMessage): Promise<RoomMessage | null> {
    const webhook = await this.ensureWebhook(id);
    if (webhook) return await this.postAsParticipant(webhook, id, message);
    return await this.postWithPrefix(id, message);
  }

  /**
   * Post under the speaker's own name. The addressee still rides in the text —
   * agents are not Discord users, so there is nothing to @-mention — but the
   * speaker half of the envelope is gone: Discord shows it.
   */
  /**
   * The thread to post into when a message names a parent.
   *
   * Discord nests by opening a thread ON the parent message, so the parent has
   * to exist and be in this channel. A parent we cannot resolve is not an
   * error worth failing the post over — the message still belongs in the room,
   * just not nested — so this returns undefined and the caller posts flat.
   */
  private async threadFor(channelId: string, parentId: string): Promise<string | undefined> {
    try {
      const channel = await this.requireTextChannel(channelId);
      const parent = await channel.messages.fetch(parentId);
      const existing = parent.thread;
      if (existing) return existing.id;
      const thread = await parent.startThread({ name: "details", autoArchiveDuration: 1440 });
      return thread.id;
    } catch (err) {
      console.warn(`[discord:rooms] Could not nest under ${parentId}: ${(err as Error).message}`);
      return undefined;
    }
  }

  private async postAsParticipant(
    webhook: WebhookClient,
    id: string,
    message: OutboundRoomMessage,
  ): Promise<RoomMessage | null> {
    // No speaker prefix: the webhook display name carries that. Going through
    // formatEnvelope keeps the addressee rendering and the body escaping in
    // one place rather than hand-rolling the wire format twice.
    const text = formatEnvelope({
      to: message.to,
      body: message.body,
      renderAddressee: (l) => this.renderAddressee(l),
    });
    const users = this.mentionedIds(message.to);

    const threadId = message.parentId ? await this.threadFor(id, message.parentId) : undefined;

    let last: DiscordMessage | null = null;
    for (const chunk of splitForDiscord(text)) {
      if (!chunk) continue;
      last = (await webhook.send({
        content: chunk,
        username: webhookUsername(message.speaker),
        avatarURL: message.speaker ? this.opts.avatarFor?.(message.speaker) : undefined,
        ...(threadId ? { threadId } : {}),
        // parse: [] keeps @everyone/@here and stray text inert; `users` is the
        // explicit allowlist of people this message actually addressed.
        allowedMentions: { parse: [], users },
      })) as unknown as DiscordMessage;
    }
    if (!last) return null;

    return {
      id: last.id,
      room: { backend: this.id, id },
      cursor: padSnowflake(last.id),
      raw: text,
      body: message.body.trim(),
      speaker: message.speaker,
      to: message.to ?? [],
      mentions: [],
      authorId: last.author?.id ?? "",
      authorLabel: message.speaker ?? "",
      fromSelf: true,
      createdAt: new Date(last.createdTimestamp ?? Date.now()).toISOString(),
    };
  }

  private async postWithPrefix(id: string, message: OutboundRoomMessage): Promise<RoomMessage | null> {
    const channel = await this.requireTextChannel(id);
    const wire = formatEnvelope({ speaker: message.speaker, to: message.to, body: message.body });

    // Split the BODY, then stamp every chunk with the speaker. Splitting the
    // finished wire string instead would leave chunks 2..N with no envelope at
    // all, and an envelope-less message reads as an unattributed human turn —
    // so one long agent post woke every agent in the room, including its own
    // author. Addressees ride only the first chunk, so a two-part message
    // doesn't ping the recipient twice.
    const envelopeOverhead = wire.length - message.body.trim().length;
    const bodyBudget = MAX_MESSAGE_LENGTH - envelopeOverhead - 8;
    const parts = splitForDiscord(message.body.trim(), Math.max(bodyBudget, 200));

    let last: DiscordMessage | null = null;
    for (const [i, part] of parts.entries()) {
      if (!part) continue;
      last = await channel.send({
        content: formatEnvelope({
          speaker: message.speaker,
          to: i === 0 ? message.to : [],
          body: part,
          renderAddressee: (l) => this.renderAddressee(l),
        }),
        // parse: [] keeps @everyone/@here inert — unlike every other Discord
        // mention form they are live in raw content and take no brackets —
        // while `users` lets through exactly who we addressed.
        allowedMentions: { parse: [], users: i === 0 ? this.mentionedIds(message.to) : [] },
      });
    }
    if (!last) return null;

    // Identity comes from the last chunk, because its id is the newest and
    // callers store that cursor. Everything else is taken from what we were
    // asked to say: the envelope only rides on the FIRST chunk, so re-parsing
    // a tail would report a message with no speaker and a truncated body.
    return {
      ...this.toRoomMessage(last),
      raw: wire,
      speaker: message.speaker,
      to: message.to ?? [],
      body: message.body.trim(),
    };
  }

  async fetchSince(id: string, cursor: string | null, limit: number): Promise<RoomMessage[]> {
    const channel = await this.requireTextChannel(id);
    const capped = Math.max(1, Math.min(limit, MAX_FETCH_LIMIT));
    const batch = cursor
      ? await channel.messages.fetch({ after: unpadSnowflake(cursor), limit: capped })
      : await channel.messages.fetch({ limit: capped });

    // Discord answers newest-first; the seam contract is oldest-first.
    //
    // The SAME admission rules as the live path, and that is the whole point:
    // filtering only on arrival meant a rejected message sat in the channel and
    // was read straight back in by the next startup backlog scan. A foreign
    // webhook could be blocked in real time and still reach an agent minutes
    // later, which is not a guard at all.
    return [...batch.values()]
      .reverse()
      .filter((msg) => this.admits(msg))
      .map((msg) => this.toRoomMessage(msg));
  }

  /**
   * Whether a Discord message is allowed to reach the room at all.
   *
   * Mirrors what DiscordChannel.shouldRespond enforces for DMs and mentions.
   * Registering a room makes that path stand down for the channel, so these
   * checks have to live here — and on every route in, not just the live one.
   */
  private admits(msg: DiscordMessage): boolean {
    if (msg.channel.type !== ChannelType.GuildText) return false;
    if (this.opts.guildId && msg.guildId !== this.opts.guildId) return false;
    // Our own webhook is how agents speak, so it must come through — but only
    // ours. Matching the stored id rather than "is this a webhook" is the
    // guard: anyone else's webhook can post `username: "planner"` too.
    if (msg.webhookId && !this.isOwnWebhook(msg.webhookId)) return false;
    if (!msg.webhookId && msg.author.bot && msg.author.id !== this.client.user?.id) return false;
    const allowed = this.opts.allowedGuilds;
    if (allowed?.length && (!msg.guildId || !allowed.includes(msg.guildId))) return false;
    return true;
  }

  onMessage(handler: (message: RoomMessage) => void): () => void {
    const listener = (msg: DiscordMessage) => {
      if (!this.admits(msg)) return;
      try {
        handler(this.toRoomMessage(msg));
      } catch (err) {
        // A throwing subscriber must not take down the gateway listener.
        console.error(`[discord:rooms] Subscriber error: ${(err as Error).message}`);
      }
    };

    this.client.on(Events.MessageCreate, listener);
    return () => {
      this.client.off(Events.MessageCreate, listener);
    };
  }

  // ---------------------------------------------------------------- internals

  private toRoom(channel: TextChannel): Room {
    return {
      ref: { backend: this.id, id: channel.id },
      name: channel.name,
      purpose: channel.topic ?? undefined,
    };
  }

  private isOwnWebhook(webhookId: string): boolean {
    return this.opts.store?.knownWebhookIds().has(webhookId) ?? false;
  }

  /**
   * Turn Discord account mentions back into identity labels before parsing.
   *
   * We emit `<@107…>` so a human is really notified, and the shared parser
   * deliberately refuses to read `<@…>` as an addressee — it is Discord's
   * reserved syntax. Without this rewrite the addressee would be lost on the
   * way back in, and the round trip would silently drop who a message was for.
   *
   * It also picks up mentions a person typed in the Discord client, which are
   * sent in exactly this form.
   */
  private resolveMentions(content: string): string {
    const resolve = this.opts.labelForNativeId;
    if (!resolve) return content;
    return content.replace(/<@!?(\d+)>/g, (whole, id: string) => {
      const label = resolve(id);
      return label ? `@${label}` : whole;
    });
  }

  private toRoomMessage(msg: DiscordMessage): RoomMessage {
    const content = this.resolveMentions(msg.content);
    const parsed = parseEnvelope(content, this.opts.isKnownIdentity);
    const ownWebhook = msg.webhookId ? this.isOwnWebhook(msg.webhookId) : false;

    // On our own webhook the display name IS the speaker — that is the point of
    // posting through one — so it beats anything parsed out of the text.
    const speaker = ownWebhook ? msg.author.username : parsed.speaker;

    return {
      id: msg.id,
      room: { backend: this.id, id: msg.channelId },
      cursor: padSnowflake(msg.id),
      // The mention-resolved form, so a reader sees "@quinton" rather than a
      // bare snowflake it cannot interpret.
      raw: content,
      body: parsed.body,
      speaker,
      to: parsed.to,
      mentions: [],
      authorId: msg.author.id,
      authorLabel: msg.author.username,
      // Our webhook posts carry the webhook's author id, not the bot's, so
      // without this an agent would not recognise its own words coming back.
      fromSelf: ownWebhook || msg.author.id === this.client.user?.id,
      createdAt: new Date(msg.createdTimestamp).toISOString(),
    };
  }

  /** Guilds this backend is allowed to look at. Empty when the id is unknown. */
  private scopedGuilds(): Guild[] {
    const cache = this.client.guilds.cache;
    if (!this.opts.guildId) return [...cache.values()];
    const guild = cache.get(this.opts.guildId);
    return guild ? [guild] : [];
  }

  /** The single guild new rooms are created in. */
  private requireGuild(): Guild {
    const cache = this.client.guilds.cache;
    if (this.opts.guildId) {
      const guild = cache.get(this.opts.guildId);
      if (guild) return guild;
      throw new Error(`Discord guild ${this.opts.guildId} is not visible to this bot — check the invite.`);
    }
    if (cache.size === 1) return cache.first()!;
    if (cache.size === 0) throw new Error("This bot is not in any Discord guild, so there is nowhere to open a room.");

    const candidates = [...cache.values()].map((g) => `${g.name} (${g.id})`).join(", ");
    throw new Error(
      `This bot is in ${cache.size} guilds, so the target is ambiguous. ` +
        `Set channels.discord.guildId to one of: ${candidates}.`,
    );
  }

  private async requireTextChannel(id: string): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(id).catch(() => null);
    if (!channel) {
      throw new Error(`Discord channel ${id} not found — check the room ref and that the bot can see the channel.`);
    }
    if (channel.type !== ChannelType.GuildText) {
      throw new Error(`Discord channel ${id} is a ${ChannelType[channel.type]}; rooms need a guild text channel.`);
    }
    return channel;
  }
}
