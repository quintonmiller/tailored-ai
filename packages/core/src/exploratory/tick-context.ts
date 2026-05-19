import type Database from "better-sqlite3";
import {
  type CoreMemoryRow,
  getCoreMemory,
} from "../db/core-memory-queries.js";
import { queryProjectTasks } from "../db/task-queries.js";
import {
  getTickOutcomesWindow,
  type TickOutcomesWindow,
} from "../db/tick-log-queries.js";

/**
 * Structured situation report assembled by code at the start of every
 * tick (see docs/agent-unification.md).
 *
 * Each section is a small composable query; sections that fail (e.g. a
 * backend isn't wired) degrade gracefully to an empty array rather than
 * blowing up the tick.
 *
 * The renderer formats this as a "Situation" block in the system prompt
 * with a typed candidate menu. The agent picks one move per tick.
 */
export interface TickBacklogSnapshot {
  /** Top N backlog items by (age × priority), oldest first. */
  untouched: BacklogSummary[];
  /** Tasks in `in_review` for > 24h with no recent comments. */
  staleInReview: BacklogSummary[];
}

export interface BacklogSummary {
  id: string;
  title: string;
  status: string;
  ageDays: number;
  /** First line of description, trimmed. */
  blurb: string;
  /** When set, the assignee the task is currently routed to. */
  assignee: string | null;
}

export interface ExplorationCandidates {
  /** Open questions the agent has flagged for itself (from core_memory.open_questions). */
  openQuestions: string[];
  /**
   * Threads in `core_memory.active_threads` that haven't been touched in the
   * recent_summary lately — a stagnation signal.
   */
  staleThreads: string[];
}

export interface TickContext {
  agent: string;
  projectId: string | null;
  generatedAt: string;
  backlog: TickBacklogSnapshot;
  exploration: ExplorationCandidates;
  outcomes: TickOutcomesWindow;
  /** Core memory rows at the time of building — handy for the renderer. */
  coreMemory: CoreMemoryRow[];
}

export interface BuildTickContextOptions {
  /** How many backlog items to pull in per category. Default 5. */
  backlogLimit?: number;
  /** Window size in past ticks for the outcomes rollup. Default 20. */
  outcomesWindowTicks?: number;
  /** How old (days) a task in `in_review` must be to count as stale. Default 1. */
  staleReviewDays?: number;
  /** Override for "now" — testing only. */
  now?: () => Date;
}

export function buildTickContext(
  db: Database.Database,
  agent: string,
  projectId: string | null,
  opts: BuildTickContextOptions = {},
): TickContext {
  const now = (opts.now ?? (() => new Date()))();
  const backlogLimit = opts.backlogLimit ?? 5;
  const outcomesWindow = opts.outcomesWindowTicks ?? 20;
  const staleReviewDays = opts.staleReviewDays ?? 1;

  // --- Backlog snapshot ----------------------------------------------------
  // Sections degrade independently — if the task backend is missing or
  // raises, that section comes back empty but the rest of the context still
  // ships.
  let untouched: BacklogSummary[] = [];
  let staleInReview: BacklogSummary[] = [];

  try {
    const backlog = queryProjectTasks(db, {
      status: "backlog",
      project_id: projectId ?? undefined,
      orderBy: "updated_at",
      limit: backlogLimit,
    });
    untouched = backlog.tasks.map((t) => taskToSummary(t, now));
  } catch {
    // Degrade silently.
  }

  try {
    const inReview = queryProjectTasks(db, {
      status: "in_review",
      project_id: projectId ?? undefined,
      orderBy: "updated_at",
      limit: backlogLimit * 2,
    });
    const cutoffMs = staleReviewDays * 86_400_000;
    staleInReview = inReview.tasks
      .filter((t) => now.getTime() - new Date(t.updated_at).getTime() >= cutoffMs)
      .slice(0, backlogLimit)
      .map((t) => taskToSummary(t, now));
  } catch {
    // Degrade silently.
  }

  // --- Exploration candidates ---------------------------------------------
  const coreMemory = getCoreMemory(db, { agent, project_id: projectId });
  const openQuestions = extractLines(coreMemory, "open_questions");
  const activeThreads = extractLines(coreMemory, "active_threads");
  // For v1, treat all active threads as potentially stale. A future pass
  // can cross-reference recent_summary mentions to filter to genuinely-stale.
  const staleThreads = activeThreads.slice(0, 5);

  // --- Outcomes -----------------------------------------------------------
  const outcomes = getTickOutcomesWindow(db, agent, outcomesWindow);

  return {
    agent,
    projectId,
    generatedAt: now.toISOString(),
    backlog: { untouched, staleInReview },
    exploration: { openQuestions, staleThreads },
    outcomes,
    coreMemory,
  };
}

function taskToSummary(
  t: { id: string; title: string; status: string; description: string; created_at: string; assignee: string | null },
  now: Date,
): BacklogSummary {
  const ageDays = Math.max(
    0,
    Math.floor((now.getTime() - new Date(t.created_at).getTime()) / 86_400_000),
  );
  const blurb = (t.description ?? "").split("\n")[0].trim().slice(0, 100);
  return { id: t.id, title: t.title, status: t.status, ageDays, blurb, assignee: t.assignee };
}

function extractLines(rows: CoreMemoryRow[], section: string): string[] {
  const row = rows.find((r) => r.section === section);
  if (!row) return [];
  return row.content
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Render a TickContext into a prompt block. The block is opinionated:
 * it explicitly enumerates candidate moves (A/B/C/D/E + Sleep) so the
 * agent picks from a structured menu rather than free-styling
 * "what should I do." The menu IS the scoring.
 *
 * Output is bounded — total block stays under ~2KB so it doesn't eat
 * the prompt budget. Empty sections are omitted.
 */
export function renderTickSituation(ctx: TickContext): string {
  const lines: string[] = [];
  lines.push("## Situation (rebuilt fresh this tick)");
  lines.push("");

  if (ctx.outcomes.ticks > 0) {
    const k = ctx.outcomes.byKind;
    const kindParts = Object.entries(k)
      .map(([kind, n]) => `${kind} ${n}`)
      .join(" · ");
    lines.push(
      `**Last ${ctx.outcomes.ticks} ticks:** ${kindParts}` +
        (ctx.outcomes.stagnation ? "  ← stagnation: pick a move that breaks it." : ""),
    );
    lines.push("");
  }

  if (ctx.backlog.untouched.length > 0) {
    lines.push(`**Backlog (top ${ctx.backlog.untouched.length}, oldest first):**`);
    for (const t of ctx.backlog.untouched) {
      lines.push(`- ${t.id} \`${t.title}\` — ${t.ageDays}d` + (t.blurb ? ` — ${t.blurb}` : ""));
    }
    lines.push("");
  }

  if (ctx.backlog.staleInReview.length > 0) {
    lines.push("**In review > 24h (stale, may need a poke):**");
    for (const t of ctx.backlog.staleInReview) {
      lines.push(`- ${t.id} \`${t.title}\` — ${t.ageDays}d`);
    }
    lines.push("");
  }

  if (ctx.exploration.openQuestions.length > 0) {
    lines.push("**Open questions you flagged earlier:**");
    for (const q of ctx.exploration.openQuestions.slice(0, 5)) {
      lines.push(`- ${q}`);
    }
    lines.push("");
  }

  if (ctx.exploration.staleThreads.length > 0) {
    lines.push("**Your active threads:**");
    for (const t of ctx.exploration.staleThreads) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  lines.push("**Your move this tick** — pick exactly one and act on it:");
  lines.push("");
  lines.push("A. `delegate(<specialist>, \"<task>\")` — when a specialist can answer faster than you");
  lines.push("B. `tasks(action=update|comment, id=...)` — advance a specific in_review/backlog item");
  lines.push("C. `tasks(action=create, ...)` — propose a new sub-task that breaks something open");
  lines.push("D. `ask_user(\"<specific question>\")` — when only the user can decide");
  lines.push("E. `run_workflow(name=...)` — kick off a known pipeline");

  // Sleep eligibility: explicitly forbid Sleep when there's plenty to do.
  // The agent's failure mode is "nothing urgent, Sleep" — but exploration
  // of non-urgent backlog is exactly what we want.
  const hasUntouchedBacklog = ctx.backlog.untouched.length > 0;
  const hasStaleReview = ctx.backlog.staleInReview.length > 0;
  const hasOpenQuestions = ctx.exploration.openQuestions.length > 0;
  const sleepForbidden = ctx.outcomes.stagnation || (hasUntouchedBacklog && ctx.backlog.untouched[0].ageDays >= 1);

  if (sleepForbidden) {
    lines.push("");
    lines.push("**F. `Sleep` is NOT AVAILABLE this tick.** Reason: " +
      (ctx.outcomes.stagnation
        ? "stagnation — material work has been 0 across the window."
        : `${ctx.backlog.untouched.length} untouched backlog items, oldest ${ctx.backlog.untouched[0].ageDays}d. Pick one to advance.`));
    lines.push("");
    lines.push(
      "Even if nothing is 'urgent', exploration is the job. Pick the most interesting backlog item and: research it (delegate to researcher), propose a sub-task that makes it tractable (C), or ask the user a clarifying question (D). Doing one of these is success.",
    );
  } else {
    lines.push("F. `Sleep` — only when A-E genuinely don't apply. Cite which you considered.");
    lines.push("");
    lines.push(
      "If you choose F (Sleep), do NOT write a recall note about being idle — that's already captured in tick_log. Just call Sleep and stop.",
    );
  }

  // Tick exit contract (docs/agent-unification.md). The chat agent reads
  // recent_summary on every user turn — if you did material work this
  // tick, append a one-liner to it BEFORE you Sleep, so chat is aware.
  lines.push("");
  lines.push(
    "**Before Sleep, if you did material work this tick:** call `core_memory(action=append, section=recent_summary, content=\"<one-line of what you did>\")`. This is what makes chat aware of your tick activity — without it, the user asking 'what have you been up to?' sees stale state.",
  );

  if (hasOpenQuestions || hasStaleReview) {
    lines.push("");
    lines.push("(Reminder: open_questions and stale in_review items above are also fair targets for action this tick.)");
  }

  return lines.join("\n");
}
