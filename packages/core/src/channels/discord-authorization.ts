/**
 * Who is allowed to run a slash command.
 *
 * `shouldRespond` in discord.ts gates the MessageCreate path — self, bots, the
 * DM policy, `allowedGuilds`. Interactions arrive on a different listener and
 * never passed through any of it, so every slash command was reachable by
 * anyone who could see the bot: `/pause` stops the deployment, `/memory set`
 * rewrites an agent's core memory, `/room reset` clears history, `/clone-agent`
 * writes a new agent into config.yaml.
 *
 * Two checks live here.
 *
 * `allowedGuilds` is not a new policy — it is declared config that the
 * interaction path simply never read. Honouring it is a bug fix.
 *
 * The owner check is new. It applies to the commands that change state rather
 * than report it, named below rather than inferred: a command's blast radius is
 * not derivable from its name, and guessing wrong in either direction is worse
 * than a list someone has to maintain deliberately.
 *
 * When `channels.discord.owner` is unset, an owner-only command is refused with
 * a message naming the key to set. Allowing it instead would mean the guard
 * silently does nothing on exactly the deployments that never configured one —
 * the failure mode this module exists to remove.
 */

/** Built-in commands where every subcommand needs the owner. */
export const OWNER_ONLY_COMMANDS: readonly string[] = ["pause", "resume", "clone-agent"];

/**
 * Built-in commands where only some subcommands need the owner. Anything not
 * listed is readable by any user the guild check already admitted.
 */
export const OWNER_ONLY_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  // `show` is read-only; the rest rewrite an agent's core memory.
  memory: ["set", "append", "clear"],
  // `members`/`status`/`ping` report. The rest mutate rooms, clear history, or
  // (in `all`) wake every agent in a room at once.
  room: ["create", "add", "remove", "reset", "rewind", "purpose", "all"],
};

export type AuthDecision = { ok: true } | { ok: false; reason: string };

const ALLOWED: AuthDecision = { ok: true };

export interface InteractionIdentity {
  commandName: string;
  /** The invoked subcommand, when the command has any. */
  subcommand?: string;
  userId: string;
  /** Absent in DMs. */
  guildId?: string;
}

export interface AuthorizationPolicy {
  owner?: string;
  allowedGuilds?: string[];
  /**
   * Commands registered by plugins, with the restriction each declared.
   * Consulted before the built-in lists so a plugin can opt into `owner`
   * without core knowing the plugin's name.
   */
  pluginRestrictions?: Map<string, "owner" | "anyone">;
}

/** True when this command (or this subcommand of it) is owner-only. */
export function requiresOwner(
  identity: Pick<InteractionIdentity, "commandName" | "subcommand">,
  pluginRestrictions?: Map<string, "owner" | "anyone">,
): boolean {
  // Built-ins are checked first and are not overridable. The registry already
  // refuses to register a reserved name, so a plugin claiming one is a bug
  // rather than a policy — but if it ever happens, it must not be able to
  // relax a built-in's restriction by declaring `anyone`.
  if (OWNER_ONLY_COMMANDS.includes(identity.commandName)) return true;

  const builtinSubs = OWNER_ONLY_SUBCOMMANDS[identity.commandName];
  if (builtinSubs) {
    // A command with a subcommand allowlist and no subcommand resolved is not
    // something we can reason about, so treat it as restricted rather than
    // letting an unparsed invocation through.
    return identity.subcommand === undefined || builtinSubs.includes(identity.subcommand);
  }

  const declared = pluginRestrictions?.get(identity.commandName);
  if (declared) return declared === "owner";

  return false;
}

/**
 * Decide whether an interaction may proceed. Returns a reason on refusal so the
 * caller can tell the user which check failed — a command that silently does
 * nothing is indistinguishable from a broken bot.
 */
export function authorizeInteraction(identity: InteractionIdentity, policy: AuthorizationPolicy): AuthDecision {
  // Guild allowlist. DMs have no guild and are governed by the owner check
  // below plus `respondToDMs` on the message path.
  if (identity.guildId && policy.allowedGuilds?.length && !policy.allowedGuilds.includes(identity.guildId)) {
    return { ok: false, reason: "This server is not in `channels.discord.allowedGuilds`." };
  }

  if (!requiresOwner(identity, policy.pluginRestrictions)) return ALLOWED;

  if (!policy.owner) {
    return {
      ok: false,
      reason:
        "This command changes state, so it is owner-only — but `channels.discord.owner` " +
        "is not set, so there is nobody to check against. Set it to your Discord user id.",
    };
  }

  if (policy.owner !== identity.userId) {
    return { ok: false, reason: "This command is restricted to the deployment owner." };
  }

  return ALLOWED;
}
