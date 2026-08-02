import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import {
  type SlashCommandDescriptor,
  type SlashCommandInvocation,
  type SlashCommandOption,
  slashCommandRegistry,
} from "../commands/registry.js";
import { splitMessage } from "./split-message.js";

/**
 * Adapts registered slash-command descriptors onto Discord.
 *
 * The registry is transport-neutral by design, so everything Discord-shaped
 * lives here: SlashCommandBuilder construction, option-type mapping,
 * ephemeral flags, the 2,000-character message limit, and the three-second
 * interaction deadline.
 */

/** Discord rejects more than 25 autocomplete choices. */
const MAX_CHOICES = 25;

/** Most messages one reply will send, matching `/memory`'s cap. */
const MAX_CHUNKS = 5;

function addOption(builder: SlashCommandBuilder, opt: SlashCommandOption): void {
  const common = <
    T extends { setName: (n: string) => T; setDescription: (d: string) => T; setRequired: (r: boolean) => T },
  >(
    o: T,
  ) =>
    o
      .setName(opt.name)
      .setDescription(opt.description.slice(0, 100))
      .setRequired(opt.required ?? false);

  switch (opt.type) {
    case "integer":
      builder.addIntegerOption((o) => common(o));
      break;
    case "number":
      builder.addNumberOption((o) => common(o));
      break;
    case "boolean":
      builder.addBooleanOption((o) => common(o));
      break;
    default: {
      builder.addStringOption((o) => {
        const s = common(o);
        // Discord rejects a command declaring both; choices are the stricter
        // of the two, so they win when a descriptor sets both by mistake.
        if (opt.choices?.length) {
          return s.addChoices(
            ...opt.choices.slice(0, MAX_CHOICES).map((c) => ({ name: c.name, value: String(c.value) })),
          );
        }
        if (opt.autocomplete) return s.setAutocomplete(true);
        return s;
      });
    }
  }
}

/** Build one Discord command per registered descriptor. */
export function buildPluginCommands(): SlashCommandBuilder[] {
  return slashCommandRegistry.list().map((d) => {
    const builder = new SlashCommandBuilder().setName(d.name).setDescription(d.description.slice(0, 100));
    for (const opt of d.options ?? []) addOption(builder, opt);
    return builder as SlashCommandBuilder;
  });
}

function toInvocation(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
  descriptor: SlashCommandDescriptor,
): SlashCommandInvocation {
  const options: SlashCommandInvocation["options"] = {};
  for (const opt of descriptor.options ?? []) {
    const raw =
      opt.type === "integer"
        ? interaction.options.getInteger(opt.name)
        : opt.type === "number"
          ? interaction.options.getNumber(opt.name)
          : opt.type === "boolean"
            ? interaction.options.getBoolean(opt.name)
            : interaction.options.getString(opt.name);
    if (raw !== null && raw !== undefined) options[opt.name] = raw;
  }
  return {
    command: descriptor.name,
    options,
    user: { id: interaction.user.id, username: interaction.user.username },
    channelId: interaction.channelId ?? undefined,
    guildId: interaction.guildId ?? undefined,
  };
}

/**
 * Returns true when this interaction belonged to a registered plugin command
 * and has been answered — the caller should stop.
 *
 * The reply is deferred first. A plugin handler is arbitrary code doing
 * arbitrary work (this is how the instance switcher shells out to a service
 * script), and Discord kills an interaction that goes three seconds without a
 * response. Deferring buys fifteen minutes and costs nothing.
 */
export async function handlePluginCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const descriptor = slashCommandRegistry.get(interaction.commandName);
  if (!descriptor) return false;

  const ephemeralDefault = descriptor.ephemeral ?? true;
  await interaction.deferReply({ flags: ephemeralDefault ? MessageFlags.Ephemeral : undefined }).catch(() => {});

  try {
    const reply = await descriptor.handler(toInvocation(interaction, descriptor));
    const content = reply?.content ?? "(no output)";
    const all = splitMessage(content);
    const chunks = all.slice(0, MAX_CHUNKS);
    if (all.length > chunks.length) {
      chunks[chunks.length - 1] += `\n\n_…${all.length - chunks.length} more message(s) not shown._`;
    }
    await interaction.editReply({ content: chunks[0] });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({
        content: chunk,
        flags: (reply?.ephemeral ?? ephemeralDefault) ? MessageFlags.Ephemeral : undefined,
      });
    }
  } catch (err) {
    // A plugin throwing must not take the channel down, and must not leave the
    // interaction hanging as "the application did not respond".
    console.error(`[discord] plugin command /${interaction.commandName} failed:`, err);
    await interaction
      .editReply({ content: `\`/${interaction.commandName}\` failed: ${(err as Error).message}` })
      .catch(() => {});
  }
  return true;
}

/** Returns true when this autocomplete belonged to a plugin command. */
export async function handlePluginAutocomplete(interaction: AutocompleteInteraction): Promise<boolean> {
  const descriptor = slashCommandRegistry.get(interaction.commandName);
  if (!descriptor) return false;

  const focused = interaction.options.getFocused(true);
  const opt = descriptor.options?.find((o) => o.name === focused.name);
  if (!opt?.autocomplete) {
    await interaction.respond([]).catch(() => {});
    return true;
  }

  try {
    const values = await opt.autocomplete(String(focused.value ?? ""), toInvocation(interaction, descriptor));
    await interaction
      .respond(values.slice(0, MAX_CHOICES).map((v) => ({ name: v.slice(0, 100), value: v.slice(0, 100) })))
      .catch(() => {});
  } catch (err) {
    console.error(`[discord] autocomplete for /${interaction.commandName} failed:`, (err as Error).message);
    await interaction.respond([]).catch(() => {});
  }
  return true;
}
