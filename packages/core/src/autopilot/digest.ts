import type Database from "better-sqlite3";
import { getTokenUsageInWindow } from "../db/autopilot-queries.js";

interface TaskRow {
  id: string;
  title: string;
  status: string;
  blocked_reason: string | null;
  updated_at: string;
}

export interface DigestSection {
  heading: string;
  tasks: TaskRow[];
}

export interface DigestResult {
  empty: boolean;
  content: string;
  sections: DigestSection[];
  totalTokens: number;
}

/**
 * Build a morning digest summarizing autopilot activity in the trailing window.
 * Empty digests short-circuit with a flag so callers can suppress notification.
 */
export function buildMorningDigest(db: Database.Database, windowHours = 24): DigestResult {
  const since = `-${windowHours} hours`;

  const done = db
    .prepare(
      `SELECT id, title, status, blocked_reason, updated_at
       FROM project_tasks
       WHERE status = 'done' AND updated_at >= datetime('now', ?)
       ORDER BY updated_at DESC`,
    )
    .all(since) as TaskRow[];

  const blockedQuestion = db
    .prepare(
      `SELECT id, title, status, blocked_reason, updated_at
       FROM project_tasks
       WHERE status = 'blocked' AND blocked_reason = 'question'
       ORDER BY updated_at DESC`,
    )
    .all() as TaskRow[];

  const blockedBudget = db
    .prepare(
      `SELECT id, title, status, blocked_reason, updated_at
       FROM project_tasks
       WHERE status = 'blocked' AND blocked_reason = 'budget'
       ORDER BY updated_at DESC`,
    )
    .all() as TaskRow[];

  const blockedError = db
    .prepare(
      `SELECT id, title, status, blocked_reason, updated_at
       FROM project_tasks
       WHERE status = 'blocked' AND blocked_reason = 'error' AND updated_at >= datetime('now', ?)
       ORDER BY updated_at DESC`,
    )
    .all(since) as TaskRow[];

  const inReview = db
    .prepare(
      `SELECT id, title, status, blocked_reason, updated_at
       FROM project_tasks
       WHERE status = 'in_review' AND updated_at >= datetime('now', ?)
       ORDER BY updated_at DESC`,
    )
    .all(since) as TaskRow[];

  const totalTokens = getTokenUsageInWindow(db, windowHours);

  const sections: DigestSection[] = [];
  if (done.length > 0) sections.push({ heading: `Completed (${done.length})`, tasks: done });
  if (blockedQuestion.length > 0)
    sections.push({ heading: `Waiting on you (${blockedQuestion.length})`, tasks: blockedQuestion });
  if (inReview.length > 0) sections.push({ heading: `In review (${inReview.length})`, tasks: inReview });
  if (blockedError.length > 0) sections.push({ heading: `Errored (${blockedError.length})`, tasks: blockedError });
  if (blockedBudget.length > 0)
    sections.push({ heading: `Budget-deferred (${blockedBudget.length})`, tasks: blockedBudget });

  if (sections.length === 0 && totalTokens === 0) {
    return { empty: true, content: "", sections: [], totalTokens };
  }

  const lines: string[] = [];
  lines.push(`Autopilot digest — last ${windowHours}h`);
  for (const section of sections) {
    lines.push("");
    lines.push(`**${section.heading}**`);
    for (const t of section.tasks.slice(0, 10)) {
      lines.push(`• ${t.title} (${t.id})`);
    }
    if (section.tasks.length > 10) {
      lines.push(`  …and ${section.tasks.length - 10} more`);
    }
  }
  lines.push("");
  lines.push(`Token usage: ${totalTokens.toLocaleString()}`);

  const content = lines.join("\n");
  return { empty: false, content, sections, totalTokens };
}

export function recordDigestRun(db: Database.Database, content: string): void {
  db.prepare("INSERT INTO digest_runs (content) VALUES (?)").run(content);
}
