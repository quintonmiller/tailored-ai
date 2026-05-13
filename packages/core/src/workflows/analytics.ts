import type Database from "better-sqlite3";

/**
 * Aggregates over workflow_runs + workflow_steps to power a "what ran this
 * week" dashboard. All queries are filterable by time window.
 *
 * Cost durations are wall-clock based on (finished_at - started_at) in
 * milliseconds. They include time spent waiting on semaphores; that's
 * intentional for the dashboard since the user cares about end-to-end.
 */

export interface AnalyticsWindow {
  /** ISO timestamp (inclusive). Default 7 days ago. */
  since?: string;
  /** ISO timestamp (exclusive). Default now. */
  until?: string;
}

export interface AnalyticsSummary {
  windowStart: string;
  windowEnd: string;
  totalRuns: number;
  byStatus: Record<string, number>;
  successRate: number;
  /** Average wall-clock run duration in ms across completed runs. */
  avgDurationMs: number | null;
}

export interface PerWorkflowMetrics {
  workflow_name: string;
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  successRate: number;
  avgDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface StepHotspot {
  step_name: string;
  step_type: string;
  attempts: number;
  failures: number;
  failureRate: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function resolveWindow(w: AnalyticsWindow): { since: string; until: string } {
  const until = w.until ?? new Date().toISOString();
  const since = w.since ?? new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  return { since, until };
}

export function summarize(db: Database.Database, w: AnalyticsWindow = {}): AnalyticsSummary {
  const { since, until } = resolveWindow(w);
  const rows = db
    .prepare(
      `SELECT status, started_at, finished_at FROM workflow_runs
       WHERE started_at >= ? AND started_at < ?`,
    )
    .all(since, until) as Array<{ status: string; started_at: string; finished_at: string | null }>;
  const byStatus: Record<string, number> = {};
  let durations: number[] = [];
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "completed" && r.finished_at) {
      const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
      if (Number.isFinite(ms) && ms >= 0) durations.push(ms);
    }
  }
  const total = rows.length;
  const completed = byStatus.completed ?? 0;
  const avgDurationMs =
    durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  return {
    windowStart: since,
    windowEnd: until,
    totalRuns: total,
    byStatus,
    successRate: total > 0 ? completed / total : 0,
    avgDurationMs,
  };
}

export function perWorkflowMetrics(
  db: Database.Database,
  w: AnalyticsWindow = {},
): PerWorkflowMetrics[] {
  const { since, until } = resolveWindow(w);
  const rows = db
    .prepare(
      `SELECT workflow_name, status, started_at, finished_at FROM workflow_runs
       WHERE started_at >= ? AND started_at < ?`,
    )
    .all(since, until) as Array<{
    workflow_name: string;
    status: string;
    started_at: string;
    finished_at: string | null;
  }>;

  const byName = new Map<string, { rows: typeof rows; durations: number[] }>();
  for (const r of rows) {
    const bucket = byName.get(r.workflow_name) ?? { rows: [] as typeof rows, durations: [] };
    bucket.rows.push(r);
    if (r.status === "completed" && r.finished_at) {
      const ms = Date.parse(r.finished_at) - Date.parse(r.started_at);
      if (Number.isFinite(ms) && ms >= 0) bucket.durations.push(ms);
    }
    byName.set(r.workflow_name, bucket);
  }

  const out: PerWorkflowMetrics[] = [];
  for (const [name, b] of byName) {
    const total = b.rows.length;
    const completed = b.rows.filter((r) => r.status === "completed").length;
    const failed = b.rows.filter((r) => r.status === "failed").length;
    const cancelled = b.rows.filter((r) => r.status === "cancelled").length;
    const sorted = [...b.durations].sort((a, b) => a - b);
    const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null;
    out.push({
      workflow_name: name,
      total,
      completed,
      failed,
      cancelled,
      successRate: total > 0 ? completed / total : 0,
      avgDurationMs: avg,
      p50DurationMs: percentile(sorted, 0.5),
      p95DurationMs: percentile(sorted, 0.95),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

export function stepHotspots(
  db: Database.Database,
  w: AnalyticsWindow = {},
  limit = 10,
): StepHotspot[] {
  const { since, until } = resolveWindow(w);
  const rows = db
    .prepare(
      `SELECT s.step_name, s.step_type, COUNT(*) as attempts,
              SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) as failures
       FROM workflow_steps s
       JOIN workflow_runs r ON s.run_id = r.id
       WHERE r.started_at >= ? AND r.started_at < ?
       GROUP BY s.step_name, s.step_type
       HAVING failures > 0
       ORDER BY failures DESC, attempts DESC
       LIMIT ?`,
    )
    .all(since, until, limit) as Array<{
    step_name: string;
    step_type: string;
    attempts: number;
    failures: number;
  }>;
  return rows.map((r) => ({
    ...r,
    failureRate: r.attempts > 0 ? r.failures / r.attempts : 0,
  }));
}

export interface TokensByWorkflow {
  workflow_name: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Token usage attributed by sessionId prefix. Workflow sessions are keyed
 * `workflow:<runId>:<step>`, so we join through workflow_runs to attribute
 * usage back to the workflow_name.
 */
export function tokenUsageByWorkflow(
  db: Database.Database,
  w: AnalyticsWindow = {},
): TokensByWorkflow[] {
  const { since, until } = resolveWindow(w);
  const rows = db
    .prepare(
      `SELECT r.workflow_name,
              SUM(t.prompt_tokens) as prompt_tokens,
              SUM(t.completion_tokens) as completion_tokens
       FROM token_usage t
       JOIN workflow_runs r
         ON 'workflow:' || r.id = SUBSTR(t.session_id, 1, LENGTH('workflow:') + LENGTH(r.id))
       WHERE r.started_at >= ? AND r.started_at < ?
       GROUP BY r.workflow_name
       ORDER BY (SUM(t.prompt_tokens) + SUM(t.completion_tokens)) DESC`,
    )
    .all(since, until) as Array<{
    workflow_name: string;
    prompt_tokens: number;
    completion_tokens: number;
  }>;
  return rows.map((r) => ({
    workflow_name: r.workflow_name,
    prompt_tokens: r.prompt_tokens ?? 0,
    completion_tokens: r.completion_tokens ?? 0,
    total_tokens: (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0),
  }));
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
