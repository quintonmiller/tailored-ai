import { useEffect, useState } from "react";
import {
  type CronData,
  type ExploratoryRun,
  fetchActivity,
  fetchCron,
  fetchExploratoryRuns,
  fetchMemoryNotes,
  fetchProjectTasks,
  fetchWorkflowRuns,
  type MemoryNote,
  type ProjectTask,
  type SessionActivity,
  type WorkflowRunRow,
} from "../api";

/** Kind tags the row so the UI can pick an accent/verb; purely cosmetic. */
export type FeedKind = "workflow" | "task" | "explore" | "cron" | "session" | "memory";

export interface FeedItem {
  /** Stable list key. */
  key: string;
  /** Event time, used for sort + the HH:MM stamp. */
  at: Date;
  kind: FeedKind;
  /** One-line, already human-readable. */
  text: string;
  /** Optional deep-link href (hash route). */
  href?: string;
  /** True while the underlying work is still in flight (pins to the top). */
  inFlight?: boolean;
  /** For digest rows (memory): the collapsed detail lines shown on expand. */
  details?: string[];
}

const POLL_MS = 15000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CAP = 25;
/** Memory notes within this gap collapse into one "burst" digest row. */
const MEMORY_BURST_MS = 10 * 60 * 1000;

/**
 * The Home "Today" rail feed. Merges a handful of EXISTING api.ts fetchers into
 * one reverse-chron, last-24h, deduped, capped list of timestamped events —
 * client-side only, no server changes. Sources without a usable timestamp are
 * skipped; any failing/disabled source simply contributes nothing, so the rail
 * degrades to "quiet so far." rather than breaking. A single 15s interval polls
 * everything and is torn down on unmount.
 */
export function useTodayFeed(): { items: FeedItem[] } {
  const [runs, setRuns] = useState<WorkflowRunRow[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [explore, setExplore] = useState<ExploratoryRun[]>([]);
  const [cron, setCron] = useState<CronData | null>(null);
  const [activity, setActivity] = useState<SessionActivity[]>([]);
  const [notes, setNotes] = useState<MemoryNote[]>([]);

  useEffect(() => {
    const refresh = () => {
      fetchWorkflowRuns({ limit: 12 })
        .then(setRuns)
        .catch(() => {});
      fetchProjectTasks({ order_by: "updated_at", limit: 12 })
        .then((r) => setTasks(r.tasks))
        .catch(() => {});
      fetchExploratoryRuns({ limit: 12 })
        .then((r) => setExplore(r.runs))
        .catch(() => {});
      fetchCron()
        .then(setCron)
        .catch(() => {});
      fetchActivity()
        .then(setActivity)
        .catch(() => {});
      fetchMemoryNotes({ limit: 30 })
        .then((r) => setNotes(Array.isArray(r) ? r : []))
        .catch(() => {});
    };
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const items = buildFeed({ runs, tasks, explore, cron, activity, notes });
  return { items };
}

function buildFeed(sources: {
  runs: WorkflowRunRow[];
  tasks: ProjectTask[];
  explore: ExploratoryRun[];
  cron: CronData | null;
  activity: SessionActivity[];
  notes: MemoryNote[];
}): FeedItem[] {
  const cutoff = Date.now() - WINDOW_MS;
  const items: FeedItem[] = [];

  // Workflow runs — completion (or start, if still running) is the event.
  for (const r of sources.runs) {
    const stamp = r.completed_at ?? r.started_at;
    const at = parseTime(stamp);
    if (!at) continue;
    const inFlight = r.status === "running" || r.status === "pending";
    items.push({
      key: `wf-${r.id}`,
      at,
      kind: "workflow",
      text: `${r.workflow_name} ${workflowVerb(r.status)}`,
      href: `#/workflow-runs/${encodeURIComponent(r.id)}`,
      inFlight,
    });
  }

  // Project tasks — surface recent status transitions by updated_at.
  for (const t of sources.tasks) {
    const at = parseTime(t.updated_at);
    if (!at) continue;
    items.push({
      key: `task-${t.id}`,
      at,
      kind: "task",
      text: `${t.title} · ${t.status}`,
      href: `#/tasks/${encodeURIComponent(t.id)}`,
    });
  }

  // Exploratory (autopilot) runs — the agent poking around on its own.
  for (const e of sources.explore) {
    const stamp = e.ended_at ?? e.started_at;
    const at = parseTime(stamp);
    if (!at) continue;
    const inFlight = e.status === "running" && !e.ended_at;
    items.push({
      key: `explore-${e.id}`,
      at,
      kind: "explore",
      text: inFlight ? `${e.agent_name} exploring…` : e.summary?.trim() || `${e.agent_name} explored (${e.status})`,
      href: `#/exploratory/runs/${encodeURIComponent(e.id)}`,
      inFlight,
    });
  }

  // Cron jobs — last fired time per job (when recorded).
  for (const j of sources.cron?.jobs ?? []) {
    const at = parseTime(j.last_run);
    if (!at) continue;
    items.push({
      key: `cron-${j.name}-${j.last_run}`,
      at,
      kind: "cron",
      text: `${j.name} ran`,
    });
  }

  // Session activity — last touched conversations.
  for (const a of sources.activity) {
    const at = parseTime(a.lastActivity);
    if (!at) continue;
    const who = a.agentName ?? "assistant";
    items.push({
      key: `act-${who}-${a.lastActivity}`,
      at,
      kind: "session",
      text: a.description?.trim() || `${who} ${a.status}`,
    });
  }

  // Memory notes — collapse a burst of notes (added within MEMORY_BURST_MS of
  // each other) into ONE digest row instead of a dozen individual lines. The
  // row's `details` carries the first line of each note for inline expansion.
  for (const burst of groupMemoryBursts(sources.notes)) {
    const at = burst.at;
    const n = burst.notes.length;
    items.push({
      key: `mem-${burst.notes[0].id}-${n}`,
      at,
      kind: "memory",
      text: `memory · ${n} note${n === 1 ? "" : "s"} added`,
      details: burst.notes.map((note) => firstLine(note.content)),
    });
  }

  // Last 24h only.
  const recent = items.filter((it) => it.at.getTime() >= cutoff);

  // Dedupe by key (keep the first seen).
  const seen = new Set<string>();
  const deduped = recent.filter((it) => {
    if (seen.has(it.key)) return false;
    seen.add(it.key);
    return true;
  });

  // In-flight items pin to the top; otherwise reverse-chronological. Coerce
  // inFlight to boolean — comparing `false !== undefined` makes the comparator
  // inconsistent and scrambles the whole sort.
  deduped.sort((a, b) => {
    const aLive = Boolean(a.inFlight);
    const bLive = Boolean(b.inFlight);
    if (aLive !== bLive) return aLive ? -1 : 1;
    return b.at.getTime() - a.at.getTime();
  });
  return deduped.slice(0, CAP);
}

/**
 * Collapse memory notes into time-clustered bursts. Notes are sorted newest
 * first; a new burst starts whenever the gap to the previous note exceeds
 * MEMORY_BURST_MS. Each burst is stamped with its newest note's time.
 */
function groupMemoryBursts(notes: MemoryNote[]): Array<{ at: Date; notes: MemoryNote[] }> {
  const dated = notes
    .map((n) => ({ n, at: parseTime(n.created_at) }))
    .filter((x): x is { n: MemoryNote; at: Date } => x.at !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const bursts: Array<{ at: Date; notes: MemoryNote[] }> = [];
  for (const { n, at } of dated) {
    const last = bursts[bursts.length - 1];
    if (last && last.at.getTime() - at.getTime() <= MEMORY_BURST_MS) {
      last.notes.push(n);
    } else {
      bursts.push({ at, notes: [n] });
    }
  }
  return bursts;
}

function firstLine(content: string): string {
  const line = content.split("\n").find((l) => l.trim()) ?? content;
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
}

/** ISO-like timestamp with no zone designator (SQLite's `YYYY-MM-DD HH:MM:SS`). */
const NO_ZONE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

export function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  // The server stores UTC, but SQLite timestamps carry no zone marker and JS
  // parses bare strings as LOCAL time — skewing rows by the UTC offset and
  // breaking sort + day grouping. No explicit zone → treat as UTC.
  const d = NO_ZONE.test(value) ? new Date(`${value.replace(" ", "T")}Z`) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function workflowVerb(status: WorkflowRunRow["status"]): string {
  switch (status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "running":
    case "pending":
      return "running";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "cancelled";
    default:
      return status;
  }
}
