import type Database from "better-sqlite3";
import {
  addTaskComment,
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  queryProjectTasks,
  updateProjectTask,
  type TaskQueryFilter,
} from "../db/task-queries.js";
import { getDefaultProjectId } from "../db/project-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export class TasksTool implements Tool {
  name = "tasks";
  description =
    "Manage project tasks. Actions: create, get, update, delete, comment. Changing status via update REQUIRES a `comment` explaining why.";
  parameters = {
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
        description: "Status: backlog, in_progress, blocked, in_review, done, archived.",
      },
      author: { type: "string", description: "Author name." },
      tags: { type: "string", description: "Comma-separated tags." },
      text: { type: "string", description: "Comment text (for comment action)." },
      comment: {
        type: "string",
        description:
          "Required when update changes status. Short note explaining what you did or why you're blocked.",
      },
      project_id: { type: "string", description: "Project ID (for create)." },
      assignee: { type: "string", description: "Assignee name (agent or user)." },
      rank: { type: "number", description: "Rank in backlog — lower = higher priority." },
      blocked_reason: { type: "string", description: "Reason when status=blocked (e.g. question, budget)." },
    },
    required: ["action"],
  };

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
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
          return this.create(
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
          return this.get(id);
        case "update":
          return this.update(
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
          );
        case "delete":
          return this.delete(id);
        case "comment":
          return this.comment(id, text, authorArg ?? agentAuthor);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private create(
    title?: string,
    description?: string,
    author?: string,
    tags?: string,
    status?: string,
    projectId?: string,
    assignee?: string,
    rank?: number,
  ): ToolResult {
    if (!title) return { success: false, output: "", error: "title is required for create." };

    const resolvedProjectId = projectId ?? getDefaultProjectId(this.db);
    const parsedTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const task = createProjectTask(this.db, {
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

    return { success: true, output: lines.join("\n") };
  }

  private get(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for get." };

    const task = getProjectTask(this.db, id);
    if (!task) return { success: false, output: "", error: `Task ${id} not found.` };

    const lines = [
      `${task.title} (${task.id})`,
      `Status: ${task.status}`,
    ];
    if (task.assignee) lines.push(`Assignee: ${task.assignee}`);
    if (task.author) lines.push(`Author: ${task.author}`);
    if (task.rank) lines.push(`Rank: ${task.rank}`);
    if (task.blocked_reason) lines.push(`Blocked reason: ${task.blocked_reason}`);
    if (task.tags.length) lines.push(`Tags: ${task.tags.join(", ")}`);
    if (task.description) lines.push(`\n${task.description}`);
    if (task.comments.length > 0) {
      lines.push(`\nComments (${task.comments.length}):`);
      for (const c of task.comments) {
        const prefix = c.author ? `[${c.author}]` : "";
        lines.push(`  ${prefix} ${c.content}`);
      }
    }

    return { success: true, output: lines.join("\n") };
  }

  private update(
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
  ): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for update." };

    // If the caller is changing status, require a comment explaining why.
    // This is how the teammate audit trail is built.
    const existing = getProjectTask(this.db, id);
    if (!existing) return { success: false, output: "", error: `Task ${id} not found.` };

    const statusChanging = status !== undefined && status !== existing.status;
    const trimmedComment = commentText?.trim();

    if (statusChanging && !trimmedComment) {
      return {
        success: false,
        output: "",
        error:
          "Status changes require a `comment` explaining the transition. Call again with comment=\"...\" describing what you did (or why you're blocked).",
      };
    }

    const parsedTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;

    // Post the comment FIRST so it appears before the status change in the log.
    if (trimmedComment) {
      addTaskComment(this.db, id, {
        content: trimmedComment,
        author: author ?? agentAuthor ?? "agent",
      });
    }

    const task = updateProjectTask(this.db, id, {
      title: title ?? undefined,
      description: description ?? undefined,
      status: status ?? undefined,
      author: author ?? undefined,
      tags: parsedTags,
      assignee: assignee !== undefined ? assignee || null : undefined,
      rank,
      blocked_reason: blockedReason !== undefined ? blockedReason || null : undefined,
    });

    if (!task) return { success: false, output: "", error: `Task ${id} not found.` };
    return { success: true, output: `Updated task "${task.title}" (${task.id}) — status: ${task.status}` };
  }

  private delete(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for delete." };

    const deleted = deleteProjectTask(this.db, id);
    if (!deleted) return { success: false, output: "", error: `Task ${id} not found.` };
    return { success: true, output: `Deleted task ${id}.` };
  }

  private comment(id?: string, text?: string, author?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for comment." };
    if (!text) return { success: false, output: "", error: "text is required for comment." };

    const comment = addTaskComment(this.db, id, { content: text, author });
    if (!comment) return { success: false, output: "", error: `Task ${id} not found.` };
    return { success: true, output: `Added comment to task ${id}.` };
  }
}

export class TaskQueryTool implements Tool {
  name = "task_query";
  description = "Search and filter project tasks. Call with no args to list recent tasks.";
  parameters = {
    type: "object",
    properties: {
      status: {
        type: "string",
        description: "Filter by status (comma-separated for multiple).",
      },
      author: { type: "string", description: "Filter by author." },
      assignee: { type: "string", description: "Filter by assignee (agent or user)." },
      tags: { type: "string", description: "Filter by tags (comma-separated, any match)." },
      updated_after: { type: "string", description: "ISO datetime — only tasks updated after this." },
      search: { type: "string", description: "Search title and description." },
      project_id: { type: "string", description: "Filter by project ID." },
      order_by: { type: "string", description: "Ordering: 'rank' or 'updated_at' (default)." },
      limit: { type: "number", description: "Max results (default 20)." },
    },
    required: [],
  };

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    try {
      const filter: TaskQueryFilter = {};

      if (args.status) {
        const s = (args.status as string).split(",").map((v) => v.trim()).filter(Boolean);
        filter.status = s.length === 1 ? s[0] : s;
      }
      if (args.author) filter.author = args.author as string;
      if (args.assignee) filter.assignee = (args.assignee ?? args.owner) as string;
      else if (args.owner) filter.assignee = args.owner as string;
      if (args.tags) {
        filter.tags = (args.tags as string).split(",").map((t) => t.trim()).filter(Boolean);
      }
      if (args.updated_after) filter.updatedAfter = args.updated_after as string;
      if (args.search) filter.search = args.search as string;
      if (args.project_id) filter.project_id = args.project_id as string;
      if (args.order_by === "rank") filter.orderBy = "rank";
      filter.limit = typeof args.limit === "number" ? args.limit : 20;

      const { tasks, total } = queryProjectTasks(this.db, filter);

      if (tasks.length === 0) {
        return { success: true, output: "No tasks found." };
      }

      const lines = [`${total} task(s) found${tasks.length < total ? ` (showing ${tasks.length})` : ""}:\n`];
      for (const t of tasks) {
        const tagStr = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
        const assigneeStr = t.assignee ? ` @${t.assignee}` : "";
        lines.push(`- ${t.title} (${t.id}) — ${t.status}${assigneeStr}${tagStr}`);
      }

      return { success: true, output: lines.join("\n") };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}
