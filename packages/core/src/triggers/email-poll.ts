import type { WorkflowEngine } from "../workflows/engine.js";
import type { Tool, ToolContext } from "../tools/interface.js";

/**
 * Periodically runs a Gmail search and fires a workflow per new message.
 * Dedupe state is in-memory only — restarting the process re-fires anything
 * that still matches the query (intentional for now; persisting the seen
 * set is a small follow-up if duplicate fires become a problem).
 *
 * The Gmail tool (`gmail`) is consulted at runtime by name, so the poller
 * stays decoupled from the underlying provider implementation. Once an
 * `EmailBackend` abstraction lands (Tier-S), the poller swaps to that with
 * no UI/trigger changes.
 */

export interface EmailPollerOptions {
  workflowEngine: WorkflowEngine;
  /** Returns the live tools array; mailbox queries use the `gmail` tool. */
  getTools: () => Tool[];
  /** Tool context to pass to the gmail tool. */
  contextProvider?: () => Partial<ToolContext>;
  /** Override clock for tests. */
  now?: () => number;
}

interface Registration {
  workflowName: string;
  query: string;
  intervalSeconds: number;
  seen: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 30;
const DEFAULT_INTERVAL_SECONDS = 300;

export class EmailPoller {
  private opts: EmailPollerOptions;
  private regs: Registration[] = [];

  constructor(opts: EmailPollerOptions) {
    this.opts = opts;
  }

  register(workflowName: string, query: string, intervalSeconds?: number): void {
    const interval = Math.max(intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
    const reg: Registration = {
      workflowName,
      query,
      intervalSeconds: interval,
      seen: new Set(),
      // Run an immediate priming pass + then on the schedule.
      timer: setInterval(() => this.poll(reg).catch(() => undefined), interval * 1000),
    };
    this.regs.push(reg);
    // Prime the seen set without firing the workflow — this avoids a flood
    // on registration. The fire-on-first-match behavior triggers only for
    // messages that show up *after* this priming call.
    this.prime(reg).catch((err: Error) => {
      console.warn(`[email-poll] priming "${workflowName}" failed: ${err.message}`);
    });
  }

  stop(): void {
    for (const r of this.regs) clearInterval(r.timer);
    this.regs = [];
  }

  size(): number {
    return this.regs.length;
  }

  private getGmailTool(): Tool | null {
    return this.opts.getTools().find((t) => t.name === "gmail") ?? null;
  }

  private buildContext(): ToolContext {
    return {
      sessionId: "email-poll",
      workingDirectory: process.cwd(),
      env: process.env as Record<string, string>,
      ...this.opts.contextProvider?.(),
    } as ToolContext;
  }

  private async prime(reg: Registration): Promise<void> {
    const ids = await this.searchIds(reg.query);
    for (const id of ids) reg.seen.add(id);
  }

  private async poll(reg: Registration): Promise<void> {
    const ids = await this.searchIds(reg.query);
    const fresh = ids.filter((id) => !reg.seen.has(id));
    for (const id of fresh) reg.seen.add(id);
    for (const id of fresh) {
      try {
        await this.fire(reg, id);
      } catch (err) {
        console.warn(
          `[email-poll] failed to fire workflow "${reg.workflowName}" for message ${id}: ${(err as Error).message}`,
        );
      }
    }
    // Cap seen set so it doesn't grow unboundedly.
    if (reg.seen.size > 5000) {
      reg.seen = new Set([...reg.seen].slice(-2000));
    }
  }

  private async searchIds(query: string): Promise<string[]> {
    const tool = this.getGmailTool();
    if (!tool) return [];
    const result = await tool.execute({ action: "search", query }, this.buildContext());
    if (!result.success) return [];
    // The gmail tool returns a list of `Message ID: <id>` lines; pull them out.
    // Different gmail tool versions may emit a JSON array; handle both.
    const out: string[] = [];
    const text = result.output;
    try {
      const maybe = JSON.parse(text);
      if (Array.isArray(maybe)) {
        for (const m of maybe) {
          if (typeof m === "string") out.push(m);
          else if (m && typeof m === "object" && "id" in m) out.push(String((m as { id: unknown }).id));
        }
        return out;
      }
    } catch {
      /* not JSON — fall through */
    }
    const lineMatch = text.matchAll(/(?:Message[- ]?ID|message_id|id):\s*([A-Za-z0-9_\-]+)/g);
    for (const m of lineMatch) out.push(m[1]);
    return out;
  }

  private async fire(reg: Registration, messageId: string): Promise<void> {
    const tool = this.getGmailTool();
    if (!tool) return;
    const read = await tool.execute(
      { action: "read", message_id: messageId },
      this.buildContext(),
    );
    const body = read.success ? read.output : "";
    const input = {
      message_id: messageId,
      message_body: body,
      query: reg.query,
    };
    await this.opts.workflowEngine.runWorkflow(reg.workflowName, input, "programmatic");
  }
}
