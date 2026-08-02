---
"@tailored-ai/core": patch
---

Slash commands check who is asking.

`shouldRespond` gates the MessageCreate path — self, other bots, the DM policy, `allowedGuilds`. Interactions arrive on a different listener and passed through none of it, so every slash command was reachable by anyone who could see the bot: `/pause` stops the deployment, `/memory set` rewrites an agent's core memory, `/room reset` clears history, `/clone-agent` writes a new agent into `config.yaml`.

Two checks now run before any handler, in a new `discord-authorization.ts` that owns the policy and knows nothing about discord.js beyond the shape of an interaction.

`allowedGuilds` was never a missing policy — it is declared config the interaction path simply never read. Honouring it is a bug fix.

The owner check is new, and applies to commands that change state rather than report them. Which ones is a list (`OWNER_ONLY_COMMANDS`, `OWNER_ONLY_SUBCOMMANDS`), not an inference: a command's blast radius is not derivable from its name, and guessing wrong in either direction is worse than a list somebody maintains deliberately. `/memory show` and `/room members` stay open; `/memory set` and `/room reset` do not.

When `channels.discord.owner` is unset, an owner-only command is refused with a message naming the key to set. Allowing it would mean the guard does nothing on exactly the deployments that never configured an owner.

Autocomplete is gated the same way. It answers from config and the database — agent names, memory sections, room names — so suggesting them to someone who cannot run the command leaks what the command would have.

The policy also accepts per-command restrictions declared by plugins, so a plugin can ship a privileged command without core knowing its name. Built-ins are checked first and cannot be relaxed by a plugin registering the same name.
