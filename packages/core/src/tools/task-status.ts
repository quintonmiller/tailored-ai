import { getTask, listTasks, type TaskInfo } from "../agent/tasks.js";
import type { Tool, ToolContext, ToolResult } from "./interface.js";

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTask(t: TaskInfo): string {
  const elapsed = formatElapsed((t.completedAt ?? Date.now()) - t.startedAt);
  let line = `[${t.id}] ${t.status} (${elapsed}) — ${t.description}`;
  if (t.status === "completed" && t.result) {
    line += `\nResult: ${t.result.slice(0, 500)}`;
  }
  if (t.status === "failed" && t.error) {
    line += `\nError: ${t.error}`;
  }
  return line;
}

export class TaskStatusTool implements Tool {
  name = "task_status";
  description = "Check status of background tasks.";
  parameters = {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "status"], description: '"list" all tasks or "status" of one task.' },
      taskId: { type: "string", description: 'Task ID (required for "status" action).' },
    },
    required: ["action"],
  };

  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const action = args.action as string;

    if (action === "list") {
      const all = listTasks();
      if (!all.length) return { success: true, output: "No background tasks." };
      return { success: true, output: all.map(formatTask).join("\n\n") };
    }

    if (action === "status") {
      const taskId = args.taskId as string;
      if (!taskId) return { success: false, output: "", error: 'taskId is required for "status" action.' };
      const task = getTask(taskId);
      if (!task) return { success: false, output: "", error: `Task "${taskId}" not found.` };
      return { success: true, output: formatTask(task) };
    }

    return { success: false, output: "", error: `Unknown action "${action}". Use "list" or "status".` };
  }
}
