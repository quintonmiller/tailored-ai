/**
 * Default Discord notifier — Slice 3 of the platform vision
 * (`docs/platform-vision.md`). Subscribes to `agent.completed` on the
 * runtime event bus and delivers a structured Discord DM / channel
 * message when the loop terminates in a state that needs user
 * attention (blocked, done, in_review without an agent assignee, etc.).
 *
 * Previously this lived inside `TaskWatcher`. Extracting it has two
 * payoffs:
 *
 * 1. The watcher gets smaller and its responsibility narrows to
 *    routing + dispatch (still the load-bearing piece, but no longer
 *    bundled with delivery formatting).
 * 2. A user who wants to ship to Slack, Telegram, email, or anywhere
 *    else can disable this plugin and write their own subscriber. The
 *    plugin shape is what we ship our own behavior in — same shape an
 *    external author would use.
 *
 * The class is constructed by the host (CLI / server / tests) with a
 * runtime ref. It subscribes on construction and disposes its
 * subscription on `stop()`. The live Discord sink is resolved at
 * delivery time from the runtime's outbound registry
 * (`runtime.getOutbound("discord")`), so connect / disconnect /
 * config-reload swaps are picked up automatically without rebuilding
 * the subscriber.
 */

import type Database from "better-sqlite3";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

export interface DiscordNotifierOptions {
  runtime: AgentRuntime;
}

export class DiscordNotifier {
  private runtime: AgentRuntime;
  private subscription: Subscription;

  constructor(opts: DiscordNotifierOptions) {
    this.runtime = opts.runtime;
    this.subscription = this.runtime.events.on("agent.completed", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  private async handle(e: RuntimeEventPayload<"agent.completed">): Promise<void> {
    const logPrefix = `[discord-notifier] [${e.taskId}]`;
    const finalAssignee = e.finalTask.assignee?.trim() || null;
    const finalStatus = e.finalTask.status;

    if (this.shouldSuppressDelivery(finalAssignee, finalStatus)) {
      console.log(
        `${logPrefix} suppressing delivery — task in-flight (assignee=${finalAssignee}, status=${finalStatus})`,
      );
      return;
    }

    const envelope = await buildNotification(
      this.runtime.db,
      e.finalTask,
      finalAssignee,
      finalStatus,
      e.response,
      (name) => this.isKnownAgent(name),
    );
    await this.deliver(envelope, logPrefix);
  }

  /**
   * Skip the Discord DM when the task is still being worked on by another
   * agent. The user only wants to hear when (a) the loop hits the user,
   * (b) something is blocked, or (c) something is done. Mid-flight
   * handoffs between agents are noise.
   */
  shouldSuppressDelivery(finalAssignee: string | null, finalStatus: string): boolean {
    if (finalStatus === "blocked" || finalStatus === "done" || finalStatus === "archived") return false;
    if (!finalAssignee) return false;
    if (this.isKnownAgent(finalAssignee)) return true;
    return false;
  }

  private isKnownAgent(name: string): boolean {
    return Boolean(this.runtime.getConfig().agents?.[name]);
  }

  private async deliver(response: string, logPrefix: string): Promise<void> {
    const delivery = this.runtime.getConfig().taskWatcher.delivery;
    const channelId = delivery?.channel ?? "log";

    // "log" is the reserved console-only sentinel (also the default when
    // delivery is unconfigured) — no real channel delivery.
    if (channelId === "log") {
      console.log(`${logPrefix} ${response}`);
      return;
    }

    const mode = delivery?.mode ?? "channel";
    const out = this.runtime.getOutbound(channelId);
    if (!out) {
      console.error(`${logPrefix} wants ${channelId} delivery but it is not connected`);
      return;
    }

    if (mode === "dm") {
      const userId = delivery?.target ?? this.runtime.getOwnerId(channelId);
      if (!userId) {
        console.error(`${logPrefix} dm delivery has no target user id and no owner for ${channelId}`);
        return;
      }
      await out.sendDM(userId, response);
      console.log(`${logPrefix} Delivered as DM to user ${userId}`);
      return;
    }

    if (!delivery?.target) {
      console.error(`${logPrefix} channel delivery has no target channel id`);
      return;
    }
    await out.send(delivery.target, response);
    console.log(`${logPrefix} Delivered to ${channelId} channel ${delivery.target}`);
  }
}

/**
 * Build the structured Discord message: header (status + task id + title),
 * latest comment as blockquote, what-to-do-next hint, then a trimmed
 * slice of the agent's response when it adds info beyond the comment.
 *
 * Exported (alongside `emojiForStatus`) so tests can exercise the
 * formatter without standing up a runtime.
 */
export async function buildNotification(
  db: Database.Database,
  finalTask: { id: string; title: string; description?: string; status: string },
  finalAssignee: string | null,
  finalStatus: string,
  agentResponse: string,
  isKnownAgent: (name: string) => boolean,
): Promise<string> {
  const emoji = emojiForStatus(finalStatus, finalAssignee);
  const title = (finalTask.title ?? "").slice(0, 100);
  const lines: string[] = [];
  lines.push(`${emoji} **${finalTask.id}** — ${title}`);
  lines.push(`status: ${finalStatus} · assignee: ${finalAssignee ?? "(unassigned)"}`);

  const latestComment = db
    .prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 1")
    .get(finalTask.id) as { author: string; content: string } | undefined;
  if (latestComment) {
    const truncated =
      latestComment.content.length > 600
        ? `${latestComment.content.slice(0, 600).trim()} …`
        : latestComment.content.trim();
    lines.push("");
    lines.push(`> *${latestComment.author}*: ${truncated}`);
  }

  const nextHint = nextActionHint(db, finalStatus, finalAssignee, finalTask.id, isKnownAgent);
  if (nextHint) {
    lines.push("");
    lines.push(nextHint);
  }

  const respTrimmed = agentResponse.trim();
  const commentText = latestComment?.content ?? "";
  const probe = 60;
  const overlapsComment =
    respTrimmed.length >= probe &&
    (commentText.includes(respTrimmed.slice(0, probe)) || respTrimmed.includes(commentText.slice(0, probe)));
  if (respTrimmed && respTrimmed.length > 40 && !overlapsComment) {
    lines.push("");
    lines.push("---");
    lines.push(respTrimmed.length > 500 ? `${respTrimmed.slice(0, 500).trim()} …` : respTrimmed);
  }
  return lines.join("\n");
}

function nextActionHint(
  db: Database.Database,
  status: string,
  assignee: string | null,
  taskId: string,
  isKnownAgent: (name: string) => boolean,
): string {
  if (status === "done" || status === "archived") return "✅ closed — no action.";
  if (status === "blocked") return "🚫 **blocked** — needs your decision (see comment above).";
  if (status === "in_review" && (assignee === null || !isKnownAgent(assignee))) {
    const branch = findBranchInTaskComments(db, taskId);
    if (branch) {
      return [
        `🔍 **ready for your review.**`,
        "```",
        `git diff main..${branch}`,
        `git checkout main && git merge --ff-only ${branch}`,
        "```",
      ].join("\n");
    }
    return "🔍 **ready for your review** — see comments above.";
  }
  return "";
}

/**
 * Scan ALL comments on a task for a `Branch: <name>` reference and return
 * the most recent one. Necessary because the most recent comment may be
 * a reviewer's prose, not the coder's branch announcement.
 */
function findBranchInTaskComments(db: Database.Database, taskId: string): string | null {
  const rows = db.prepare("SELECT content FROM task_comments WHERE task_id = ? ORDER BY id DESC").all(taskId) as Array<{
    content: string;
  }>;
  for (const r of rows) {
    const m = r.content.match(/Branch:\s+(\S+?)(?:[.\s]|$)/);
    if (m?.[1]) return m[1].replace(/\.$/, "");
  }
  return null;
}

export function emojiForStatus(status: string, assignee: string | null): string {
  if (status === "done" || status === "archived") return "✅";
  if (status === "blocked") return "🚫";
  if (status === "in_review") return assignee && /^[A-Z]/.test(assignee) ? "🔍" : "⏳";
  if (status === "in_progress") return "🛠️";
  if (status === "backlog") return "📥";
  return "📝";
}

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:discord-notifier`. Constructs a {@link DiscordNotifier} bound to
 * the live runtime and returns a disposer so the loader can tear down the
 * subscription on shutdown / reload.
 *
 * `ctx.config` is intentionally unused: delivery settings (channel, mode,
 * target) live under `taskWatcher.delivery` and are resolved at delivery
 * time from the runtime's outbound registry (#165), so there is no separate
 * per-plugin knob to wire here.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const notifier = new DiscordNotifier({ runtime: ctx.runtime });
  return () => notifier.stop();
};
export default plugin;
