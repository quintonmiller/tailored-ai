import { useEffect, useState } from "react";
import {
  type CronData,
  type ExploratoryRun,
  fetchActivity,
  fetchCron,
  fetchExploratoryRuns,
  fetchProjectTasks,
  fetchWorkflowRuns,
  type ProjectTask,
  type SessionActivity,
  type WorkflowRunRow,
} from "../api";

/** Kind tags the row so the UI can pick an accent/verb; purely cosmetic. */
export type FeedKind = "workflow" | "task" | "explore" | "cron" | "session";

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
}

const POLL_MS = 15000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CAP = 12;

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
    };
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, []);

  const items = buildFeed({ runs, tasks, explore, cron, activity });
  return { items };
}

function buildFeed(sources: {
  runs: WorkflowRunRow[];
  tasks: ProjectTask[];
  explore: ExploratoryRun[];
  cron: CronData | null;
  activity: SessionActivity[];
}): FeedItem[] {
  const cutoff = Date.now() - WINDOW_MS;
  const items: FeedItem[] = [];

  // Workflow runs — completion (or start, if still running) is the event.
  for (const r of sources.runs) {
    const stamp = r.completed_at ?? r.started_at;
    const at = parseTime(stamp);
    if (!at) continue;
    items.push({
      key: `wf-${r.id}`,
      at,
      kind: "workflow",
      text: `${r.workflow_name} ${workflowVerb(r.status)}`,
      href: `#/workflow-runs/${encodeURIComponent(r.id)}`,
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
    items.push({
      key: `explore-${e.id}`,
      at,
      kind: "explore",
      text: e.summary?.trim() || `${e.agent_name} explored (${e.status})`,
      href: `#/exploratory/runs/${encodeURIComponent(e.id)}`,
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

  // Last 24h only.
  const recent = items.filter((it) => it.at.getTime() >= cutoff);

  // Dedupe by key (keep the first seen).
  const seen = new Set<string>();
  const deduped = recent.filter((it) => {
    if (seen.has(it.key)) return false;
    seen.add(it.key);
    return true;
  });

  deduped.sort((a, b) => b.at.getTime() - a.at.getTime());
  return deduped.slice(0, CAP);
}

function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
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
