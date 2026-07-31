import type Database from "better-sqlite3";

/**
 * The global pause switch — deployment-wide state that has to take effect
 * immediately, from a phone, without restarting anything.
 *
 * The motivating incident: two agents on a metered API answered each other
 * unattended and spent real money in twenty minutes, and the owner had no way
 * to stop it that did not involve a laptop and an SSH session.
 *
 * ## Why two scopes and not one
 *
 * `autonomous` blocks runs that nothing living asked for — timers, pollers,
 * cron, webhooks, task dispatch, one agent waking another. It deliberately
 * leaves the owner's own messages working. A pause that also kills your DMs
 * makes the deployment look *broken* rather than paused, and it takes away
 * the instruments you would use to find out what went wrong: `/memory`,
 * `/room status`, asking an agent what it just did.
 *
 * `all` adds human-initiated runs on top, for the case where the answer to
 * "what is spending money?" is "everything, stop".
 *
 * Neither scope kills a run already in flight. Aborting a half-finished tool
 * call is how you turn an expensive mistake into an expensive mistake plus a
 * corrupt worktree.
 */
export type PauseScope = "autonomous" | "all";

/** What a caller is asking permission for. */
export type RunKind = "autonomous" | "human";

export interface RuntimeSettings {
  agents_paused: boolean;
  /** `null` when not paused. */
  pause_scope: PauseScope | null;
  paused_at: string | null;
  paused_by: string | null;
  updated_at: string;
}

interface RuntimeSettingsRow {
  agents_paused: number;
  pause_scope: string | null;
  paused_at: string | null;
  paused_by: string | null;
  updated_at: string;
}

/** `all` is the only other legal value; anything unrecognised degrades to the safer-but-usable scope. */
function toScope(raw: string | null): PauseScope | null {
  if (raw === "all") return "all";
  if (raw === "autonomous") return "autonomous";
  return null;
}

const NOT_PAUSED: RuntimeSettings = {
  agents_paused: false,
  pause_scope: null,
  paused_at: null,
  paused_by: null,
  updated_at: "",
};

/**
 * Read the switch. Cheap enough to call on every gate check, which is the
 * point — a cached copy means a pause does not land until something reloads,
 * and "I pressed pause and it kept going" is the one failure this feature
 * cannot have.
 */
export function getRuntimeSettings(db: Database.Database): RuntimeSettings {
  const row = db.prepare("SELECT * FROM runtime_settings WHERE id = 1").get() as RuntimeSettingsRow | undefined;
  // A database that predates the table (or one mid-migration) reads as
  // running. Failing open is the right default here: the alternative is a
  // deployment that silently refuses to do anything and gives no reason.
  if (!row) return NOT_PAUSED;
  return {
    agents_paused: row.agents_paused === 1,
    pause_scope: row.agents_paused === 1 ? (toScope(row.pause_scope) ?? "autonomous") : null,
    paused_at: row.paused_at,
    paused_by: row.paused_by,
    updated_at: row.updated_at,
  };
}

/**
 * Would a run of this kind be blocked right now?
 *
 * Pure function of the settings so both the runtime accessor and tests can
 * ask the question without a database.
 */
export function pauseBlocks(settings: RuntimeSettings, kind: RunKind): boolean {
  if (!settings.agents_paused) return false;
  if (settings.pause_scope === "all") return true;
  return kind === "autonomous";
}

/** Convenience: read and decide in one call. */
export function isAgentsPaused(db: Database.Database, kind: RunKind): boolean {
  return pauseBlocks(getRuntimeSettings(db), kind);
}

/**
 * Flip the switch. Returns the state after the write so the caller can report
 * exactly what is true rather than what it asked for.
 */
export function setAgentsPaused(
  db: Database.Database,
  opts: { paused: boolean; scope?: PauseScope; by?: string | null },
): RuntimeSettings {
  if (opts.paused) {
    db.prepare(
      `UPDATE runtime_settings
         SET agents_paused = 1,
             pause_scope = ?,
             paused_at = datetime('now'),
             paused_by = ?,
             updated_at = datetime('now')
       WHERE id = 1`,
    ).run(opts.scope ?? "autonomous", opts.by ?? null);
  } else {
    // paused_by / paused_at are cleared too: a stale "paused by quinton at
    // 02:14" next to agents_paused = 0 reads like it is still paused.
    db.prepare(
      `UPDATE runtime_settings
         SET agents_paused = 0,
             pause_scope = NULL,
             paused_at = NULL,
             paused_by = NULL,
             updated_at = datetime('now')
       WHERE id = 1`,
    ).run();
  }
  return getRuntimeSettings(db);
}
