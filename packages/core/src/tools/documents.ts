import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from "../db/document-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export class DocumentsTool implements Tool {
  name = "documents";
  description =
    "Manage project documents. Actions: create, read, update, delete, list.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "Action: create, read, update, delete, list.",
      },
      id: { type: "string", description: "Document ID (for read, update, delete)." },
      project_id: { type: "string", description: "Project ID (for create, list)." },
      title: { type: "string", description: "Document title (for create, update)." },
      content: { type: "string", description: "Markdown content (for create, update)." },
      search: { type: "string", description: "Search text (for list)." },
    },
    required: ["action"],
  };

  private db: Database.Database;
  private projectsDir: string;

  constructor(db: Database.Database, projectsDir: string) {
    this.db = db;
    this.projectsDir = projectsDir;
  }

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;
    if (!action) return { success: false, output: "", error: "No action provided." };

    // Accept common aliases
    const id = (args.id ?? args.doc_id ?? args.document_id) as string | undefined;
    const projectId = (args.project_id ?? args.projectId) as string | undefined;
    const title = (args.title ?? args.name) as string | undefined;

    try {
      switch (action) {
        case "create":
          return this.create(projectId, title, args.content as string | undefined);
        case "read":
          return this.read(id);
        case "update":
          return this.updateDoc(id, title, args.content as string | undefined);
        case "delete":
          return this.remove(id);
        case "list":
          return this.list(projectId, args.search as string | undefined);
        default:
          return { success: false, output: "", error: `Unknown action: ${action}` };
      }
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }
  }

  private filePath(projectId: string, filename: string): string {
    return join(this.projectsDir, projectId, filename);
  }

  private create(projectId?: string, title?: string, content?: string): ToolResult {
    if (!projectId) return { success: false, output: "", error: "project_id is required for create." };
    if (!title) return { success: false, output: "", error: "title is required for create." };

    const filename = `${slugify(title)}.md`;
    const dir = join(this.projectsDir, projectId);
    mkdirSync(dir, { recursive: true });

    const fp = this.filePath(projectId, filename);
    writeFileSync(fp, content ?? "", "utf-8");

    const doc = createDocument(this.db, { project_id: projectId, title, filename });
    return {
      success: true,
      output: `Created document "${doc.title}" (${doc.id}) in project ${projectId}\nFile: ${filename}`,
    };
  }

  private read(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for read." };

    const doc = getDocument(this.db, id);
    if (!doc) return { success: false, output: "", error: `Document ${id} not found.` };

    const fp = this.filePath(doc.project_id, doc.filename);
    let content = "";
    if (existsSync(fp)) {
      content = readFileSync(fp, "utf-8");
    }

    return {
      success: true,
      output: `# ${doc.title}\n\n${content}`,
    };
  }

  private updateDoc(id?: string, title?: string, content?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for update." };

    const doc = getDocument(this.db, id);
    if (!doc) return { success: false, output: "", error: `Document ${id} not found.` };

    if (content !== undefined) {
      const fp = this.filePath(doc.project_id, doc.filename);
      const dir = join(this.projectsDir, doc.project_id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(fp, content, "utf-8");
    }

    if (title !== undefined) {
      updateDocument(this.db, id, { title });
    } else {
      // Touch updated_at even if only content changed
      updateDocument(this.db, id, {});
    }

    return { success: true, output: `Updated document "${title ?? doc.title}" (${id}).` };
  }

  private remove(id?: string): ToolResult {
    if (!id) return { success: false, output: "", error: "id is required for delete." };

    const doc = getDocument(this.db, id);
    if (!doc) return { success: false, output: "", error: `Document ${id} not found.` };

    // Remove file
    const fp = this.filePath(doc.project_id, doc.filename);
    if (existsSync(fp)) {
      rmSync(fp);
    }

    deleteDocument(this.db, id);
    return { success: true, output: `Deleted document ${id}.` };
  }

  private list(projectId?: string, search?: string): ToolResult {
    if (!projectId) return { success: false, output: "", error: "project_id is required for list." };

    const docs = listDocuments(this.db, projectId, search);

    if (docs.length === 0) {
      return { success: true, output: "No documents found." };
    }

    const lines = [`${docs.length} document(s):\n`];
    for (const d of docs) {
      lines.push(`- ${d.title} (${d.id}) — ${d.filename}`);
    }

    return { success: true, output: lines.join("\n") };
  }
}
