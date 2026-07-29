import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureContextDir } from "../context.js";
import { addTaskComment, updateProjectTask } from "../db/task-queries.js";
import type { EventBus } from "../events.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

export interface AskUserToolOptions {
  contextDir: string;
  /**
   * Runtime event bus. When wired, the tool emits `question.asked` instead of
   * DMing the owner inline — delivery is owned by the `builtin:owner-notifier`
   * plugin (or any subscriber the user wires up). Optional so a bare-library
   * caller without a runtime still records the question to the inbox file.
   */
  events?: EventBus;
  /** Inbox file (relative to the global context dir) for out-of-autopilot questions. */
  inboxFile: string;
}

export class AskUserTool implements Tool {
  name = "ask_user";
  description = "Ask the user a question. Records in inbox.md and notifies the owner through the default channel.";
  parameters = {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user.",
      },
    },
    required: ["question"],
  };

  private contextDir: string;
  private events?: EventBus;
  private inboxFile: string;

  constructor(opts: AskUserToolOptions) {
    this.contextDir = opts.contextDir;
    this.events = opts.events;
    this.inboxFile = opts.inboxFile;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const question = args.question as string;
    if (!question) {
      return { success: false, output: "", error: "question is required." };
    }

    // Autopilot path: block the task, record the question as a comment, stop.
    if (context.autopilotTaskId && context.db) {
      try {
        addTaskComment(context.db, context.autopilotTaskId, {
          author: context.agentName ?? "agent",
          content: `**Question for user:** ${question}`,
        });
        updateProjectTask(context.db, context.autopilotTaskId, {
          status: "blocked",
          blocked_reason: "question",
        });
      } catch (err) {
        return { success: false, output: "", error: `Failed to block task: ${(err as Error).message}` };
      }

      // Delivery + quiet-hours suppression is owned by the owner-notifier
      // plugin: emit the event rather than DMing inline.
      this.events?.emit("question.asked", {
        question,
        sessionId: context.sessionId,
        taskId: context.autopilotTaskId,
      });

      return {
        success: true,
        output: `Task ${context.autopilotTaskId} set to blocked(question). Stop working on this task now — the user will answer and resume it.`,
      };
    }

    const channels: string[] = [];
    // NOT under global/. That directory is injected verbatim into every
    // agent's prompt on every turn, so writing questions there made an outbox
    // for one person double as a broadcast to everyone — and nothing ever
    // removed an answered one.
    //
    // What that looked like in practice: five questions accumulated over three
    // weeks, about a task archived in May and a hotel booking already made,
    // read by 27 agents on every single turn for two months. One of them
    // eventually reported the hotel question as its own outstanding work. The
    // file was 2.4 KB — half the entire global context budget — and none of it
    // was true any more.
    //
    // The inbox is a queue for Quinton, not context for agents. It lives one
    // level up, where `loadAllContext` does not look.
    await ensureContextDir(this.contextDir);

    // Append to the configured inbox file.
    const inboxPath = resolve(this.contextDir, this.inboxFile);
    const timestamp = new Date().toISOString();
    const entry = `\n[QUESTION] ${timestamp}\n${question}\n`;
    try {
      let existing = "";
      try {
        existing = await readFile(inboxPath, "utf-8");
      } catch {
        /* new file */
      }
      await writeFile(inboxPath, existing + entry, "utf-8");
      channels.push(this.inboxFile);
    } catch (err) {
      return { success: false, output: "", error: `Failed to write inbox: ${(err as Error).message}` };
    }

    // Notify the owner via the event bus — the owner-notifier plugin delivers.
    if (this.events) {
      this.events.emit("question.asked", { question, sessionId: context.sessionId });
      channels.push("owner notification");
    }

    return { success: true, output: `Question recorded via: ${channels.join(", ")}` };
  }
}
