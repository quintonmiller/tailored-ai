import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  type Message as DiscordMessage,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { createHash } from 'node:crypto';
import type { AgentRuntime } from '../runtime.js';
import { findOrCreateSession, resetSession } from '../agent/session.js';
import { resolveProfile } from '../agent/profiles.js';
import { runAgentLoop } from '../agent/loop.js';
import { isCommand, executeCommand } from '../commands.js';
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
  private userProfiles = new Map<string, string>();
  private registeredCommandsHash = '';

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
      this.syncCommands().catch((err) => {
        console.error('[discord] Failed to sync application commands:', (err as Error).message);
      });
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      this.handleInteraction(interaction).catch((err) => {
        console.error('[discord] Interaction handler error:', (err as Error).message);
      });
    });

    this.runtime.onReload(() => {
      this.syncCommands().catch((err) => {
        console.error('[discord] Failed to sync commands on reload:', (err as Error).message);
      });
    });

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

  async sendDM(userId: string, content: string): Promise<void> {
    const user = await this.client.users.fetch(userId);
    for (const chunk of splitMessage(content)) {
      await user.send(chunk);
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

    // Handle slash commands
    if (isCommand(content)) {
      const config = this.runtime.getConfig();
      const result = await executeCommand(content, {
        config,
        currentProfile: this.userProfiles.get(msg.author.id),
      });

      switch (result.type) {
        case 'new_session': {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await msg.reply('Started a new session.');
          this.processing.delete(userKey);
          return;
        }
        case 'switch_profile': {
          this.userProfiles.set(msg.author.id, result.profile);
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await msg.reply(`Switched to profile **${result.profile}**. Started a new session.`);
          this.processing.delete(userKey);
          return;
        }
        case 'help': {
          await msg.reply(result.text);
          this.processing.delete(userKey);
          return;
        }
        case 'shell_output': {
          const output = result.output.slice(0, MAX_MESSAGE_LENGTH - 10);
          await msg.reply(`\`\`\`\n${output}\n\`\`\``);
          this.processing.delete(userKey);
          return;
        }
        case 'error': {
          await msg.reply(result.message);
          this.processing.delete(userKey);
          return;
        }
        case 'unknown_command': {
          await msg.reply(`Unknown command "/${result.name}". Type /help for available commands.`);
          this.processing.delete(userKey);
          return;
        }
        case 'agent_prompt':
        case 'shell_then_prompt': {
          // Fall through to agent loop below with the transformed prompt
          break;
        }
        default: {
          this.processing.delete(userKey);
          return;
        }
      }

      // agent_prompt / shell_then_prompt — send through the agent loop
      try {
        const agentResult = result as { type: 'agent_prompt' | 'shell_then_prompt'; prompt: string; profile?: string; newSession?: boolean };
        const profileName = agentResult.profile ?? this.userProfiles.get(msg.author.id);

        if (agentResult.newSession) {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
        }

        await this.runAgentAndReply(msg, userKey, agentResult.prompt, profileName);
      } catch (err) {
        console.error(`[discord] Error handling command from ${msg.author.username}:`, err);
        await msg.reply('Sorry, I encountered an error processing your command.').catch(() => {});
      } finally {
        this.processing.delete(userKey);
      }
      return;
    }

    // Regular message — send through agent loop
    try {
      const profileName = this.userProfiles.get(msg.author.id);
      await this.runAgentAndReply(msg, userKey, content, profileName);
    } catch (err) {
      console.error(`[discord] Error handling message from ${msg.author.username}:`, err);
      await msg.reply('Sorry, I encountered an error processing your message.').catch(() => {});
    } finally {
      this.processing.delete(userKey);
    }
  }

  private async runAgentAndReply(
    msg: DiscordMessage,
    userKey: string,
    content: string,
    profileName?: string,
  ): Promise<void> {
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

    // Resolve profile if active
    const resolved = profileName
      ? resolveProfile(profileName, config, this.runtime.getTools(), undefined, this.runtime.contextDir)
      : undefined;

    const response = await runAgentLoop(content, {
      provider: this.runtime.getProvider(),
      session,
      db: this.runtime.db,
      tools: resolved?.tools ?? this.runtime.getTools(),
      extraInstructions: resolved?.instructions ?? config.agent.extraInstructions,
      maxToolRounds: resolved?.maxToolRounds ?? config.agent.maxToolRounds,
      maxHistoryTokens: config.agent.maxHistoryTokens,
      temperature: resolved?.temperature ?? config.agent.temperature,
      contextDir: this.runtime.contextDir,
      profileContextDir: resolved?.contextDir,
      getTools: () => {
        if (profileName) {
          const r = resolveProfile(profileName, this.runtime.getConfig(), this.runtime.getTools(), undefined, this.runtime.contextDir);
          return r.tools;
        }
        return this.runtime.getTools();
      },
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
  }

  private buildSlashCommands(): SlashCommandBuilder[] {
    const config = this.runtime.getConfig();
    const commands: SlashCommandBuilder[] = [];

    // /new
    commands.push(
      new SlashCommandBuilder()
        .setName('new')
        .setDescription('Start a new session') as SlashCommandBuilder,
    );

    // /agent — with profile choices
    const profileNames = Object.keys(config.profiles);
    if (profileNames.length > 0) {
      const agentCmd = new SlashCommandBuilder()
        .setName('agent')
        .setDescription('Switch agent profile');
      agentCmd.addStringOption((opt) =>
        opt
          .setName('profile')
          .setDescription('Profile name')
          .setRequired(true)
          .addChoices(...profileNames.slice(0, 25).map((p) => ({ name: p, value: p }))),
      );
      commands.push(agentCmd as SlashCommandBuilder);
    }

    // /help
    commands.push(
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('List available commands') as SlashCommandBuilder,
    );

    // Config-driven commands
    for (const [name, cmd] of Object.entries(config.commands)) {
      // Discord command names must be 1-32 chars, lowercase, no spaces
      const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
      if (!safeName) continue;

      const builder = new SlashCommandBuilder()
        .setName(safeName)
        .setDescription(cmd.description.slice(0, 100) || `Run /${safeName}`);

      // Add optional input option if the command/prompt uses {{input}}
      const usesInput =
        (cmd.command && cmd.command.includes('{{input}}')) ||
        (cmd.prompt && cmd.prompt.includes('{{input}}'));
      if (usesInput) {
        builder.addStringOption((opt) =>
          opt
            .setName('input')
            .setDescription('Input for the command')
            .setRequired(false),
        );
      }

      commands.push(builder as SlashCommandBuilder);
    }

    return commands;
  }

  private async syncCommands(): Promise<void> {
    const token = this.runtime.getConfig().channels.discord?.token;
    const clientId = this.client.user?.id;
    if (!token || !clientId) return;

    const commands = this.buildSlashCommands();
    const body = commands.map((c) => c.toJSON());
    const json = JSON.stringify(body);

    // Skip if nothing changed
    const hash = createHash('sha256').update(json).digest('hex');
    if (hash === this.registeredCommandsHash) return;

    const rest = new REST().setToken(token);
    // Clear all existing commands first, then register new ones
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    await rest.put(Routes.applicationCommands(clientId), { body });
    this.registeredCommandsHash = hash;
    console.log(`[discord] Synced ${commands.length} application command(s)`);
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const userKey = `discord:${userId}`;

    // Deduplicate
    if (this.processing.has(userKey)) {
      await interaction.reply({ content: "I'm still working on your previous message, hold on...", ephemeral: true });
      return;
    }

    this.processing.add(userKey);
    await interaction.deferReply();

    const username = interaction.user.username;
    console.log(`[discord] ${username} (slash): /${interaction.commandName}`);

    try {
      // Reconstruct text command string
      const inputOpt = interaction.options.getString('input') ?? '';
      const profileOpt = interaction.options.getString('profile') ?? '';
      const argStr = profileOpt || inputOpt;
      const textCommand = argStr ? `/${interaction.commandName} ${argStr}` : `/${interaction.commandName}`;

      const config = this.runtime.getConfig();
      const result = await executeCommand(textCommand, {
        config,
        currentProfile: this.userProfiles.get(userId),
      });

      switch (result.type) {
        case 'new_session': {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await interaction.editReply('Started a new session.');
          return;
        }
        case 'switch_profile': {
          this.userProfiles.set(userId, result.profile);
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await interaction.editReply(`Switched to profile **${result.profile}**. Started a new session.`);
          return;
        }
        case 'help': {
          await interaction.editReply(result.text);
          return;
        }
        case 'shell_output': {
          const output = result.output.slice(0, MAX_MESSAGE_LENGTH - 10);
          await interaction.editReply(`\`\`\`\n${output}\n\`\`\``);
          return;
        }
        case 'error': {
          await interaction.editReply(result.message);
          return;
        }
        case 'unknown_command': {
          await interaction.editReply(`Unknown command "/${result.name}". Type /help for available commands.`);
          return;
        }
        case 'agent_prompt':
        case 'shell_then_prompt': {
          const agentResult = result as { type: 'agent_prompt' | 'shell_then_prompt'; prompt: string; profile?: string; newSession?: boolean };
          const profileName = agentResult.profile ?? this.userProfiles.get(userId);

          if (agentResult.newSession) {
            const model = this.runtime.getModel();
            resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          }

          const response = await this.runAgentForInteraction(interaction, userKey, agentResult.prompt, profileName);
          if (response) {
            const chunks = splitMessage(response);
            await interaction.editReply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp(chunks[i]);
            }
            console.log(`[discord] Replied to ${username}: "${response.slice(0, 80)}"`);
          } else {
            await interaction.editReply('(No response)');
          }
          return;
        }
      }
    } catch (err) {
      console.error(`[discord] Error handling interaction from ${username}:`, err);
      await interaction.editReply('Sorry, I encountered an error processing your command.').catch(() => {});
    } finally {
      this.processing.delete(userKey);
    }
  }

  private async runAgentForInteraction(
    interaction: ChatInputCommandInteraction,
    userKey: string,
    content: string,
    profileName?: string,
  ): Promise<string | undefined> {
    const config = this.runtime.getConfig();
    const model = this.runtime.getModel();

    const session = findOrCreateSession(
      this.runtime.db,
      userKey,
      model,
      config.agent.defaultProvider,
    );

    const resolved = profileName
      ? resolveProfile(profileName, config, this.runtime.getTools(), undefined, this.runtime.contextDir)
      : undefined;

    return runAgentLoop(content, {
      provider: this.runtime.getProvider(),
      session,
      db: this.runtime.db,
      tools: resolved?.tools ?? this.runtime.getTools(),
      extraInstructions: resolved?.instructions ?? config.agent.extraInstructions,
      maxToolRounds: resolved?.maxToolRounds ?? config.agent.maxToolRounds,
      maxHistoryTokens: config.agent.maxHistoryTokens,
      temperature: resolved?.temperature ?? config.agent.temperature,
      contextDir: this.runtime.contextDir,
      profileContextDir: resolved?.contextDir,
      getTools: () => {
        if (profileName) {
          const r = resolveProfile(profileName, this.runtime.getConfig(), this.runtime.getTools(), undefined, this.runtime.contextDir);
          return r.tools;
        }
        return this.runtime.getTools();
      },
      getProvider: () => this.runtime.getProvider(),
      onToolCall: (name, args) => {
        console.log(`[discord] [${interaction.user.username}] tool: ${name}(${JSON.stringify(args)})`);
      },
    });
  }
}
