import type Database from "better-sqlite3";
import {
  createProject,
  deleteProject,
  getProject,
  queryProjects,
  updateProject,
} from "../db/project-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export class ProjectsTool implements Tool {
  name = "projects";
  description =
    "Manage projects. Actions: create, list, get, update, delete.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: create, list, get, update, delete.",
      },
      id: { type: "string", description: "Project ID (for get, update, delete)." },
      title: { type: "string", description: "Project title (for create, update)." },
      description: { type: "string", description: "Project description (for create, update)." },
      status: {
        type: "string",
        description: "Status: active, completed, archived.",
      },
      due_date: { type: "string", description: "Due date (ISO format, for create, update)." },
      search: { type: "string", description: "Search text (for list)." },
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

    // Accept common aliases
    const id = (args.id ?? args.project_id) as string | undefined;
    const title = (args.title ?? args.name) as string | undefined;

    try {
      switch (action) {
        case "create":
          return this.create(title, args.description as string | undefined, args.status as string | undefined, args.due_date as string | undefined);
        case "list":
          return this.list(args.status as string | undefined, args.search as string | undefined);
        case "get":
          return this.get(id);
        case "update":
          return this.update(id, title, args.description as string | undefined, args.status as string | undefined, args.due_date as string | undefined);
        case "delete":
          return this.remove(id);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private create(title?: string, description?: string, status?: string, due_date?: string): ToolResult {
    if (!title) return { success: false, output: "", error: "title is required for create." };

    const project = createProject(this.db, { title, description, status, due_date });
    return {
      success: true,
      output: `Created project "${project.title}" (${project.id})\nStatus: ${project.status}`,
    };
  }

  private list(status?: string, search?: string): ToolResult {
    const filter: { status?: string; search?: string } = {};
    if (status) filter.status = status;
    if (search) filter.search = search;

    const { projects, total } = queryProjects(this.db, filter);

    if (projects.length === 0) {
      return { success: true, output: "No projects found." };
    }

    const lines = [`${total} project(s) found:\n`];
    for (const p of projects) {
      lines.push(`- ${p.title} (${p.id}) — ${p.status} | ${p.task_count} tasks, ${p.document_count} docs`);
    }

    return { success: true, output: lines.join("\n") };
  }

  private get(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for get." };

    const project = getProject(this.db, id);
    if (!project) return { success: false, output: "", error: `Project ${id} not found.` };

    const lines = [
      `${project.title} (${project.id})`,
      `Status: ${project.status}`,
      `Tasks: ${project.task_count} | Documents: ${project.document_count}`,
    ];
    if (project.due_date) lines.push(`Due: ${project.due_date}`);
    if (project.description) lines.push(`\n${project.description}`);

    return { success: true, output: lines.join("\n") };
  }

  private update(id?: string, title?: string, description?: string, status?: string, due_date?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for update." };

    const project = updateProject(this.db, id, {
      title: title ?? undefined,
      description: description ?? undefined,
      status: status ?? undefined,
      due_date: due_date ?? undefined,
    });

    if (!project) return { success: false, output: "", error: `Project ${id} not found.` };
    return { success: true, output: `Updated project "${project.title}" (${project.id}) — status: ${project.status}` };
  }

  private remove(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for delete." };

    const deleted = deleteProject(this.db, id);
    if (!deleted) return { success: false, output: "", error: `Project ${id} not found.` };
    return { success: true, output: `Deleted project ${id}.` };
  }
}
