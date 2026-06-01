import type Database from "better-sqlite3";
import { CORE_MEMORY_SECTIONS, type CoreMemorySection } from "../db/core-memory-queries.js";
import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Agent-facing surface for the always-injected identity layer
 * (see docs/agent-unification.md). Sections survive across sessions
 * and inject into every session type's system prompt.
 *
 * Phase 3 routes every action through `MemoryBackend`. The "identity"
 * concept becomes a memory record with `kind: "prelude"` and structured
 * payload `{ section }`. Append/remove are read-modify-write at the
 * agent layer; the backend just stores text. Letta, Mem0, and Zep all
 * model identity-style memory this way — no library exposes
 * section-level append/remove as a primitive operation.
 *
 * Section semantics (SQLite convention; plugin backends may interpret
 * differently as long as section names round-trip through the
 * structured payload):
 *   - persona         stable voice / values / how-I-work (global)
 *   - active_threads  1-3 things I'm currently working on
 *   - recent_summary  compressed prose of recent activity
 *   - open_questions  things I flagged for myself or the user
 *   - user_state      durable user preferences / current context
 */
export class CoreMemoryTool implements Tool {
  name = "core_memory";
  description =
    "Maintain your own identity across sessions. Sections: persona, active_threads, recent_summary, open_questions, user_state. Actions: set, append, remove, clear, read. Always-injected into your future prompts.";
  parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "append", "remove", "clear", "read"],
        description: "What to do with the section.",
      },
      section: {
        type: "string",
        enum: [...CORE_MEMORY_SECTIONS],
        description:
          "Which part of your identity to touch. Required except for read with no section (which returns all).",
      },
      content: { type: "string", description: "New content for set, or the line for append." },
      match: {
        type: "string",
        description: "For remove: substring to match against lines (case-sensitive).",
      },
      global: {
        type: "boolean",
        description:
          "When true, write to the project-invariant (global) row instead of the current project's. Default false — most updates are project-scoped. The `persona` section is conventionally global.",
      },
    },
    required: ["action"],
  };

  private getBackend: () => Promise<MemoryBackend>;

  constructor(
    db: Database.Database,
    opts: { getMemoryBackend?: () => Promise<MemoryBackend> } = {},
  ) {
    if (opts.getMemoryBackend) {
      this.getBackend = opts.getMemoryBackend;
    } else {
      let cached: MemoryBackend | undefined;
      this.getBackend = async () => {
        if (!cached) cached = new SqliteMemoryBackend(db);
        return cached;
      };
    }
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const section = args.section as CoreMemorySection | undefined;
    const agentName = context.agentName ?? null;
    if (!agentName) {
      return { success: false, output: "", error: "agentName is missing from tool context" };
    }
    const projectId = args.global === true ? null : (context.projectId ?? null);
    const scope = scopeOf(agentName, projectId);
    const backend = await this.getBackend();

    switch (action) {
      case "read":
        return this.read(backend, scope, section);
      case "set":
        return this.set(backend, scope, section, args.content as string | undefined, agentName);
      case "append":
        return this.append(backend, scope, section, args.content as string | undefined, agentName);
      case "remove":
        return this.remove(backend, scope, section, args.match as string | undefined, agentName);
      case "clear":
        return this.clear(backend, scope, section);
      default:
        return {
          success: false,
          output: "",
          error: `Unknown action: ${action}. Valid: set, append, remove, clear, read.`,
        };
    }
  }

  private async read(
    backend: MemoryBackend,
    scope: string,
    section?: CoreMemorySection,
  ): Promise<ToolResult> {
    if (section) {
      if (!(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
        return { success: false, output: "", error: `Unknown section: ${section}` };
      }
      const row = await findSection(backend, scope, section);
      if (!row) return { success: true, output: `(${section} is empty)` };
      return { success: true, output: row.text };
    }
    if (!backend.list) {
      // Fall back to per-section query when list is unavailable.
      const parts: string[] = [];
      for (const s of CORE_MEMORY_SECTIONS) {
        const row = await findSection(backend, scope, s);
        if (row) parts.push(`## ${s}\n${row.text}`);
      }
      if (parts.length === 0) return { success: true, output: "(core memory is empty)" };
      return { success: true, output: parts.join("\n\n") };
    }
    const fragments = await backend.list({ scope, kind: "prelude" });
    const preludeOrdered = orderBySections(fragments);
    if (preludeOrdered.length === 0) return { success: true, output: "(core memory is empty)" };
    const formatted = preludeOrdered
      .map((f) => {
        const md = f.metadata ?? {};
        const sec = typeof md.section === "string" ? md.section : "?";
        const global = md.project_id == null ? " (global)" : "";
        return `## ${sec}${global}\n${f.text}`;
      })
      .join("\n\n");
    return { success: true, output: formatted };
  }

  private async set(
    backend: MemoryBackend,
    scope: string,
    section: CoreMemorySection | undefined,
    content: string | undefined,
    by: string,
  ): Promise<ToolResult> {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return {
        success: false,
        output: "",
        error: "section is required (one of: persona, active_threads, recent_summary, open_questions, user_state)",
      };
    }
    if (typeof content !== "string") {
      return { success: false, output: "", error: "content is required for action=set" };
    }
    await writePrelude(backend, scope, section, content, by);
    return { success: true, output: `set ${section} (${content.length} chars)` };
  }

  private async append(
    backend: MemoryBackend,
    scope: string,
    section: CoreMemorySection | undefined,
    item: string | undefined,
    by: string,
  ): Promise<ToolResult> {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return { success: false, output: "", error: "section is required" };
    }
    if (!item || typeof item !== "string" || !item.trim()) {
      return { success: false, output: "", error: "content is required for action=append" };
    }
    const trimmed = item.trim();
    const prior = await findSection(backend, scope, section);
    const priorText = prior?.text ?? "";
    let next = priorText ? `${priorText}\n${trimmed}` : trimmed;
    // Mirror the SQLite-side cap: trim from the head when the section
    // exceeds 4096 bytes. Keeps behaviour consistent across backends.
    const max = 4096;
    if (next.length > max) {
      const lines = next.split("\n");
      while (lines.length > 1 && lines.join("\n").length > max) {
        lines.shift();
      }
      next = lines.join("\n");
    }
    await writePrelude(backend, scope, section, next, by, prior?.id);
    return { success: true, output: `appended to ${section}` };
  }

  private async remove(
    backend: MemoryBackend,
    scope: string,
    section: CoreMemorySection | undefined,
    match: string | undefined,
    by: string,
  ): Promise<ToolResult> {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return { success: false, output: "", error: "section is required" };
    }
    if (!match || typeof match !== "string") {
      return {
        success: false,
        output: "",
        error: "match is required for action=remove (substring of the line to drop)",
      };
    }
    const prior = await findSection(backend, scope, section);
    if (!prior) return { success: true, output: `${section} was empty, nothing to remove` };
    const lines = prior.text.split("\n");
    const keep = lines.filter((line) => !line.includes(match));
    if (keep.length === lines.length) {
      // No change — output mirrors legacy behaviour.
      return { success: true, output: `removed lines matching "${match}" from ${section}` };
    }
    await writePrelude(backend, scope, section, keep.join("\n"), by, prior.id);
    return { success: true, output: `removed lines matching "${match}" from ${section}` };
  }

  private async clear(
    backend: MemoryBackend,
    scope: string,
    section: CoreMemorySection | undefined,
  ): Promise<ToolResult> {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return { success: false, output: "", error: "section is required" };
    }
    if (!backend.delete) {
      return { success: false, output: "", error: "delete is not supported by the active memory backend" };
    }
    const prior = await findSection(backend, scope, section);
    if (!prior || !prior.id) return { success: true, output: `${section} was already empty` };
    const cleared = await backend.delete(prior.id);
    return { success: true, output: cleared ? `cleared ${section}` : `${section} was already empty` };
  }
}

function scopeOf(agent: string, projectId: string | null): string {
  return projectId ? `agent:${agent} project:${projectId}` : `agent:${agent}`;
}

async function findSection(
  backend: MemoryBackend,
  scope: string,
  section: CoreMemorySection,
): Promise<MemoryFragment | null> {
  // Prefer list when available — single round-trip, returns the section directly.
  if (backend.list) {
    const fragments = await backend.list({ scope, kind: "prelude" });
    const match = fragments.find((f) => f.metadata?.section === section);
    return match ?? null;
  }
  // Fall back to query with structured filter.
  const hits = await backend.query({ scope, wantStructured: { section }, limit: 1 });
  return hits.find((f) => f.metadata?.section === section) ?? null;
}

async function writePrelude(
  backend: MemoryBackend,
  scope: string,
  section: CoreMemorySection,
  content: string,
  updatedBy: string,
  supersedes?: string,
): Promise<void> {
  await backend.write(
    { text: content, structured: { section, updated_by: updatedBy } },
    {
      kind: "prelude",
      scope,
      supersedes,
    },
  );
}

function orderBySections(fragments: MemoryFragment[]): MemoryFragment[] {
  const order: string[] = ["persona", "user_state", "active_threads", "recent_summary", "open_questions"];
  const bySection = new Map<string, MemoryFragment>();
  for (const f of fragments) {
    const sec = typeof f.metadata?.section === "string" ? f.metadata.section : "";
    if (sec) bySection.set(sec, f);
  }
  const out: MemoryFragment[] = [];
  for (const s of order) {
    const m = bySection.get(s);
    if (m) out.push(m);
  }
  return out;
}
