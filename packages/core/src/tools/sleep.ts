import type Database from "better-sqlite3";
import { appendTickLog } from "../db/tick-log-queries.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

/**
 * `Sleep` — the noop terminator for exploratory ticks
 * (docs/agent-unification.md, Phase 3).
 *
 * Replaces the old habit of writing "tick: idle" notes to recall when
 * the agent has nothing to do. Calling Sleep:
 *   - writes a `noop` row to tick_log (operational telemetry, NOT recall)
 *   - returns success, agent is expected to stop generating output
 *
 * Available only when the loop is running inside an exploratory tick
 * (context.exploratoryRunId is set). Reactive chat sessions don't
 * expose it — silent agents mid-conversation are bad UX.
 *
 * Why this exists: the agent kept writing 150+ "tick: idle, standing
 * by" notes per day into the same store it later queried for meaning.
 * Sleep gives it a structured, no-write exit.
 */
export class SleepTool implements Tool {
  name = "Sleep";
  description =
    "Conclude this exploratory tick without doing material work. Use when no candidate move applies — never write a recall note about being idle, just call Sleep and stop. Briefly cite which moves you considered.";
  parameters = {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "One short line on what you considered and why nothing applied (e.g. 'no new emails, backlog top-5 all blocked on user input, no stale threads'). Helps debug stagnation later.",
      },
    },
    required: ["reason"],
  };

  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const reason = typeof args.reason === "string" ? args.reason.trim() : "";
    if (!reason) {
      return {
        success: false,
        output: "",
        error: "reason is required — one short line on what you considered. Forces the agent to verify it actually evaluated candidates.",
      };
    }
    if (!context.exploratoryRunId) {
      return {
        success: false,
        output: "",
        error: "Sleep is only available inside an exploratory tick. In reactive chat, just stop replying.",
      };
    }
    if (!context.db && !this.db) {
      return { success: false, output: "", error: "no db in context" };
    }
    const db = context.db ?? this.db;
    appendTickLog(db, {
      tick_id: context.exploratoryRunId,
      agent: context.agentName ?? "unknown",
      project_id: context.projectId ?? null,
      kind: "noop",
      summary: reason,
    });
    // Signal the loop to terminate. workingMemory is a per-loop scratch
    // map the loop body checks at the top of each round — see agent/loop.ts.
    // Without this, the model often ignores "stop" instructions in the
    // tool result and keeps generating, burning rounds and tokens.
    context.workingMemory?.set("tick_done", "true");
    // Stash the reason so the loop can surface it as the tick's overall
    // summary instead of a generic "[Tick concluded via Sleep]" string.
    // Chat live_state reads tick_log.summary; opaque terminators make
    // the chat agent blind to what the tick actually did.
    context.workingMemory?.set("tick_summary", reason);
    return { success: true, output: "Sleeping. Tick concluded. The loop will terminate now." };
  }
}
