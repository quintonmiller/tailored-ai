import { toolOutputText } from "../content/types.js";
import type { Tool, ToolContext } from "../tools/interface.js";
import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Periodically polls Google Calendar for upcoming events and fires a workflow
 * once per event that falls inside its "warn-ahead" window. The workflow
 * receives the event's id, summary, start/end, and the raw payload.
 *
 * Dedupe is in-memory by event id. A restart re-considers anything still
 * inside the window — typically harmless for prep-reminder workflows
 * (they're idempotent), but the seen-set could be persisted later if needed.
 */

export interface CalendarPollerOptions {
  workflowEngine: WorkflowEngine;
  getTools: () => Tool[];
  now?: () => number;
}

interface Registration {
  workflowName: string;
  calendarId: string;
  titleContains: string | null;
  beforeMinutes: number;
  intervalSeconds: number;
  seen: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL = 60;
const DEFAULT_INTERVAL = 300;
const DEFAULT_BEFORE_MIN = 15;

export interface CalendarRegistration {
  beforeMinutes?: number;
  titleContains?: string;
  calendarId?: string;
  intervalSeconds?: number;
}

export class CalendarPoller {
  private opts: CalendarPollerOptions;
  private regs: Registration[] = [];

  constructor(opts: CalendarPollerOptions) {
    this.opts = opts;
  }

  register(workflowName: string, cfg: CalendarRegistration = {}): void {
    const reg: Registration = {
      workflowName,
      calendarId: cfg.calendarId ?? "primary",
      titleContains: cfg.titleContains ?? null,
      beforeMinutes: cfg.beforeMinutes ?? DEFAULT_BEFORE_MIN,
      intervalSeconds: Math.max(cfg.intervalSeconds ?? DEFAULT_INTERVAL, MIN_INTERVAL),
      seen: new Set(),
      timer: setInterval(
        () => this.poll(reg).catch(() => undefined),
        Math.max(cfg.intervalSeconds ?? DEFAULT_INTERVAL, MIN_INTERVAL) * 1000,
      ),
    };
    this.regs.push(reg);
    // Initial pass to fire anything already inside the window.
    this.poll(reg).catch((err: Error) => {
      console.warn(`[calendar-poll] initial pass for "${workflowName}" failed: ${err.message}`);
    });
  }

  stop(): void {
    for (const r of this.regs) clearInterval(r.timer);
    this.regs = [];
  }

  unregister(workflowName: string): boolean {
    const before = this.regs.length;
    const keep: Registration[] = [];
    for (const r of this.regs) {
      if (r.workflowName === workflowName) {
        clearInterval(r.timer);
        continue;
      }
      keep.push(r);
    }
    this.regs = keep;
    return this.regs.length < before;
  }

  size(): number {
    return this.regs.length;
  }

  private getCalendarTool(): Tool | null {
    return this.opts.getTools().find((t) => t.name === "google_calendar") ?? null;
  }

  private buildContext(): ToolContext {
    return {
      sessionId: "calendar-poll",
      workingDirectory: process.cwd(),
      env: process.env as Record<string, string>,
    } as ToolContext;
  }

  private async poll(reg: Registration): Promise<void> {
    const tool = this.getCalendarTool();
    if (!tool) return;
    const result = await tool.execute({ action: "list_events", calendar_id: reg.calendarId }, this.buildContext());
    if (!result.success) return;
    const events = parseEvents(toolOutputText(result.output));
    const now = (this.opts.now ?? Date.now)();
    const windowEnd = now + reg.beforeMinutes * 60_000;
    for (const ev of events) {
      if (reg.seen.has(ev.id)) continue;
      if (reg.titleContains && !ev.summary.toLowerCase().includes(reg.titleContains.toLowerCase())) {
        continue;
      }
      const startMs = Date.parse(ev.start);
      if (!Number.isFinite(startMs)) continue;
      if (startMs <= now || startMs > windowEnd) continue;

      reg.seen.add(ev.id);
      try {
        await this.opts.workflowEngine.runWorkflow(
          reg.workflowName,
          {
            event_id: ev.id,
            summary: ev.summary,
            start: ev.start,
            end: ev.end,
            minutes_until: Math.round((startMs - now) / 60_000),
            raw: ev.raw,
          },
          "programmatic",
        );
      } catch (err) {
        console.warn(
          `[calendar-poll] failed to fire workflow "${reg.workflowName}" for event ${ev.id}: ${(err as Error).message}`,
        );
      }
    }
    // Cap dedupe set.
    if (reg.seen.size > 5000) reg.seen = new Set([...reg.seen].slice(-2000));
  }
}

interface ParsedEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  raw: unknown;
}

/**
 * The google_calendar tool emits JSON from `gog`. The exact shape varies by
 * tool version — we accept either an array at top level or a `{ events: [...] }`
 * wrapper, and extract whichever fields we can find.
 */
export function parseEvents(text: string): ParsedEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown[] })?.events)
      ? (parsed as { events: unknown[] }).events
      : [];
  const out: ParsedEvent[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = String(o.id ?? o.event_id ?? o.uid ?? "");
    if (!id) continue;
    const summary = String(o.summary ?? o.title ?? "");
    const start = String(
      (o.start as { dateTime?: string; date?: string })?.dateTime ??
        (o.start as { dateTime?: string; date?: string })?.date ??
        o.start_time ??
        o.start ??
        "",
    );
    const end = String(
      (o.end as { dateTime?: string; date?: string })?.dateTime ??
        (o.end as { dateTime?: string; date?: string })?.date ??
        o.end_time ??
        o.end ??
        "",
    );
    out.push({ id, summary, start, end, raw: o });
  }
  return out;
}
