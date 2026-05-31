import type Database from "better-sqlite3";
import {
  appendCoreMemory,
  CORE_MEMORY_SECTIONS,
  type CoreMemorySection,
  clearCoreMemorySection,
  getCoreMemory,
  getCoreMemorySection,
  removeCoreMemoryLine,
  setCoreMemory,
} from "../db/core-memory-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * Agent-facing surface for the always-injected identity layer
 * (see docs/agent-unification.md). Sections survive across sessions
 * and inject into every session type's system prompt — this is what
 * lets chat / tick / delegate behave as one continuous agent.
 *
 * The action vocabulary intentionally mirrors how an agent talks
 * about its own identity:
 *   - `set`     replace a section wholesale (e.g. revise persona)
 *   - `append`  add one line to a list-shaped section
 *               (active_threads, recent_summary, open_questions)
 *   - `remove`  drop one line by substring match (close a thread,
 *               resolve a question)
 *   - `clear`   wipe a section (rare; used after a major reset)
 *   - `read`    inspect the current state (debugging / curation)
 *
 * Section semantics:
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
      content: {
        type: "string",
        description: "New content for set, or the line for append.",
      },
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

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = (args.action as string) ?? "";
    const section = args.section as CoreMemorySection | undefined;
    const agentName = context.agentName ?? null;
    if (!agentName) {
      return { success: false, output: "", error: "agentName is missing from tool context" };
    }
    const scope = {
      agent: agentName,
      project_id: args.global === true ? null : (context.projectId ?? null),
    };

    switch (action) {
      case "read":
        return this.read(scope, section);
      case "set":
        return this.set(scope, section, args.content as string | undefined, agentName);
      case "append":
        return this.append(scope, section, args.content as string | undefined, agentName);
      case "remove":
        return this.remove(scope, section, args.match as string | undefined, agentName);
      case "clear":
        return this.clear(scope, section);
      default:
        return {
          success: false,
          output: "",
          error: `Unknown action: ${action}. Valid: set, append, remove, clear, read.`,
        };
    }
  }

  private read(scope: { agent: string; project_id: string | null }, section?: CoreMemorySection): ToolResult {
    if (section) {
      if (!(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
        return { success: false, output: "", error: `Unknown section: ${section}` };
      }
      const row = getCoreMemorySection(this.db, scope, section);
      if (!row) return { success: true, output: `(${section} is empty)` };
      return { success: true, output: row.content };
    }
    const rows = getCoreMemory(this.db, scope);
    if (rows.length === 0) return { success: true, output: "(core memory is empty)" };
    const formatted = rows.map((r) => `## ${r.section}${r.project_id ? "" : " (global)"}\n${r.content}`).join("\n\n");
    return { success: true, output: formatted };
  }

  private set(
    scope: { agent: string; project_id: string | null },
    section: CoreMemorySection | undefined,
    content: string | undefined,
    by: string,
  ): ToolResult {
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
    setCoreMemory(this.db, { ...scope, section, content, updated_by: by });
    return { success: true, output: `set ${section} (${content.length} chars)` };
  }

  private append(
    scope: { agent: string; project_id: string | null },
    section: CoreMemorySection | undefined,
    item: string | undefined,
    by: string,
  ): ToolResult {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return { success: false, output: "", error: "section is required" };
    }
    if (!item || typeof item !== "string" || !item.trim()) {
      return { success: false, output: "", error: "content is required for action=append" };
    }
    appendCoreMemory(this.db, { ...scope, section, item: item.trim(), updated_by: by });
    return { success: true, output: `appended to ${section}` };
  }

  private remove(
    scope: { agent: string; project_id: string | null },
    section: CoreMemorySection | undefined,
    match: string | undefined,
    by: string,
  ): ToolResult {
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
    const row = removeCoreMemoryLine(this.db, scope, section, match, { updated_by: by });
    if (!row) return { success: true, output: `${section} was empty, nothing to remove` };
    return { success: true, output: `removed lines matching "${match}" from ${section}` };
  }

  private clear(
    scope: { agent: string; project_id: string | null },
    section: CoreMemorySection | undefined,
  ): ToolResult {
    if (!section || !(CORE_MEMORY_SECTIONS as string[]).includes(section)) {
      return { success: false, output: "", error: "section is required" };
    }
    const cleared = clearCoreMemorySection(this.db, scope, section);
    return { success: true, output: cleared ? `cleared ${section}` : `${section} was already empty` };
  }
}
