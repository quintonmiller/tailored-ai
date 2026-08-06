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
        error:
          "reason is required — one short line on what you considered. Forces the agent to verify it actually evaluated candidates.",
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
    return {
      success: true,
      output: "Sleeping. Tick concluded. The loop will terminate now.",
      // Stop the loop rather than asking the model to stop — see
      // ToolResult.endsTurn. Without it the model often ignores "stop"
      // instructions in a tool result and keeps generating, burning rounds
      // and tokens on a tick it already concluded.
      endsTurn: true,
      // The tick's own words become the loop's return value, so chat
      // live_state and tick_log show what the tick actually did rather than a
      // generic terminator. Formatted here, not in core: how a tool describes
      // its own ending is the tool's business.
      endsTurnReason: `[Sleep] ${reason}`,
    };
  }
}
