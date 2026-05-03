import type Database from "better-sqlite3";

export interface AutopilotSettings {
  token_cap_1h: number | null;
  token_cap_5h: number | null;
  token_cap_24h: number | null;
  quiet_start: string | null;
  quiet_end: string | null;
  disabled_start: string | null;
  disabled_end: string | null;
  paused: boolean;
  digest_time: string | null;
  updated_at: string;
}

interface AutopilotRow {
  token_cap_1h: number | null;
  token_cap_5h: number | null;
  token_cap_24h: number | null;
  quiet_start: string | null;
  quiet_end: string | null;
  disabled_start: string | null;
  disabled_end: string | null;
  paused: number;
  digest_time: string | null;
  updated_at: string;
}

export function getAutopilotSettings(db: Database.Database): AutopilotSettings {
  const row = db.prepare("SELECT * FROM autopilot_settings WHERE id = 1").get() as AutopilotRow;
  return { ...row, paused: row.paused === 1 };
}

export function updateAutopilotSettings(
  db: Database.Database,
  updates: Partial<Omit<AutopilotSettings, "updated_at">>,
): AutopilotSettings {
  const fields: string[] = [];
  const values: unknown[] = [];

  const keys: (keyof Omit<AutopilotSettings, "updated_at">)[] = [
    "token_cap_1h",
    "token_cap_5h",
    "token_cap_24h",
    "quiet_start",
    "quiet_end",
    "disabled_start",
    "disabled_end",
    "digest_time",
  ];
  for (const key of keys) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }
  if (updates.paused !== undefined) {
    fields.push("paused = ?");
    values.push(updates.paused ? 1 : 0);
  }

  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')");
    db.prepare(`UPDATE autopilot_settings SET ${fields.join(", ")} WHERE id = 1`).run(...values);
  }

  return getAutopilotSettings(db);
}

export interface TokenUsageInput {
  sessionId?: string;
  taskId?: string;
  promptTokens: number;
  completionTokens: number;
}

export function recordTokenUsage(db: Database.Database, input: TokenUsageInput): void {
  db.prepare(
    "INSERT INTO token_usage (session_id, task_id, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?)",
  ).run(input.sessionId ?? null, input.taskId ?? null, input.promptTokens, input.completionTokens);
}

/** Total (prompt + completion) tokens used within the last N hours. */
export function getTokenUsageInWindow(db: Database.Database, hours: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS total
       FROM token_usage
       WHERE created_at >= datetime('now', ?)`,
    )
    .get(`-${hours} hours`) as { total: number };
  return row.total;
}

export interface BudgetStatus {
  exceeded: boolean;
  window?: "1h" | "5h" | "24h";
  usage?: number;
  cap?: number;
  nextWindowRollAt?: string;
}

/** Returns the first cap that is currently exceeded, or { exceeded: false }. */
export function checkBudget(db: Database.Database, settings?: AutopilotSettings): BudgetStatus {
  const s = settings ?? getAutopilotSettings(db);
  const windows: Array<{ label: "1h" | "5h" | "24h"; hours: number; cap: number | null }> = [
    { label: "1h", hours: 1, cap: s.token_cap_1h },
    { label: "5h", hours: 5, cap: s.token_cap_5h },
    { label: "24h", hours: 24, cap: s.token_cap_24h },
  ];

  for (const w of windows) {
    if (w.cap === null || w.cap <= 0) continue;
    const usage = getTokenUsageInWindow(db, w.hours);
    if (usage >= w.cap) {
      const row = db
        .prepare(
          `SELECT datetime(MIN(created_at), ?) AS t
           FROM token_usage
           WHERE created_at >= datetime('now', ?)`,
        )
        .get(`+${w.hours} hours`, `-${w.hours} hours`) as { t: string | null };
      return { exceeded: true, window: w.label, usage, cap: w.cap, nextWindowRollAt: row.t ?? undefined };
    }
  }

  return { exceeded: false };
}

/**
 * Returns true when `now` falls within the given [start, end] time-of-day window.
 * Windows are HH:MM strings. Supports ranges that cross midnight (e.g. 22:00–07:00).
 * If either bound is null, returns false.
 */
export function isInTimeWindow(start: string | null, end: string | null, now: Date = new Date()): boolean {
  if (!start || !end) return false;
  const startMin = parseHm(start);
  const endMin = parseHm(end);
  if (startMin === null || endMin === null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  if (startMin === endMin) return false;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Crosses midnight
  return nowMin >= startMin || nowMin < endMin;
}

function parseHm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

export function isInDisabledHours(settings: AutopilotSettings, now: Date = new Date()): boolean {
  return isInTimeWindow(settings.disabled_start, settings.disabled_end, now);
}

export function isInQuietHours(settings: AutopilotSettings, now: Date = new Date()): boolean {
  return isInTimeWindow(settings.quiet_start, settings.quiet_end, now);
}
