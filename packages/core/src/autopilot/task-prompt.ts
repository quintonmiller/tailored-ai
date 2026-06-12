/**
 * Autopilot task prompt — the orchestration rules the worker hands an agent
 * when it picks up a task. Kept in its own lightweight module (mirroring how
 * `briefing.ts` keeps its default prompt constant) so `config.ts` can import
 * {@link DEFAULT_AUTOPILOT_TASK_PROMPT} for DEFAULT_CONFIG without pulling in
 * the worker's heavy runtime dependency graph (croner, the agent loop, …).
 *
 * The rules are exposed as the overridable `config.autopilot.taskPrompt`;
 * DEFAULT_CONFIG holds this exact text, so out-of-the-box behavior is
 * unchanged. The worker resolves the configured template and passes it to
 * {@link buildTaskPrompt}.
 */

import { applyVars } from "../prompts/expand.js";
import type { Task } from "../tasks/interface.js";

/**
 * Default autopilot task prompt template. Interpolated by
 * {@link buildTaskPrompt} via {@link applyVars}:
 *
 *   {{task_id}}          — task id
 *   {{task_title}}       — task title
 *   {{task_description}} — description, or a "no description" fallback
 *   {{prior_activity}}   — rendered prior-comment block, or "" when none
 */
export const DEFAULT_AUTOPILOT_TASK_PROMPT = [
  'You have picked up task {{task_id}}: "{{task_title}}".',
  "",
  "RULES:",
  "",
  "1. Read the task description AND all prior comments before doing anything.",
  "   If the user has already told you something in a comment, don't ask again —",
  "   use what you have.",
  "",
  "2. If this task needs a real-world action you have no tool for — booking",
  "   appointments, sending physical mail, making phone calls, placing orders,",
  "   anything requiring a website or API you can't reach — STOP. Do NOT call",
  "   ask_user for more details (that just loops). Instead:",
  '     tasks(action=update, id="{{task_id}}", status="in_review",',
  "       comment=\"Cannot complete this directly — I don't have a tool to",
  "       <action>. Here's what I gathered: <summary>. Over to you.\")",
  "",
  "3. Only call ask_user when (a) you have a tool that can use the answer AND",
  "   (b) the info isn't already in the description or prior comments.",
  "",
  "4. When you change status, include a `comment` describing what you did or",
  "   why you're blocked — this is the audit log. Example:",
  '     tasks(action=update, id="{{task_id}}", status="done",',
  '       comment="Saved a summary of the meeting notes to memory.")',
  "   Use status=in_review instead of done when you're uncertain about the",
  "   result.",
  "",
  "Task description:",
  "{{task_description}}{{prior_activity}}",
].join("\n");

/**
 * Render the prior-activity block appended to the task prompt — the recent
 * comments plus the "use answers, don't re-ask" reminder. Returns "" when
 * the task has no comments (so the template's trailing placeholder collapses
 * to nothing, matching the historical output exactly).
 */
function renderPriorActivity(task: Task): string {
  const comments = task.comments ?? [];
  if (comments.length === 0) return "";
  const lines = ["", "", `Prior activity on this task (${comments.length} comment(s)):`];
  for (const c of comments.slice(-10)) {
    const author = c.author || "unknown";
    const body = c.content.length > 400 ? `${c.content.slice(0, 400)}…` : c.content;
    lines.push(`  [${author}] ${body}`);
  }
  lines.push(
    "",
    "Check the above carefully. If user answers are present, use them — do not",
    "ask the same question again.",
  );
  return lines.join("\n");
}

/**
 * Build the prompt for an autopilot task run. The orchestration rules come
 * from `config.autopilot.taskPrompt` when set, else the built-in
 * {@link DEFAULT_AUTOPILOT_TASK_PROMPT}. Task fields are interpolated via the
 * shared `{{var}}` mechanism so a custom template gets the same variables.
 */
export function buildTaskPrompt(task: Task, template: string = DEFAULT_AUTOPILOT_TASK_PROMPT): string {
  return applyVars(template, {
    task_id: task.id,
    task_title: task.title,
    task_description: task.description || "(no description — infer intent from the title)",
    prior_activity: renderPriorActivity(task),
  });
}
