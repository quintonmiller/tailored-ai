import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from "discord.js";
import type { PauseScope, RuntimeSettings } from "../db/runtime-settings-queries.js";

/**
 * `/pause` and `/resume` — stop agents running on their own, from a phone,
 * without stopping TAI.
 *
 * The incident: two agents on a metered API answered each other overnight and
 * spent real money in twenty minutes. Every existing off switch was the wrong
 * shape — killing the process loses in-flight work and the ability to look at
 * anything, editing config bounces the Discord gateway you are typing into,
 * and `autopilot pause` covers one of six things that can start a run.
 *
 * ## Why the default scope leaves your own messages alone
 *
 * A pause that also blocks the owner's DMs is indistinguishable from an
 * outage. Worse, it removes the instruments you would use to find out what
 * went wrong — `/memory`, `/room status`, asking an agent what it just did.
 * The default blocks runs that nothing living asked for and leaves the
 * conversation working. `scope: all` exists for when the answer really is
 * "everything, stop".
 */

export const PAUSE_COMMAND_NAME = "pause";
export const RESUME_COMMAND_NAME = "resume";

export interface PauseCommandDeps {
  getPauseState: () => RuntimeSettings;
  setAgentsPaused: (opts: { paused: boolean; scope?: PauseScope; by?: string | null }) => RuntimeSettings;
}

export function buildPauseCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(PAUSE_COMMAND_NAME)
    .setDescription("Stop agents starting new runs on their own. Your own messages keep working.");

  cmd.addStringOption((o) =>
    o
      .setName("scope")
      .setDescription("autonomous (default) blocks timers and agent-to-agent; all also blocks your messages")
      .setRequired(false)
      .addChoices(
        { name: "autonomous — timers, cron, webhooks, agents waking agents", value: "autonomous" },
        { name: "all — the above plus your own messages", value: "all" },
      ),
  );

  return cmd;
}

export function buildResumeCommand(): SlashCommandBuilder {
  return new SlashCommandBuilder().setName(RESUME_COMMAND_NAME).setDescription("Let agents run again");
}

/**
 * What is blocked and what is not, in the order someone reading this on a
 * phone needs it.
 *
 * Written out in full rather than "paused (autonomous)" on purpose: the whole
 * failure mode this command guards against is not knowing whether the system
 * is stopped or broken, and a one-word status answers neither question.
 */
function describe(scope: PauseScope): string {
  const common = [
    "**Blocked:** cron jobs, webhooks, all workflow pollers (email, calendar, RSS, weather, sensors, finance, geofence, file-drop), autopilot, exploratory ticks, task auto-dispatch and stall retries, room check-ins, and agents waking other agents.",
  ];
  if (scope === "all") {
    return [
      ...common,
      "**Also blocked:** your own messages — DMs, slash commands, the web UI chat, and the CLI. Nothing will answer you until `/resume`.",
      "**In-flight runs finish.** Anything already thinking will complete its current turn; stopping mid-tool-call is how a costly mistake becomes a costly mistake plus a broken worktree.",
    ].join("\n");
  }
  return [
    ...common,
    '**Still works:** everything you start yourself — DMs, slash commands, the web UI, the CLI, cron "Run now", and agents answering *you* in a room. `/pause scope:all` blocks those too.',
    "**In-flight runs finish.** Anything already thinking will complete its current turn; stopping mid-tool-call is how a costly mistake becomes a costly mistake plus a broken worktree.",
  ].join("\n");
}

function pauseReply(state: RuntimeSettings, alreadyPaused: boolean): string {
  const scope = state.pause_scope ?? "autonomous";
  const header = alreadyPaused
    ? `Already paused (**${scope}**) since ${state.paused_at ?? "unknown"}${state.paused_by ? ` by ${state.paused_by}` : ""}.`
    : `Agents paused — scope **${scope}**.`;
  return [header, "", describe(scope), "", "`/resume` lifts it."].join("\n");
}

/**
 * Returns true when this interaction was `/pause` or `/resume` and has been
 * answered — the caller should stop.
 *
 * Ephemeral, and answered straight from the database: this must never queue
 * behind a running agent. A stop button that waits for the thing it is
 * stopping is not a stop button.
 */
export async function handlePauseCommand(
  interaction: ChatInputCommandInteraction,
  deps: PauseCommandDeps,
): Promise<boolean> {
  const name = interaction.commandName;
  if (name !== PAUSE_COMMAND_NAME && name !== RESUME_COMMAND_NAME) return false;

  try {
    await interaction.reply({ content: run(interaction, deps), flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error(`[discord] /${name} failed:`, err);
    const message = `That didn't work: ${(err as Error).message}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

export function run(interaction: ChatInputCommandInteraction, deps: PauseCommandDeps): string {
  const by = interaction.user?.username ?? null;

  if (interaction.commandName === RESUME_COMMAND_NAME) {
    const before = deps.getPauseState();
    if (!before.agents_paused) return "Agents were not paused. Nothing to lift.";
    deps.setAgentsPaused({ paused: false, by });
    return [
      `Agents resumed. Paused since ${before.paused_at ?? "unknown"}${before.paused_by ? ` by ${before.paused_by}` : ""}.`,
      "",
      "Timers, pollers and cron pick up on their next scheduled tick rather than firing a backlog all at once. Anything an agent skipped while paused is not replayed — tasks it did not dispatch are still sitting where they were.",
    ].join("\n");
  }

  const requested = interaction.options.getString("scope");
  const scope: PauseScope = requested === "all" ? "all" : "autonomous";

  const before = deps.getPauseState();
  if (before.agents_paused && before.pause_scope === scope) {
    // Reporting rather than erroring: someone pressing pause twice is someone
    // who is not sure it worked, and an error message is the worst possible
    // answer to that.
    return pauseReply(before, true);
  }

  const after = deps.setAgentsPaused({ paused: true, scope, by });
  const widened = before.agents_paused ? `Scope changed from **${before.pause_scope}** to **${scope}**.\n\n` : "";
  return widened + pauseReply(after, false);
}
