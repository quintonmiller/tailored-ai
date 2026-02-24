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
    "Manage project tasks. Actions: create, get, update, delete, comment. Use task_query to search/filter.";
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
      project_id: { type: "string", description: "Project ID (for create)." },
    },
    required: ["action"],
  };

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) return { success: false, output: "", error: "No action provided." };

    // Accept common aliases for local model compatibility
    const id = (args.id ?? args.task_id) as string | undefined;
    const title = (args.title ?? args.name) as string | undefined;
    const text = (args.text ?? args.content) as string | undefined;
    const projectId = (args.project_id ?? args.projectId) as string | undefined;

    try {
      switch (action) {
        case "create":
          return this.create(title, args.description as string | undefined, args.author as string | undefined, args.tags as string | undefined, args.status as string | undefined, projectId);
        case "get":
          return this.get(id);
        case "update":
          return this.update(id, title, args.description as string | undefined, args.status as string | undefined, args.author as string | undefined, args.tags as string | undefined);
        case "delete":
          return this.delete(id);
        case "comment":
          return this.comment(id, text, args.author as string | undefined);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private create(title?: string, description?: string, author?: string, tags?: string, status?: string, projectId?: string): ToolResult {
    if (!title) return { success: false, output: "", error: "title is required for create." };

    const resolvedProjectId = projectId ?? getDefaultProjectId(this.db);
    const parsedTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const task = createProjectTask(this.db, { title, description, author, tags: parsedTags, status, project_id: resolvedProjectId });

    return {
      success: true,
      output: `Created task "${task.title}" (${task.id})\nStatus: ${task.status}${task.tags.length ? `\nTags: ${task.tags.join(", ")}` : ""}`,
    };
  }

  private get(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for get." };

    const task = getProjectTask(this.db, id);
    if (!task) return { success: false, output: "", error: `Task ${id} not found.` };

    const lines = [
      `${task.title} (${task.id})`,
      `Status: ${task.status}`,
    ];
    if (task.author) lines.push(`Author: ${task.author}`);
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

  private update(id?: string, title?: string, description?: string, status?: string, author?: string, tags?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for update." };

    const parsedTags = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const task = updateProjectTask(this.db, id, {
      title: title ?? undefined,
      description: description ?? undefined,
      status: status ?? undefined,
      author: author ?? undefined,
      tags: parsedTags,
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
      tags: { type: "string", description: "Filter by tags (comma-separated, any match)." },
      updated_after: { type: "string", description: "ISO datetime — only tasks updated after this." },
      search: { type: "string", description: "Search title and description." },
      project_id: { type: "string", description: "Filter by project ID." },
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
      if (args.tags) {
        filter.tags = (args.tags as string).split(",").map((t) => t.trim()).filter(Boolean);
      }
      if (args.updated_after) filter.updatedAfter = args.updated_after as string;
      if (args.search) filter.search = args.search as string;
      if (args.project_id) filter.project_id = args.project_id as string;
      filter.limit = typeof args.limit === "number" ? args.limit : 20;

      const { tasks, total } = queryProjectTasks(this.db, filter);

      if (tasks.length === 0) {
        return { success: true, output: "No tasks found." };
      }

      const lines = [`${total} task(s) found${tasks.length < total ? ` (showing ${tasks.length})` : ""}:\n`];
      for (const t of tasks) {
        const tagStr = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
        const authorStr = t.author ? ` (${t.author})` : "";
        lines.push(`- ${t.title} (${t.id}) — ${t.status}${tagStr}${authorStr}`);
      }

      return { success: true, output: lines.join("\n") };
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }
}
