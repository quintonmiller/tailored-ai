import type Database from "better-sqlite3";
import { listTickLogs, type TickLogRow } from "../db/tick-log-queries.js";
import { queryProjectTasks } from "../db/task-queries.js";

/**
 * Real-time snapshot built at the start of every user chat turn
 * (see docs/agent-unification.md, Phase 3).
 *
 * Together with `core_memory` (the persistent identity layer), this is
 * what makes chat feel current — the agent's answer to *"what did you
 * just do?"* and *"what's coming up?"* lives here.
 *
 * Rebuilt fresh per turn (cheap; ~500 tokens) and stripped from prior
 * turns via the system-reminder pattern so it doesn't stack.
 */
export interface RecentTickEntry {
  tickId: string;
  kind: string;
  summary: string;
  at: string;
}

export interface InFlightSnapshot {
  inProgressTasks: Array<{ id: string; title: string; status: string }>;
  // Future: openDelegations, runningWorkflows. Need their backends to
  // expose "currently running" queries first.
}

export interface PendingSnapshot {
  topBacklog: Array<{ id: string; title: string; ageDays: number }>;
  // Future: pendingAsks, dueWorkflowsToday.
}

export interface ChatLiveState {
  agent: string;
  projectId: string | null;
  generatedAt: string;
  recentTicks: RecentTickEntry[];
  inFlight: InFlightSnapshot;
  pending: PendingSnapshot;
}

export interface BuildChatLiveStateOptions {
  /** How many recent material-or-delegate-or-workflow ticks to show. Default 5. */
  recentTickLimit?: number;
  /** Hours back to look for recent ticks. Default 6. */
  recentHoursBack?: number;
  /** How many backlog items to show. Default 5. */
  backlogLimit?: number;
  /** Override for "now" — testing only. */
  now?: () => Date;
}

export function buildChatLiveState(
  db: Database.Database,
  agent: string,
  projectId: string | null,
  opts: BuildChatLiveStateOptions = {},
): ChatLiveState {
  const now = (opts.now ?? (() => new Date()))();
  const recentTickLimit = opts.recentTickLimit ?? 5;
  const recentHoursBack = opts.recentHoursBack ?? 6;
  const backlogLimit = opts.backlogLimit ?? 5;

  // Recent ticks — only material/delegate/workflow, never noop. The point
  // is "here's what I did," not "here's how much I idled."
  const cutoff = new Date(now.getTime() - recentHoursBack * 3_600_000).toISOString();
  let rawTicks: TickLogRow[] = [];
  try {
    rawTicks = listTickLogs(db, {
      agent,
      kind: ["material", "delegate", "workflow"],
      since: cutoff,
      limit: recentTickLimit,
    });
  } catch {
    // Degrade silently.
  }
  const recentTicks: RecentTickEntry[] = rawTicks.map((r) => ({
    tickId: r.tick_id,
    kind: r.kind,
    summary: (r.summary ?? "").slice(0, 160),
    at: r.created_at,
  }));

  // In-flight — tasks currently in progress.
  let inProgress: Array<{ id: string; title: string; status: string }> = [];
  try {
    const inProg = queryProjectTasks(db, {
      status: "in_progress",
      project_id: projectId ?? undefined,
      orderBy: "updated_at",
      limit: 5,
    });
    inProgress = inProg.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status }));
  } catch {
    // Degrade silently.
  }

  // Pending — top backlog items.
  let topBacklog: Array<{ id: string; title: string; ageDays: number }> = [];
  try {
    const backlog = queryProjectTasks(db, {
      status: "backlog",
      project_id: projectId ?? undefined,
      orderBy: "updated_at",
      limit: backlogLimit,
    });
    topBacklog = backlog.tasks.map((t) => {
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - new Date(t.created_at).getTime()) / 86_400_000),
      );
      return { id: t.id, title: t.title, ageDays };
    });
  } catch {
    // Degrade silently.
  }

  return {
    agent,
    projectId,
    generatedAt: now.toISOString(),
    recentTicks,
    inFlight: { inProgressTasks: inProgress },
    pending: { topBacklog },
  };
}

/**
 * Render ChatLiveState into a prompt block. Sits below core_memory and
 * above recall hits in the system prompt. Empty sections are omitted —
 * a fresh agent with nothing in flight gets a tiny block.
 */
export function renderChatLiveState(state: ChatLiveState): string {
  const sections: string[] = [];

  if (state.recentTicks.length > 0) {
    const lines = ["**Recent ticks (last 6h):**"];
    for (const t of state.recentTicks) {
      const when = formatRelativeTime(t.at, state.generatedAt);
      lines.push(`- ${when} — ${t.summary || "(no summary)"}`);
    }
    sections.push(lines.join("\n"));
  }

  if (state.inFlight.inProgressTasks.length > 0) {
    const lines = ["**In-flight tasks:**"];
    for (const t of state.inFlight.inProgressTasks) {
      lines.push(`- ${t.id} \`${t.title}\``);
    }
    sections.push(lines.join("\n"));
  }

  if (state.pending.topBacklog.length > 0) {
    const lines = ["**Top backlog:**"];
    for (const t of state.pending.topBacklog) {
      lines.push(`- ${t.id} \`${t.title}\` (${t.ageDays}d)`);
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return "";

  // Prepend a "Now:" line so the time anchors the rendered block. Without
  // this, an agent reading "in-flight tasks" had no clock to reason from.
  // We only emit it when there's other content to avoid spamming an empty
  // block onto every chat turn — the autonomous tick-context block has its
  // own unconditional Now line.
  const now = new Date(state.generatedAt);
  const local = now.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
  return ["## Current state", "", `**Now:** ${local}  (UTC ${now.toISOString()})`, ...sections].join("\n\n");
}

function formatRelativeTime(at: string, now: string): string {
  // SQLite's datetime('now') emits 'YYYY-MM-DD HH:MM:SS' in UTC, no T or Z.
  // JS Date parses that as LOCAL time, which throws our delta off by the
  // local timezone offset. Tag as UTC if there's no explicit zone marker.
  const tagUtc = (s: string) => (/[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  const elapsed = new Date(tagUtc(now)).getTime() - new Date(tagUtc(at)).getTime();
  if (elapsed < 0) return "just now";
  const min = Math.floor(elapsed / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
