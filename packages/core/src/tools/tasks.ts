import type Database from "better-sqlite3";
import { getDefaultProjectId } from "../db/project-queries.js";
import type { EventBus } from "../events.js";
import type { Task, TaskBackend, TaskFilter, TaskUpdateInput } from "../tasks/interface.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/** Full status list for a backend: the four normalized values plus any extras the backend declares. */
function collectStatuses(backend: TaskBackend): string[] {
  const seen = new Set<string>(Object.values(backend.statuses));
  for (const s of backend.extraStatuses ?? []) seen.add(s);
  return [...seen];
}

/** Notify hook fired after a successful task mutation. The watcher uses it to
 *  re-trigger the routing pipeline so coder→reviewer and reviewer→coder
 *  handoffs work (docs/agent-unification.md, Phase 6).
 *
 *  `projectId` carries the routing key when the task lives on a per-project
 *  backend (PR #123). The watcher uses it to look up the task via the right
 *  backend — without it, the lookup falls back to the default backend, which
 *  is the bug that left gh-* tasks orphaned. */
export type TasksToolNotify = (action: "created" | "updated" | "commented", taskId: string, projectId?: string) => void;

/** Resolves the task backend to use for a given project. When no projectId
 *  is given (or it's null), returns the default (top-level) backend. Lets a
 *  single agent file/update tasks across multiple project-scoped trackers
 *  in one invocation. */
export type TaskBackendResolver = (projectId?: string | null) => TaskBackend;

/** Internal helper: turn a single backend into a resolver that ignores
 *  projectId. Used so existing single-backend callers can keep working. */
function singleBackendResolver(backend: TaskBackend): TaskBackendResolver {
  return () => backend;
}

/** Internal helper: accept either a TaskBackend (legacy) or a resolver. */
function asResolver(arg: TaskBackend | TaskBackendResolver): TaskBackendResolver {
  // A TaskBackend has a `name` string + `create` function. A resolver is a
  // plain function. Distinguish by the `name` property's type.
  if (typeof arg === "function") return arg as TaskBackendResolver;
  return singleBackendResolver(arg);
}

/** Options bag for {@link TasksTool}. Kept distinct from the positional
 *  notify/db args so future additions don't keep widening the constructor.
 *  Slice 2 of the platform vision (`docs/platform-vision.md`) adds the
 *  events bus here: the tool emits `task.*` lifecycle events alongside the
 *  legacy notify callback, so plugins can subscribe without reaching into
 *  the watcher. */
export interface TasksToolOptions {
  /** Event bus used to emit `task.created` / `task.updated` /
   *  `task.transitioned` / `task.commented`. Optional so existing callers
   *  (and tests) keep working — when absent, no events fire. */
  events?: EventBus;
}

export class TasksTool implements Tool {
  name = "tasks";
  description: string;
  parameters: Record<string, unknown>;

  private resolveBackend: TaskBackendResolver;
  /** The backend used to build the tool description + status enum. Usually
   *  the default (no-project) backend. */
  private defaultBackend: TaskBackend;
  private db: Database.Database | undefined;
  private validStatuses: Set<string>;
  private notify?: TasksToolNotify;
  private events?: EventBus;

  constructor(
    backendOrResolver: TaskBackend | TaskBackendResolver,
    db?: Database.Database,
    notify?: TasksToolNotify,
    opts?: TasksToolOptions,
  ) {
    this.resolveBackend = asResolver(backendOrResolver);
    this.defaultBackend = this.resolveBackend(undefined);
    const backend = this.defaultBackend;
    this.db = db;
    this.notify = notify;
    this.events = opts?.events;

    const statusList = collectStatuses(backend);
    this.validStatuses = new Set(statusList);
    const statusEnum = statusList.join(", ");

    this.description = `Manage one task at a time (backend: ${backend.name}). Actions: create, get, update, delete, comment. Changing status via update REQUIRES a \`comment\` explaining why. NOTE: there is no \`list\` action here — to list / search / filter tasks, use the separate \`task_query\` tool.`;

    this.parameters = {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: create, get, update, delete, comment.",
        },
        id: { type: "string", description: "Task ID (for get, update, delete, comment)." },
        title: { type: "string", description: "Task title (for create, update)." },
        description: { type: "string", description: "Task description (for create, update)." },
        status: {
          type: "string",
          description: `Status: ${statusEnum}.`,
          enum: statusList,
        },
        author: { type: "string", description: "Author name." },
        tags: { type: "string", description: "Comma-separated tags." },
        text: { type: "string", description: "Comment text (for comment action)." },
        comment: {
          type: "string",
          description: "Required when update changes status. Short note explaining what you did or why you're blocked.",
        },
        project_id: {
          type: "string",
          description: "Project ID (for create, or to move a task to a different project via update).",
        },
        assignee: { type: "string", description: "Assignee name (agent or user)." },
        rank: { type: "number", description: "Rank in backlog — lower = higher priority." },
        blocked_reason: { type: "string", description: "Reason when status=blocked (e.g. question, budget)." },
      },
      required: ["action"],
    };
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) return { success: false, output: "", error: "No action provided." };

    // Accept common aliases for local model compatibility
    const id = (args.id ?? args.task_id) as string | undefined;
    const title = (args.title ?? args.name) as string | undefined;
    const text = (args.text ?? args.content) as string | undefined;
    const projectId = (args.project_id ?? args.projectId) as string | undefined;
    const assignee = (args.assignee ?? args.owner) as string | undefined;
    const rankRaw = args.rank ?? args.order;
    const rank = typeof rankRaw === "number" ? rankRaw : undefined;
    const blockedReason = (args.blocked_reason ?? args.blockedReason) as string | undefined;
    const comment = (args.comment ?? args.reason) as string | undefined;
    const authorArg = args.author as string | undefined;
    const agentAuthor = context.agentName ?? "agent";

    try {
      switch (action) {
        case "create":
          return await this.create(
            title,
            args.description as string | undefined,
            authorArg,
            args.tags as string | undefined,
            args.status as string | undefined,
            projectId,
            assignee,
            rank,
          );
        case "get":
          return await this.get(id, projectId);
        case "update":
          return await this.update(
            id,
            title,
            args.description as string | undefined,
            args.status as string | undefined,
            authorArg,
            args.tags as string | undefined,
            assignee,
            rank,
            blockedReason,
            comment ?? text,
            agentAuthor,
            projectId,
          );
        case "delete":
          return await this.delete(id, projectId);
        case "comment":
          return await this.comment(id, text, authorArg ?? agentAuthor, projectId);
        default:
          return {
            success: false,
            output: "",
            error: `Unknown action "${action}". Valid actions: create, get, update, delete, comment.`,
          };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private async create(
    title?: string,
    description?: string,
    author?: string,
    tags?: string,
    status?: string,
    projectId?: string,
    assignee?: string,
    rank?: number,
  ): Promise<ToolResult> {
    if (!title) return { success: false, output: "", error: "title is required for create." };

    const backend = this.resolveBackend(projectId);
    if (status !== undefined && !this.validStatuses.has(status)) {
      return {
        success: false,
        output: "",
        error: `Invalid status "${status}" for ${backend.name} backend. Valid: ${[...this.validStatuses].join(", ")}.`,
      };
    }

    const resolvedProjectId = projectId ?? (this.db ? getDefaultProjectId(this.db) : undefined);
    const parsedTags = tags
      ? tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    const task = await backend.create({
      title,
      description,
      author,
      tags: parsedTags,
      status,
      project_id: resolvedProjectId,
      assignee: assignee ?? null,
      rank,
    });

    const lines = [
      `Created task "${task.title}" (${task.id})`,
      `Status: ${task.status} | Rank: ${task.rank}${task.assignee ? ` | Assignee: ${task.assignee}` : ""}`,
    ];
    if (task.tags.length) lines.push(`Tags: ${task.tags.join(", ")}`);

    this.notify?.("created", task.id, projectId);
    this.events?.emit("task.created", { taskId: task.id, projectId });
    return { success: true, output: lines.join("\n") };
  }

  private async get(id?: string, projectId?: string): Promise<ToolResult> {
    if (!id) return { success: false, output: "", error: "id is required for get." };

    const backend = this.resolveBackend(projectId);
    const task = await backend.get(id);
    if (!task) return { success: false, output: "", error: `Task ${id} not found.` };

    const lines = [`${task.title} (${task.id})`, `Status: ${task.status}`];
    if (task.assignee) lines.push(`Assignee: ${task.assignee}`);
    if (task.author) lines.push(`Author: ${task.author}`);
    if (task.rank) lines.push(`Rank: ${task.rank}`);
    if (task.blocked_reason) lines.push(`Blocked reason: ${task.blocked_reason}`);
    if (task.tags.length) lines.push(`Tags: ${task.tags.join(", ")}`);
    if (task.description) lines.push(`\n${task.description}`);
    const comments = task.comments ?? [];
    if (comments.length > 0) {
      lines.push(`\nComments (${comments.length}):`);
      for (const c of comments) {
        const prefix = c.author ? `[${c.author}]` : "";
        lines.push(`  ${prefix} ${c.content}`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  private async update(
    id?: string,
    title?: string,
    description?: string,
    status?: string,
    author?: string,
    tags?: string,
    assignee?: string,
    rank?: number,
    blockedReason?: string,
    commentText?: string,
    agentAuthor?: string,
    projectId?: string,
  ): Promise<ToolResult> {
    if (!id) return { success: false, output: "", error: "id is required for update." };

    const backend = this.resolveBackend(projectId);
    if (status !== undefined && !this.validStatuses.has(status)) {
      return {
        success: false,
        output: "",
        error: `Invalid status "${status}" for ${backend.name} backend. Valid: ${[...this.validStatuses].join(", ")}.`,
      };
    }

    // If the caller is changing status, require a comment explaining why.
    // This is how the teammate audit trail is built.
    const existing = await backend.get(id);
    if (!existing) return { success: false, output: "", error: `Task ${id} not found.` };

    const statusChanging = status !== undefined && status !== existing.status;
    const trimmedComment = commentText?.trim();

    if (statusChanging && !trimmedComment) {
      return {
        success: false,
        output: "",
        error:
          'Status changes require a `comment` explaining the transition. Call again with comment="..." describing what you did (or why you\'re blocked).',
      };
    }

    // Validate target project exists when moving a task to a different project
    if (projectId !== undefined && this.db) {
      const project = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
      if (!project) {
        return {
          success: false,
          output: "",
          error: `Project "${projectId}" does not exist. Task cannot be moved to a non-existent project.`,
        };
      }
    }

    const parsedTags = tags
      ? tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    // Post the comment FIRST so it appears before the status change in the log.
    if (trimmedComment) {
      await backend.comment(id, trimmedComment, author ?? agentAuthor ?? "agent");
    }

    const task = await backend.update(id, {
      title: title ?? undefined,
      description: description ?? undefined,
      status: status ?? undefined,
      author: author ?? undefined,
      tags: parsedTags,
      assignee: assignee !== undefined ? assignee || null : undefined,
      rank,
      blocked_reason: blockedReason !== undefined ? blockedReason || null : undefined,
      project_id: projectId !== undefined ? projectId || null : undefined,
    });

    if (!task) return { success: false, output: "", error: `Task ${id} not found.` };
    this.notify?.("updated", task.id, projectId);

    // Diff existing → task to figure out what actually changed. `task.updated`
    // carries a generic change list; status transitions also fan out a
    // separate `task.transitioned` so subscribers interested only in state
    // moves don't have to filter the full update stream.
    if (this.events) {
      const changes = diffTaskFields(existing, task);
      if (changes.length > 0) {
        this.events.emit("task.updated", { taskId: task.id, projectId, changes });
      }
      if (statusChanging && task.status !== existing.status) {
        this.events.emit("task.transitioned", {
          taskId: task.id,
          projectId,
          from: existing.status,
          to: task.status,
          assignee: task.assignee,
        });
      }
      if (trimmedComment) {
        this.events.emit("task.commented", {
          taskId: task.id,
          projectId,
          author: author ?? agentAuthor ?? "agent",
        });
      }
    }
    return { success: true, output: `Updated task "${task.title}" (${task.id}) — status: ${task.status}` };
  }

  private async delete(id?: string, projectId?: string): Promise<ToolResult> {
    if (!id) return { success: false, output: "", error: "id is required for delete." };

    const backend = this.resolveBackend(projectId);
    const deleted = await backend.delete(id);
    if (!deleted) return { success: false, output: "", error: `Task ${id} not found.` };
    return { success: true, output: `Deleted task ${id}.` };
  }

  private async comment(id?: string, text?: string, author?: string, projectId?: string): Promise<ToolResult> {
    if (!id) return { success: false, output: "", error: "id is required for comment." };
    if (!text) return { success: false, output: "", error: "text is required for comment." };

    const backend = this.resolveBackend(projectId);
    const comment = await backend.comment(id, text, author);
    if (!comment) return { success: false, output: "", error: `Task ${id} not found.` };
    this.notify?.("commented", id, projectId);
    this.events?.emit("task.commented", { taskId: id, projectId, author: comment.author || author });
    return { success: true, output: `Added comment to task ${id}.` };
  }
}

/** Field-level diff of two task snapshots. Returns the list of `TaskUpdateInput`
 *  field names that changed. Used by `task.updated` to tell subscribers which
 *  fields mutated without forcing them to compare snapshots themselves. */
function diffTaskFields(before: Task, after: Task): string[] {
  const changes: string[] = [];
  const compare = <K extends keyof TaskUpdateInput & keyof Task>(field: K) => {
    if (before[field] !== after[field]) changes.push(field);
  };
  compare("title");
  compare("description");
  compare("status");
  compare("author");
  compare("assignee");
  compare("rank");
  compare("blocked_reason");
  compare("project_id");
  // Tags are an array — JSON.stringify is good enough for an order-stable diff
  // given backends normalize order on read.
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) changes.push("tags");
  return changes;
}

/**
 * Whose task this is, in words, from the reader's point of view.
 *
 * Always says something. Silence about ownership reads as "unowned, therefore
 * available, therefore probably mine".
 */
export function describeOwner(assignee: string | null | undefined, reader?: string): string {
  const owner = assignee?.trim();
  if (!owner) return "unassigned (not yours)";
  if (reader && owner.toLowerCase() === reader.toLowerCase()) return "yours";
  return `assigned to ${owner}`;
}

export class TaskQueryTool implements Tool {
  name = "task_query";
  description =
    'List, search, and filter project tasks across all statuses. Use this — not the `tasks` tool — for any read across multiple tasks. For example, `task_query(mine=true)` is what YOU are working on; `task_query(status="backlog", limit=10)` lists the top 10 pending tasks across everyone.';
  parameters = {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status (comma-separated for multiple).",
      },
      author: { type: "string", description: "Filter by author." },
      assignee: { type: "string", description: "Filter by assignee (agent or user)." },
      mine: {
        type: "boolean",
        description: "Only tasks assigned to you. Use this to answer what YOU are working on.",
      },
      tags: { type: "string", description: "Filter by tags (comma-separated, any match)." },
      updated_after: { type: "string", description: "ISO datetime — only tasks updated after this." },
      search: { type: "string", description: "Search title and description." },
      project_id: { type: "string", description: "Filter by project ID." },
      order_by: { type: "string", description: "Ordering: 'rank' or 'updated_at' (default)." },
      limit: { type: "number", description: "Max results (default 20)." },
    },
    required: [],
  };

  private resolveBackend: TaskBackendResolver;

  constructor(backendOrResolver: TaskBackend | TaskBackendResolver) {
    this.resolveBackend = asResolver(backendOrResolver);
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    try {
      const filter: TaskFilter = {};

      // "What am I working on" needs an answer grounded in something. A room
      // session cannot supply it — sessions are per (room, agent), so an agent
      // added to a new room starts blank — which is how eleven agents came to
      // report the same two unassigned tasks as their own work.
      if (args.mine === true && context.agentName) {
        filter.assignee = context.agentName;
      }

      if (args.status) {
        const s = (args.status as string)
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        filter.status = s.length === 1 ? s[0] : s;
      }
      if (args.author) filter.author = args.author as string;
      if (args.assignee) filter.assignee = (args.assignee ?? args.owner) as string;
      else if (args.owner) filter.assignee = args.owner as string;
      if (args.tags) {
        filter.tags = (args.tags as string)
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (args.updated_after) filter.updatedAfter = args.updated_after as string;
      if (args.search) filter.search = args.search as string;
      if (args.project_id) filter.project_id = args.project_id as string;
      if (args.order_by === "rank") filter.orderBy = "rank";
      filter.limit = typeof args.limit === "number" ? args.limit : 20;

      // project_id on the filter is also the routing key — different
      // projects can live on different task backends.
      const backend = this.resolveBackend(filter.project_id ?? null);
      const { tasks, total } = await backend.query(filter);

      if (tasks.length === 0) {
        return { success: true, output: "No tasks found." };
      }

      const lines = [`${total} task(s) found${tasks.length < total ? ` (showing ${tasks.length})` : ""}:\n`];
      for (const t of tasks) {
        const tagStr = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
        // Ownership is stated on every line, including when there is none.
        // Rendering an unassigned task as bare text made "no assignee" look
        // like "no information", and an agent reading an in-progress task with
        // nothing next to it has no reason to think it is not its own.
        lines.push(`- ${t.title} (${t.id}) — ${t.status} · ${describeOwner(t.assignee, context.agentName)}${tagStr}`);
      }

      return { success: true, output: lines.join("\n") };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}
