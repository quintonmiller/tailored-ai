/**
 * What is waiting on you in the world, worked out from what the page already
 * has: what each agent is doing (its `activity` record), the approvals the
 * server can answer (`GET /api/approvals`), and the tasks on the boards. Pure,
 * so the world's `!` over a head, its "Needs you" list and the map's "Busy
 * now" all say the same thing, and it is tested without a page.
 */
import type { PendingApprovalRequest, TaskComment } from "../api";
import type { AgentActivity } from "../avatar/doing";
import { whenMs } from "./tasks";

/** A task as this needs it: where it stands and whose it is. */
export interface NeedTask {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  blocked_reason: string | null;
  updated_at: string;
}

/** Something one agent is waiting on you for. */
export interface Need {
  /** The same for as long as it waits: `approval:<request>`, `task:<id>`, or `ask:<agent>`. */
  key: string;
  agent: string;
  /** Your OK on a tool call, or an answer to a question (on a task, or not). */
  kind: "approval" | "question";
  /** What it wants, in a few words: "waiting for your OK", "has a question for you". */
  what: string;
  /** More about it, when there is, in a few words: the question, or what a task needs. */
  detail?: string;
  /** The question in full, when it was cut short for `detail`. */
  question?: string;
  /** When it started waiting. */
  since?: string;
  /** The tool it wants to use. */
  tool?: string;
  /** The approval request it waits on. */
  request?: string;
  /** That request as the server lists it, when this page can answer it: what the Approve button decides. */
  approval?: PendingApprovalRequest;
  /** The task it is about. */
  task?: string;
}

/** A question a task is blocked on for you. */
const QUESTION = "question";

/**
 * What every agent is doing, as the world shows it, once the tasks are in: an
 * agent waiting on you about a task that has since moved on (answered on the
 * Tasks page, or here) waits no longer, and an idle agent with a task blocked
 * on a question for you is waiting on you, though the turn that asked has
 * long ended or the server has restarted since. The same object when nothing
 * changes.
 */
export function withQuestions(
  activities: Record<string, AgentActivity>,
  tasks: NeedTask[],
): Record<string, AgentActivity> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  let out: Record<string, AgentActivity> | undefined;
  const put = (agent: string, a: AgentActivity) => {
    out ??= { ...activities };
    out[agent] = a;
  };
  for (const [agent, a] of Object.entries(activities)) {
    const task = a.doing === "waiting" && a.task ? byId.get(a.task) : undefined;
    if (task && task.status !== "blocked")
      put(agent, { agent, doing: "idle", what: "idle", ...(a.since ? { since: a.since } : {}) });
  }
  // The server sends the most recently changed first: an agent with several questions shows the latest.
  for (const t of tasks) {
    if (!t.assignee || t.status !== "blocked" || t.blocked_reason !== QUESTION) continue;
    const now = (out ?? activities)[t.assignee];
    if (now && now.doing !== "idle") continue;
    put(t.assignee, {
      agent: t.assignee,
      doing: "waiting",
      what: "has a question for you",
      detail: t.title,
      task: t.id,
      since: t.updated_at,
    });
  }
  return out ?? activities;
}

/**
 * Longest waiting first, the way both the list and the map's "Busy now" rank
 * those waiting on you: an approval before a question, since a turn is held
 * open for it and gives up after a while; then whoever has waited longer.
 */
export function byWait(a: { request?: string; since?: string }, b: { request?: string; since?: string }): number {
  const kind = (x: { request?: string }) => (x.request ? 0 : 1);
  const when = (x: { since?: string }) => {
    const ms = whenMs(x.since);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  };
  return kind(a) - kind(b) || when(a) - when(b);
}

/**
 * Everything waiting on you, one row per request: each agent waiting (an
 * approval, with its details when the server can answer it here; a question
 * on a task; a question asked anywhere else), and every task blocked on a
 * question for you that its agent isn't already waiting on. Ranked by
 * `byWait`, then by agent.
 */
export function needsFrom(
  activities: Record<string, AgentActivity>,
  approvals: PendingApprovalRequest[],
  tasks: NeedTask[],
): Need[] {
  const out: Need[] = [];
  const seen = new Set<string>();
  for (const [agent, a] of Object.entries(activities)) {
    if (a.doing !== "waiting") continue;
    const base = {
      agent,
      what: a.what,
      ...(a.detail ? { detail: a.detail } : {}),
      ...(a.question ? { question: a.question } : {}),
      ...(a.since ? { since: a.since } : {}),
      ...(a.tool ? { tool: a.tool } : {}),
    };
    let need: Need;
    if (a.request) {
      const approval = approvals.find((r) => r.requestId === a.request);
      need = {
        ...base,
        key: `approval:${a.request}`,
        kind: "approval",
        request: a.request,
        ...(approval ? { approval } : {}),
      };
    } else if (a.task) need = { ...base, key: `task:${a.task}`, kind: "question", task: a.task };
    else need = { ...base, key: `ask:${agent}`, kind: "question" };
    seen.add(need.key);
    out.push(need);
  }
  for (const t of tasks) {
    if (!t.assignee || t.status !== "blocked" || t.blocked_reason !== QUESTION || seen.has(`task:${t.id}`)) continue;
    seen.add(`task:${t.id}`);
    out.push({
      key: `task:${t.id}`,
      agent: t.assignee,
      kind: "question",
      what: "has a question for you",
      detail: t.title,
      since: t.updated_at,
      task: t.id,
    });
  }
  return out.sort((a, b) => byWait(a, b) || a.agent.localeCompare(b.agent));
}

/**
 * Tools whose approval has a stricter flow of its own: the trusted-actions
 * executor's (purchases and the actions it runs behind a one-time token on
 * your phone), and anything named for spending money. Never approved from
 * the world, whatever the server would accept.
 */
const OWN_FLOW = new Set(["request_action", "purchase_item", "request_read"]);
const MONEY = new Set(["purchase", "purchases", "buy", "pay", "payment", "payments", "checkout", "order", "orders"]);

/** Whether a tool's approval belongs to a stricter flow than a click in the world. */
export function ownFlow(tool: string | undefined): boolean {
  if (!tool) return false;
  const name = tool.toLowerCase();
  return OWN_FLOW.has(name) || name.split(/[^a-z0-9]+/).some((word) => MONEY.has(word));
}

/**
 * Whether the world may offer Approve for a need: an approval whose details
 * this page has from the server (so the card shows exactly what is being
 * approved), for the very request the agent waits on, and not one with a
 * stricter flow of its own.
 */
export function answerable(need: Need): boolean {
  if (need.kind !== "approval" || !need.approval || !need.request) return false;
  if (need.approval.requestId !== need.request) return false;
  return !ownFlow(need.approval.toolName) && !ownFlow(need.tool);
}

/** How a question put on a task for you starts, as `ask_user` writes it. */
const ASKED = "**Question for user:**";

/**
 * The question a task is blocked on, from its comments: the latest one an
 * agent asked with `ask_user`, without its heading; failing that, `fallback`
 * (what the agent's activity said).
 */
export function questionIn(comments: Pick<TaskComment, "content">[], fallback?: string): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]?.content ?? "";
    if (c.startsWith(ASKED)) return c.slice(ASKED.length).trim() || fallback;
  }
  return fallback;
}

/** A need's request ids, for asking the server again only when they change. */
export function requestsOf(activities: Record<string, AgentActivity>): string {
  return Object.values(activities)
    .flatMap((a) => (a.doing === "waiting" && a.request ? [a.request] : []))
    .sort()
    .join(",");
}
