/**
 * Slash-command seam — lets plugins register chat commands without coupling
 * core to a chat SDK.
 *
 * Same shape as the HTTP route seam next door: core owns a transport-agnostic
 * registry of descriptors, and each channel adapts them onto its own command
 * surface. Core never imports discord.js here; the dependency direction stays
 * channel → core. Discord is the first adapter, but nothing in this file is
 * Discord-specific, so a Slack or Telegram channel can serve the same
 * descriptors.
 *
 * A plugin registers through `ctx.commands` (see plugin-context.ts):
 *
 *     ctx.commands.register({
 *       name: "instance",
 *       description: "Show or switch the running TAI instance",
 *       options: [{ name: "name", description: "Instance", type: "string" }],
 *       handler: async (inv) => ({ content: `switching to ${inv.options.name}` }),
 *     });
 *
 * Unlike HTTP routes, these cannot be namespaced. Discord command names are a
 * flat per-guild namespace matching /^[-_a-z0-9]{1,32}$/ — there is no
 * separator to hide a prefix behind. So collisions are refused instead:
 * `RESERVED_COMMAND_NAMES` holds the built-ins, and registering one of those,
 * or a name another plugin already took, throws. Refusing is the honest
 * failure — the alternative is a plugin silently shadowing `/room` or `/memory`
 * for everyone in the guild.
 */

/** Built-in commands. A plugin may not take these names. */
export const RESERVED_COMMAND_NAMES: readonly string[] = [
  "new",
  "agent",
  "help",
  "compact",
  "context",
  "tasks",
  "room",
  "memory",
  "pause",
  "resume",
  "clone-agent",
];

/** Discord's constraint, and the narrowest of the chat platforms we target. */
const VALID_COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;

export type SlashCommandOptionType = "string" | "integer" | "number" | "boolean";

export interface SlashCommandOption {
  name: string;
  description: string;
  type: SlashCommandOptionType;
  required?: boolean;
  /** Fixed choices. Mutually exclusive with `autocomplete` on most platforms. */
  choices?: Array<{ name: string; value: string | number }>;
  /**
   * Live suggestions as the user types. Return at most 25; the adapter
   * truncates beyond that. Keep it fast — Discord gives roughly 3 seconds.
   */
  autocomplete?: (partial: string, invocation: SlashCommandInvocation) => Promise<string[]> | string[];
}

/** What the handler is told about the invocation, in transport-neutral terms. */
export interface SlashCommandInvocation {
  command: string;
  /** Resolved option values, keyed by option name. Absent options are omitted. */
  options: Record<string, string | number | boolean | undefined>;
  /** Who invoked it. `id` is the platform's user id. */
  user: { id: string; username: string };
  channelId?: string;
  guildId?: string;
}

export interface SlashCommandReply {
  content: string;
  /**
   * Visible only to the invoker. Defaults to the descriptor's `ephemeral`,
   * which itself defaults to true — a command's output is usually for the
   * person who ran it, and a channel is the wrong place to print it by
   * accident.
   */
  ephemeral?: boolean;
}

export interface SlashCommandDescriptor {
  name: string;
  description: string;
  options?: SlashCommandOption[];
  /** Default visibility for replies. Defaults to true. */
  ephemeral?: boolean;
  /**
   * Who may run this. `"owner"` restricts it to the deployment owner as each
   * channel understands that (on Discord, `channels.discord.owner`); the
   * channel enforces it before the handler is ever called.
   *
   * Defaults to `"anyone"`, which is not the safe default but is the honest
   * one: most commands report rather than change, and a descriptor that had to
   * opt out of a restriction it never wanted would get boilerplate rather than
   * thought. Anything that shells out, writes config, or moves money should say
   * `"owner"` — declaring it here is the whole reason this field exists, rather
   * than each handler hand-rolling a check it can get wrong.
   */
  restrict?: "owner" | "anyone";
  handler: (invocation: SlashCommandInvocation) => Promise<SlashCommandReply> | SlashCommandReply;
}

export class SlashCommandConflictError extends Error {
  constructor(
    readonly name: string,
    reason: string,
  ) {
    super(`Cannot register slash command "${name}": ${reason}`);
    this.name = "SlashCommandConflictError";
  }
}

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommandDescriptor>();

  /**
   * Returns a disposer. Plugins are expected to call it from their `stop()`
   * so a disabled plugin's commands stop being advertised — the channel
   * re-syncs from `list()` on every config reload.
   */
  register(descriptor: SlashCommandDescriptor): () => void {
    const name = descriptor.name;
    if (!VALID_COMMAND_NAME.test(name)) {
      throw new SlashCommandConflictError(
        name,
        "name must be 1-32 characters of lowercase letters, digits, underscore or dash",
      );
    }
    if (RESERVED_COMMAND_NAMES.includes(name)) {
      throw new SlashCommandConflictError(name, "that name is a built-in command");
    }
    if (this.commands.has(name)) {
      throw new SlashCommandConflictError(name, "another plugin already registered it");
    }
    if (typeof descriptor.handler !== "function") {
      throw new SlashCommandConflictError(name, "handler must be a function");
    }
    for (const opt of descriptor.options ?? []) {
      if (!VALID_COMMAND_NAME.test(opt.name)) {
        throw new SlashCommandConflictError(name, `option "${opt.name}" has an invalid name`);
      }
    }
    this.commands.set(name, descriptor);
    return () => {
      // Only drop it if it is still ours; a re-register after a reload may
      // already have replaced the entry.
      if (this.commands.get(name) === descriptor) this.commands.delete(name);
    };
  }

  get(name: string): SlashCommandDescriptor | undefined {
    return this.commands.get(name);
  }

  list(): SlashCommandDescriptor[] {
    return [...this.commands.values()];
  }

  /**
   * Each registered command's declared restriction, for a channel's
   * authorization check. A map rather than a lookup per interaction so the
   * caller can hand the whole policy over without reaching back into the
   * registry mid-dispatch.
   */
  restrictions(): Map<string, "owner" | "anyone"> {
    return new Map([...this.commands].map(([name, d]) => [name, d.restrict ?? "anyone"]));
  }

  /** Test/reset helper. Not part of the plugin-facing view. */
  clear(): void {
    this.commands.clear();
  }
}

/** What plugins see. Deliberately narrower than the registry itself. */
export interface SlashCommandRegistryView {
  register(descriptor: SlashCommandDescriptor): () => void;
}

export const slashCommandRegistry = new SlashCommandRegistry();
