import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message as DiscordMessage,
} from 'discord.js';
import type { AgentRuntime } from '../runtime.js';
import { findOrCreateSession } from '../agent/session.js';
import { runAgentLoop } from '../agent/loop.js';
import type { Channel, IncomingMessage } from './interface.js';

const MAX_MESSAGE_LENGTH = 2000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good newline, split at space
      splitAt = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good space either, hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export interface DiscordChannelOptions {
  runtime: AgentRuntime;
}

export class DiscordChannel implements Channel {
  id = 'discord';
  type = 'discord';

  private client: Client;
  private runtime: AgentRuntime;
  private messageHandler?: (msg: IncomingMessage) => void;
  private processing = new Set<string>();

  constructor(opts: DiscordChannelOptions) {
    this.runtime = opts.runtime;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async connect(): Promise<void> {
    const token = this.runtime.getConfig().channels.discord?.token;
    if (!token) {
      throw new Error('Discord token not configured');
    }

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    await this.client.login(token);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
    console.log('[discord] Disconnected');
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  async send(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('send' in channel)) return;

    for (const chunk of splitMessage(content)) {
      await channel.send(chunk);
    }
  }

  private shouldRespond(msg: DiscordMessage): boolean {
    // Never respond to ourselves
    if (msg.author.id === this.client.user?.id) return false;
    // Never respond to other bots
    if (msg.author.bot) return false;

    const discordConfig = this.runtime.getConfig().channels.discord;
    if (!discordConfig) return false;

    // DMs
    if (!msg.guild) {
      return discordConfig.respondToDMs !== false;
    }

    // Guild messages: check guild allowlist
    if (discordConfig.allowedGuilds?.length) {
      if (!discordConfig.allowedGuilds.includes(msg.guild.id)) return false;
    }

    // Only respond to @mentions in guilds
    if (discordConfig.respondToMentions !== false) {
      return msg.mentions.has(this.client.user!);
    }

    return false;
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    if (!this.shouldRespond(msg)) return;

    // Strip the bot mention from the content
    const content = msg.content
      .replace(new RegExp(`<@!?${this.client.user!.id}>`, 'g'), '')
      .trim();

    if (!content) return;

    // Emit to handler if registered
    if (this.messageHandler) {
      this.messageHandler({
        id: msg.id,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorName: msg.author.displayName ?? msg.author.username,
        content,
        isDM: !msg.guild,
        isMention: msg.mentions.has(this.client.user!),
      });
    }

    // Deduplicate: don't process if we're already handling a message from this user
    const userKey = `discord:${msg.author.id}`;
    if (this.processing.has(userKey)) {
      await msg.reply('I\'m still working on your previous message, hold on...');
      return;
    }

    this.processing.add(userKey);
    const source = msg.guild ? `#${(msg.channel as { name?: string }).name ?? msg.channelId}` : 'DM';
    console.log(`[discord] ${msg.author.username} (${source}): "${content.slice(0, 80)}"`);

    try {
      // Show typing while we process
      const canType = 'sendTyping' in msg.channel;
      if (canType) {
        await (msg.channel as { sendTyping: () => Promise<void> }).sendTyping();
      }
      const typingInterval = canType
        ? setInterval(() => {
            (msg.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
          }, 8_000)
        : undefined;

      const config = this.runtime.getConfig();
      const model = this.runtime.getModel();

      const session = findOrCreateSession(
        this.runtime.db,
        userKey,
        model,
        config.agent.defaultProvider
      );

      const response = await runAgentLoop(content, {
        provider: this.runtime.getProvider(),
        session,
        db: this.runtime.db,
        tools: this.runtime.getTools(),
        extraInstructions: config.agent.extraInstructions,
        maxToolRounds: config.agent.maxToolRounds,
        maxHistoryTokens: config.agent.maxHistoryTokens,
        temperature: config.agent.temperature,
        contextDir: this.runtime.contextDir,
        getTools: () => this.runtime.getTools(),
        getProvider: () => this.runtime.getProvider(),
        onToolCall: (name, args) => {
          console.log(`[discord] [${msg.author.username}] tool: ${name}(${JSON.stringify(args)})`);
        },
      });

      if (typingInterval) clearInterval(typingInterval);

      if (!response) return;

      const chunks = splitMessage(response);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await msg.reply(chunks[i]);
        } else {
          await this.send(msg.channelId, chunks[i]);
        }
      }
      console.log(`[discord] Replied to ${msg.author.username}: "${response.slice(0, 80)}"`);
    } catch (err) {
      console.error(`[discord] Error handling message from ${msg.author.username}:`, err);
      await msg.reply('Sorry, I encountered an error processing your message.').catch(() => {});
    } finally {
      this.processing.delete(userKey);
    }
  }
}
