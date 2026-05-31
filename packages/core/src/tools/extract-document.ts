import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { createDocument } from "../db/document-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Extracts text from PDFs and images for the inbox pipeline. Designed to
 * pair with the `file_drop` trigger — drop a scan, receipt, or photo into
 * the watched directory and route it through a workflow that calls this
 * tool then creates a project task or fact.
 *
 * PDF text extraction uses `pdf-parse` (no system deps, pure JS).
 * Image OCR uses `tesseract.js` (WASM-backed, pure JS, English by default).
 *
 * Both libraries are declared as optionalDependencies — the tool returns a
 * clean error if the user hasn't installed them, rather than crashing
 * core's startup. This keeps the base install lean.
 */

export interface ExtractDocumentToolOptions {
  /** Optional DB handle. When provided, action="create_document" is enabled. */
  db?: Database.Database;
  /** Project documents dir. Required when create_document is used. */
  projectsDir?: string;
}

export class ExtractDocumentTool implements Tool {
  name = "extract_document";
  description = "Extract text from a PDF or image file (OCR). Optionally store the result as a project document.";
  parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
      action: {
        type: "string",
        description: "extract (default) returns the text; create_document stores it as a markdown document.",
      },
      project_id: { type: "string", description: "Project id, required when action=create_document." },
      title: { type: "string", description: "Document title (optional, defaults to filename)." },
      language: { type: "string", description: "OCR language code (e.g. 'eng', 'fra'). Default 'eng'." },
    },
    required: ["path"],
  };

  private opts: ExtractDocumentToolOptions;

  constructor(opts: ExtractDocumentToolOptions = {}) {
    this.opts = opts;
  }

  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const path = args.path as string | undefined;
    if (!path) return { success: false, output: "", error: "path is required" };
    const resolved = resolve(path);
    if (!existsSync(resolved)) return { success: false, output: "", error: `file not found: ${resolved}` };

    const action = (args.action as string | undefined) ?? "extract";
    const language = (args.language as string | undefined) ?? "eng";

    let text: string;
    try {
      text = await extractText(resolved, { language });
    } catch (err) {
      return { success: false, output: "", error: (err as Error).message };
    }

    if (action === "extract") {
      return { success: true, output: text };
    }

    if (action === "create_document") {
      if (!this.opts.db || !this.opts.projectsDir) {
        return {
          success: false,
          output: "",
          error: "create_document requires the tool to be wired with db + projectsDir",
        };
      }
      const projectId = args.project_id as string | undefined;
      if (!projectId) return { success: false, output: "", error: "project_id is required for create_document" };
      const title = (args.title as string | undefined) ?? basename(resolved);
      const filename = `${slugify(title)}.md`;
      const dir = join(this.opts.projectsDir, projectId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, filename),
        `# ${title}\n\nExtracted from \`${basename(resolved)}\`.\n\n${text}\n`,
        "utf-8",
      );
      const doc = createDocument(this.opts.db, { project_id: projectId, title, filename });
      return {
        success: true,
        output: `Created document "${doc.title}" (${doc.id}) with ${text.length} chars of extracted text.`,
      };
    }

    return { success: false, output: "", error: `unknown action: ${action}` };
  }
}

/**
 * Extract text from a PDF or image. Returns a single string (line-joined for
 * PDFs, OCR confidence-ordered for images). Exported for direct use by
 * workflow executors or scripts.
 */
export async function extractText(filePath: string, opts: { language?: string } = {}): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") return extractPdf(filePath);
  if (IMAGE_EXTENSIONS.has(ext)) return extractImage(filePath, opts.language ?? "eng");
  throw new Error(`unsupported file type: ${ext || "(none)"} — supported: .pdf, ${[...IMAGE_EXTENSIONS].join(", ")}`);
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tiff", ".webp"]);

async function extractPdf(filePath: string): Promise<string> {
  let pdfParse: ((buf: Buffer) => Promise<{ text: string }>) | undefined;
  try {
    const mod = await import("pdf-parse" as string);
    pdfParse = (mod as { default?: typeof pdfParse }).default ?? (mod as unknown as typeof pdfParse);
  } catch {
    throw new Error('PDF extraction requires the "pdf-parse" package. Install with: pnpm add pdf-parse');
  }
  const buf = readFileSync(filePath);
  const { text } = await pdfParse!(buf);
  return text.trim();
}

async function extractImage(filePath: string, language: string): Promise<string> {
  let recognize: ((file: string, lang: string) => Promise<{ data: { text: string } }>) | undefined;
  try {
    const mod = await import("tesseract.js" as string);
    recognize = (mod as { recognize: typeof recognize }).recognize;
  } catch {
    throw new Error('Image OCR requires the "tesseract.js" package. Install with: pnpm add tesseract.js');
  }
  const { data } = await recognize!(filePath, language);
  return data.text.trim();
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
