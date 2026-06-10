import { SESSION_SUMMARY_TAG } from "./agent/summarize-session.js";
import type { AgentConfig } from "./config.js";
import { listFormPending } from "./db/form-queries.js";
import { listNotes } from "./db/note-queries.js";
import { queryProjectTasks } from "./db/task-queries.js";
import { listWorkflowRuns, type WorkflowRunStatus } from "./db/workflow-queries.js";
import type { AIProvider } from "./providers/interface.js";

/** A generated briefing plus the timestamp it was produced. */
export interface Briefing {
  content: string;
  generatedAt: number;
}

/** Subset of the runtime that {@link generateBriefing} reads. Keeps the
 * function unit-testable without constructing a full AgentRuntime. */
export interface BriefingRuntime {
  db: import("better-sqlite3").Database;
  getConfig(): AgentConfig;
  getProvider(): AIProvider;
  getModel(): string;
}

export interface GenerateBriefingOptions {
  /** Override the trailing window for "recent" activity. Default 24h. */
  windowHours?: number;
}

/** Per-list cap and total context budget — keep the prompt local-model friendly. */
const LIST_CAP = 5;
const MAX_CONTEXT_CHARS = 1500;

const COMPLETED_RUN_STATUSES: WorkflowRunStatus[] = ["completed"];

/**
 * Assemble a compact, data-only context from existing dashboard queries.
 *
 * This is DATA, not prompt opinion: blocked/needs-human tasks, recently
 * completed tasks + workflow runs, upcoming enabled cron jobs, recent
 * session-summary notes, and current in-flight activity. Each list is capped
 * and the whole thing is truncated to {@link MAX_CONTEXT_CHARS}.
 */
export function assembleBriefingContext(runtime: BriefingRuntime, windowHours: number): string {
  const db = runtime.db;
  const config = runtime.getConfig();
  const cutoff = sqliteCutoff(windowHours);
  const sections: string[] = [];

  // Needs human — blocked tasks (the Dashboard's "Needs Human" source).
  const blocked = queryProjectTasks(db, { status: "blocked", orderBy: "updated_at", limit: LIST_CAP }).tasks;
  if (blocked.length > 0) {
    sections.push(
      `Blocked tasks needing attention:\n${blocked
        .map((t) => `- ${t.title}${t.blocked_reason ? ` (${t.blocked_reason})` : ""}`)
        .join("\n")}`,
    );
  }

  // Needs human — pending workflow forms.
  const forms = listFormPending(db, { status: "pending" }).slice(0, LIST_CAP);
  if (forms.length > 0) {
    sections.push(
      `Workflow forms awaiting input:\n${forms.map((f) => `- ${f.prompt || `${f.step_name} input`}`).join("\n")}`,
    );
  }

  // Recent — tasks completed in the window.
  const done = queryProjectTasks(db, {
    status: "done",
    orderBy: "updated_at",
    updatedAfter: cutoff,
    limit: LIST_CAP,
  }).tasks;
  if (done.length > 0) {
    sections.push(`Recently completed tasks:\n${done.map((t) => `- ${t.title}`).join("\n")}`);
  }

  // Recent — workflow runs that finished in the window.
  const runs = listWorkflowRuns(db, { limit: 50 })
    .filter((r) => {
      if (!COMPLETED_RUN_STATUSES.includes(r.status) && r.status !== "failed") return false;
      const when = r.finished_at ?? r.started_at;
      return when >= cutoff;
    })
    .slice(0, LIST_CAP);
  if (runs.length > 0) {
    sections.push(`Recent workflow runs:\n${runs.map((r) => `- ${r.workflow_name}: ${r.status}`).join("\n")}`);
  }

  // Upcoming — enabled cron jobs.
  const cronJobs = config.cron.jobs.filter((j) => j.enabled !== false).slice(0, LIST_CAP);
  if (cronJobs.length > 0) {
    sections.push(`Scheduled jobs coming up:\n${cronJobs.map((j) => `- ${j.name} (${j.schedule})`).join("\n")}`);
  }

  // Context — recent session-summary notes.
  const summaries = listNotes(db, { tag: SESSION_SUMMARY_TAG, limit: LIST_CAP, excludeExpired: true });
  if (summaries.length > 0) {
    sections.push(
      `Recent session notes:\n${summaries.map((n) => `- ${truncate(n.content.replace(/\s+/g, " "), 120)}`).join("\n")}`,
    );
  }

  if (sections.length === 0) {
    return "Nothing notable happened recently. No blocked tasks, no pending input, no scheduled jobs.";
  }

  const joined = sections.join("\n\n");
  return truncate(joined, MAX_CONTEXT_CHARS);
}

/**
 * Generate a one-shot briefing: assemble compact context from existing
 * queries, then run a single provider completion using the system prompt from
 * `config.briefing.prompt`. Honors `config.briefing.model` as a model override
 * against the active provider.
 */
export async function generateBriefing(
  runtime: BriefingRuntime,
  opts: GenerateBriefingOptions = {},
): Promise<Briefing> {
  const config = runtime.getConfig();
  const briefingCfg = config.briefing ?? {};
  const windowHours = opts.windowHours ?? 24;
  const systemPrompt = briefingCfg.prompt?.trim() || DEFAULT_BRIEFING_PROMPT;
  const model = briefingCfg.model?.trim() || runtime.getModel();

  const context = assembleBriefingContext(runtime, windowHours);

  const response = await runtime.getProvider().chat({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
    temperature: 0.3,
    maxTokens: briefingCfg.maxTokens ?? 1024,
    extra: briefingCfg.providerExtra,
  });

  return {
    content: (response.content ?? "").trim(),
    generatedAt: Date.now(),
  };
}

/** Default briefing system prompt. Generic, concise, local-model friendly. */
export const DEFAULT_BRIEFING_PROMPT =
  "You are the user's personal assistant. Write a brief, friendly briefing from the data below: " +
  "a 1-2 sentence greeting summarizing the situation, then up to 3 bullet points of what needs attention, " +
  "then 1 line of what's coming up. Plain language, under 120 words, no headers.";

/**
 * A `YYYY-MM-DD HH:MM:SS` UTC cutoff string, matching the format SQLite's
 * `datetime('now')` writes — so lexical `>` / `>=` comparisons against stored
 * `updated_at` / `finished_at` columns are correct.
 */
function sqliteCutoff(windowHours: number): string {
  return new Date(Date.now() - windowHours * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
