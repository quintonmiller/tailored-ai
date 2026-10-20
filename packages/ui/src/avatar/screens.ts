/**
 * A screen on a wall: the dashboard, a page at a time, in the lobby; in a
 * home, what its owner is up to. Each page is a card worked out here from a
 * dashboard widget and what its endpoint sent (or from an agent's activity
 * and tasks), without a canvas, so it is tested; the drawing only lays a card
 * out. The screen turns to the next page every quarter of a minute, the same
 * page on every screen and every visit, since the page is read off the clock.
 */
import type { DashboardWidgetSpec } from "../api";
import { nameOf } from "../lib/conversations";
import { clockTime, lastDid, TAG_LINE_CHARS } from "../lib/did";
import { GROUPS, lasting, statusLabel, whenMs } from "../lib/tasks";
import { asArray, getPath } from "../lib/widget-data";
import type { AgentActivity } from "./doing";

/** The colour a tag or a big word is drawn in. */
export type Tone = "ok" | "warn" | "bad" | "info" | "dim";

/** A line on a card: what it is, a coloured tag before it, and a few words after it. */
export interface ScreenRow {
  text: string;
  /** Said after it, smaller: who has a task, when a run was, a value. */
  meta?: string;
  tag?: { text: string; tone: Tone };
}

/** One page a screen shows. */
export interface ScreenCard {
  /** The widget it shows, or in a home what it is about: a click on the screen opens that. */
  id: string;
  title: string;
  /** A big word or number, and what it is. */
  big?: { text: string; sub?: string; tone?: Tone };
  rows?: ScreenRow[];
  /** Plain lines of text: a note, a markdown widget. */
  lines?: string[];
  /** The time and date, as the screen is drawn: a clock. */
  clock?: boolean;
  /** What it says when there is nothing else to show. */
  empty?: string;
}

/** Milliseconds each page is on screen. */
export const PAGE_MS = 15_000;
/** Pages a screen goes through at most: the dashboard's first few widgets. */
export const SCREEN_PAGES = 5;

/** The widget types a screen can draw. Embeds and the widgets made to be clicked and typed into stay on the Board. */
const DRAWN = new Set(["status", "clock", "tasks", "activity", "metric", "list", "markdown", "links"]);

/** Which of the dashboard's widgets the screen shows, in the dashboard's order: the first few it can draw. */
export function screenWidgets(widgets: DashboardWidgetSpec[], max = SCREEN_PAGES): DashboardWidgetSpec[] {
  return widgets.filter((w) => w.enabled !== false && DRAWN.has(w.type)).slice(0, max);
}

/** The endpoint a widget reads, as its renderer on the Board would; none for one that needs no data. */
export function endpointOf(widget: DashboardWidgetSpec): string | undefined {
  const given = typeof widget.options?.endpoint === "string" ? widget.options.endpoint : "";
  const fallback: Record<string, string> = {
    status: "/api/health",
    tasks: "/api/project-tasks?limit=6",
    activity: "/api/exploratory/runs?limit=6",
  };
  const endpoint = given || fallback[widget.type];
  return endpoint?.startsWith("/api/") ? endpoint : undefined;
}

/** Which page is up at `now`, of `count`: read off the clock, so it is the same page wherever it is shown. */
export function pageAt(now: number, count: number, every = PAGE_MS): number {
  return count > 1 ? Math.floor(now / every) % count : 0;
}

/** What a widget's endpoint sent: the data, why it couldn't be had, or nothing yet. */
export type Fetched = { data: unknown } | { error: string } | undefined;

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const opt = (w: DashboardWidgetSpec, key: string) => w.options?.[key];

/** The tone a task's status is drawn in, by the board column it falls in. */
function statusTone(status: string): Tone {
  const group = GROUPS.find((g) => g.statuses.includes(status))?.id;
  return group === "done" ? "ok" : group === "blocked" ? "bad" : group === "doing" ? "info" : "dim";
}

/** The tone an agent run's outcome is drawn in. */
function outcomeTone(outcome: string): Tone {
  if (/^(ok|success|succeeded|done|completed)$/i.test(outcome)) return "ok";
  if (/(error|fail|stuck|timeout)/i.test(outcome)) return "bad";
  return "dim";
}

/** Markdown as the plain lines a screen has room for: headings, bullets and links as their words. */
export function plainLines(markdown: string, max = 8): string[] {
  return markdown
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/, (m) => (/[-*+]/.test(m.trim()) ? "• " : ""))
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`~]+/g, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, max);
}

/**
 * A dashboard widget as a page on a screen: the same things its renderer on
 * the Board shows, fewer and bigger. `fetched` is what its endpoint sent.
 */
export function cardFor(widget: DashboardWidgetSpec, fetched: Fetched, now = Date.now()): ScreenCard {
  const title = widget.title ?? widget.id;
  const card: ScreenCard = { id: widget.id, title };
  if (endpointOf(widget)) {
    if (!fetched) return { ...card, empty: "Loading…" };
    if ("error" in fetched)
      return widget.type === "status"
        ? { ...card, big: { text: "Unreachable", tone: "bad" } }
        : { ...card, empty: `Couldn't load: ${fetched.error}` };
  }
  const data = fetched && "data" in fetched ? fetched.data : undefined;
  switch (widget.type) {
    case "clock":
      return { ...card, clock: true };
    case "status": {
      const d = (data ?? {}) as Record<string, unknown>;
      const ok = d.status === "ok" || d.status === "healthy";
      const rows: ScreenRow[] = [];
      if (d.model != null) rows.push({ text: "Model", meta: text(d.model) });
      if (d.provider != null) rows.push({ text: "Provider", meta: text(d.provider) });
      if (typeof d.uptime === "number")
        rows.push({ text: "Up for", meta: lasting(new Date(now - d.uptime * 1000).toISOString(), now) });
      if (d.tools != null) rows.push({ text: "Tools", meta: text(d.tools) });
      return { ...card, big: ok ? { text: "Online", tone: "ok" } : { text: "Starting…", tone: "warn" }, rows };
    }
    case "tasks": {
      const tasks = asArray(data, text(opt(widget, "itemsPath")) || "tasks") as Record<string, unknown>[];
      return {
        ...card,
        rows: tasks.map((t) => {
          const status = text(t.status);
          return {
            text: text(t.title ?? t.id) || "Untitled",
            ...(t.assignee ? { meta: nameOf(text(t.assignee)) } : {}),
            ...(status ? { tag: { text: statusLabel(status), tone: statusTone(status) } } : {}),
          };
        }),
        empty: text(opt(widget, "emptyText")) || "Nothing to show.",
      };
    }
    case "activity": {
      const runs = asArray(data, text(opt(widget, "itemsPath")) || "runs") as Record<string, unknown>[];
      return {
        ...card,
        rows: runs.map((r) => {
          const when = whenMs(text(r.startedAt ?? r.started_at ?? r.created_at));
          const outcome = text(r.outcome ?? r.status);
          return {
            text: nameOf(text(r.agent ?? r.agentName ?? r.agent_name) || "agent"),
            ...(Number.isFinite(when) ? { meta: clockTime(when) } : {}),
            ...(outcome ? { tag: { text: outcome, tone: outcomeTone(outcome) } } : {}),
          };
        }),
        empty: "No recent activity.",
      };
    }
    case "metric": {
      const value = getPath(data, text(opt(widget, "valuePath"))) ?? opt(widget, "value") ?? "—";
      const unit = text(opt(widget, "unit"));
      const label = text(opt(widget, "label"));
      const shown = typeof value === "object" ? "—" : text(value);
      return { ...card, big: { text: unit ? `${shown} ${unit}` : shown, ...(label ? { sub: label } : {}) } };
    }
    case "list": {
      const items = asArray(data, text(opt(widget, "itemsPath"))) as Record<string, unknown>[];
      const titleField = text(opt(widget, "titleField")) || "title";
      const subField = text(opt(widget, "subtitleField"));
      return {
        ...card,
        rows: items.map((row) => ({
          text: text(getPath(row, titleField)) || "—",
          ...(subField && getPath(row, subField) != null ? { meta: text(getPath(row, subField)) } : {}),
        })),
        empty: text(opt(widget, "emptyText")) || "Empty.",
      };
    }
    case "markdown": {
      const raw = opt(widget, "endpoint")
        ? text(getPath(data, text(opt(widget, "contentField")) || "content"))
        : text(opt(widget, "markdown"));
      return { ...card, lines: plainLines(raw), empty: "Nothing written yet." };
    }
    case "links": {
      const links = (Array.isArray(opt(widget, "links")) ? opt(widget, "links") : []) as { label?: string }[];
      return { ...card, rows: links.map((l) => ({ text: text(l.label) || "link" })), empty: "No links yet." };
    }
    default:
      return { ...card, empty: "This one is on the Board." };
  }
}

/**
 * The pages a screen showing the dashboard goes through: a card for each of
 * the first few widgets it can draw. Once the dashboard has answered with
 * none of those, one page says why: it couldn't be had, the Board has no
 * widgets, or none a screen can draw. None before it answers, so the screen
 * stays dark rather than say something that isn't so yet.
 */
export function dashboardCards(
  at: { widgets: DashboardWidgetSpec[]; fetched: Record<string, Fetched>; loaded: boolean; error?: string },
  now = Date.now(),
): ScreenCard[] {
  const shown = screenWidgets(at.widgets);
  if (shown.length) return shown.map((w) => cardFor(w, at.fetched[w.id], now));
  if (!at.loaded) return [];
  const empty = at.error
    ? `Couldn't load the dashboard: ${at.error}`
    : at.widgets.length
      ? "Nothing on the Board a screen can show: click to see it."
      : "Nothing on the Board yet.";
  return [{ id: "board", title: "Dashboard", empty }];
}

/** The tone of what an agent is doing: busy green, thinking blue, waiting on you orange, stuck red. */
function doingTone(doing: AgentActivity["doing"] | undefined): Tone {
  if (doing === "working") return "ok";
  if (doing === "thinking" || doing === "talking") return "info";
  if (doing === "waiting") return "warn";
  if (doing === "stuck") return "bad";
  return "dim";
}

/** A task, as an agent's own screen needs one. */
export interface ScreenTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
}

/** Something coming up for an agent, as its own screen lists it: when, in a few words, and what. */
export interface Coming {
  when: string;
  what: string;
}

/**
 * The pages a screen in an agent's home goes through: what it is doing now
 * (with what it did last and when it next wakes, while it rests), the tasks
 * on its list, and what is coming up for it. Each page's id says what a click
 * on it opens: the agent's card, its tasks, its calendar.
 */
export function homeCards(
  agent: string,
  at: { activity?: AgentActivity; tasks: ScreenTask[]; coming: Coming[]; now?: number },
): ScreenCard[] {
  const now = at.now ?? Date.now();
  const name = nameOf(agent);
  const a = at.activity;
  const since = a?.since ? lasting(a.since, now) : undefined;
  const resting = a?.doing === "idle" || a?.doing === "asleep";
  const last = resting ? lastDid(a?.last, now, TAG_LINE_CHARS) : undefined;
  // What wakes it next, as its calendar says: a cron job that runs as it too, which its activity record leaves out.
  const [next] = at.coming;
  const doing: ScreenCard = {
    id: "now",
    title: `${name}, now`,
    big: { text: a?.what ?? "nothing yet", tone: doingTone(a?.doing) },
    lines: [
      ...(a?.detail && a.doing !== "asleep" ? [a.detail] : []),
      ...(since && !resting ? [`for ${since}`] : []),
      ...(last ? [`last: ${last}`] : []),
      ...(next ? [`next: ${next.when}, ${next.what}`] : []),
    ],
  };
  const open = at.tasks.filter((t) => t.assignee === agent && statusTone(t.status) !== "ok");
  const tasks: ScreenCard = {
    id: "tasks",
    title: `${name}'s tasks`,
    rows: open.map((t) => ({ text: t.title, tag: { text: statusLabel(t.status), tone: statusTone(t.status) } })),
    empty: "Nothing on its list.",
  };
  const coming: ScreenCard = {
    id: "next",
    title: "Coming up",
    rows: at.coming.map((c) => ({ text: c.what, meta: c.when })),
    empty: "Nothing booked.",
  };
  return [doing, tasks, coming];
}

// --------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------

const TONES: Record<Tone, string> = {
  ok: "#4ade80",
  warn: "#fb923c",
  bad: "#f87171",
  info: "#7cb2ff",
  dim: "#9aa3b5",
};

/** `s` cut with an ellipsis to fit `width` pixels in the context's font. */
function clip(ctx: CanvasRenderingContext2D, s: string, width: number): string {
  if (ctx.measureText(s).width <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid).trimEnd()}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

/** Rows a page of this height has room for, and how tall each is. */
export function rowsFit(count: number, top: number, bottom: number, height: number): { rowH: number; shown: number } {
  // Big enough to read from across the lobby: a few rows, not a page of them. Rows that don't all fit close up a
  // little before any is left off.
  const rowH = Math.min(height * 0.15, Math.max(height * 0.11, (bottom - top) / Math.max(1, count)));
  const room = Math.max(1, Math.floor((bottom - top) / rowH));
  // With more than fit, the last row says how many more there are.
  return { rowH, shown: count > room ? room - 1 : count };
}

/**
 * Draw a page: its heading and which page of how many it is, then a big word,
 * rows, lines or the time. A screen with no page yet, or in a photo, which
 * never gets one, is dark: it says nothing rather than something untrue.
 */
export function drawScreen(canvas: HTMLCanvasElement, card: ScreenCard | undefined, page: number, pages: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#18202f");
  g.addColorStop(1, "#0e131d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.04;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const font = (weight: number, size: number) => `${weight} ${Math.round(size)}px system-ui, sans-serif`;
  // Which page of how many: a dot for each, the one up filled.
  if (pages > 1)
    for (let i = 0; i < pages; i++) {
      const r = h * 0.014;
      ctx.beginPath();
      ctx.arc(w - pad - (pages - 1 - i) * r * 3.4 - r, pad + h * 0.04, r, 0, Math.PI * 2);
      ctx.fillStyle = i === page ? "#e8ecf5" : "#3d475c";
      ctx.fill();
    }
  if (!card) return;
  ctx.fillStyle = "#e8ecf5";
  ctx.font = font(700, h * 0.085);
  ctx.fillText(clip(ctx, card.title, w - pad * 3 - pages * h * 0.05), pad, pad);
  let y = pad + h * 0.15;
  const bottom = h - pad;
  if (card.clock) {
    const now = new Date();
    ctx.font = font(700, h * 0.3);
    ctx.fillText(clockTime(now.getTime()), pad, y);
    ctx.fillStyle = "#9aa3b5";
    ctx.font = font(500, h * 0.075);
    ctx.fillText(now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }), pad, y + h * 0.36);
    return;
  }
  if (card.big) {
    ctx.fillStyle = card.big.tone ? TONES[card.big.tone] : "#e8ecf5";
    ctx.font = font(700, h * 0.17);
    ctx.fillText(clip(ctx, card.big.text, w - pad * 2), pad, y);
    y += h * 0.21;
    if (card.big.sub) {
      ctx.fillStyle = "#9aa3b5";
      ctx.font = font(500, h * 0.07);
      ctx.fillText(clip(ctx, card.big.sub, w - pad * 2), pad, y);
      y += h * 0.1;
    }
  }
  if (card.lines?.length) {
    ctx.font = font(500, h * 0.068);
    for (const line of card.lines) {
      if (y + h * 0.08 > bottom) break;
      ctx.fillStyle = "#c9d0dd";
      ctx.fillText(clip(ctx, line, w - pad * 2), pad, y);
      y += h * 0.095;
    }
  }
  const rows = card.rows ?? [];
  if (rows.length) {
    const { rowH, shown } = rowsFit(rows.length, y, bottom, h);
    for (const row of rows.slice(0, shown)) {
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fillRect(pad, y, w - pad * 2, rowH * 0.86);
      let x = pad + rowH * 0.25;
      const size = rowH * 0.44;
      const mid = y + rowH * 0.43 - size / 2;
      if (row.tag) {
        ctx.font = font(700, size * 0.8);
        const tw = Math.min(ctx.measureText(row.tag.text).width, w * 0.22);
        ctx.fillStyle = TONES[row.tag.tone];
        ctx.fillRect(x, mid - size * 0.05, tw + size * 0.6, size * 1.1);
        ctx.fillStyle = "#10151f";
        ctx.fillText(clip(ctx, row.tag.text, w * 0.22), x + size * 0.3, mid + size * 0.1);
        x += tw + size * 1.0;
      }
      let metaW = 0;
      if (row.meta) {
        ctx.font = font(500, size * 0.9);
        const meta = clip(ctx, row.meta, w * 0.3);
        metaW = ctx.measureText(meta).width + size;
        ctx.fillStyle = "#9aa3b5";
        ctx.textAlign = "right";
        ctx.fillText(meta, w - pad - rowH * 0.25, mid + size * 0.05);
        ctx.textAlign = "left";
      }
      ctx.fillStyle = "#e8ecf5";
      ctx.font = font(600, size);
      ctx.fillText(clip(ctx, row.text, w - pad - rowH * 0.25 - metaW - x), x, mid);
      y += rowH;
    }
    if (shown < rows.length) {
      ctx.fillStyle = "#9aa3b5";
      ctx.font = font(500, rowH * 0.38);
      ctx.fillText(`+${rows.length - shown} more`, pad + rowH * 0.25, y + rowH * 0.15);
    }
  } else if (!card.big && !card.lines?.length && card.empty) {
    ctx.fillStyle = "#9aa3b5";
    ctx.font = font(500, h * 0.075);
    ctx.fillText(clip(ctx, card.empty, w - pad * 2), pad, y);
  }
}

/**
 * Text in two lines at most, broken between words, the second cut short with
 * an ellipsis when it all doesn't fit; `width` measures a piece of text.
 */
export function twoLines(text: string, room: number, width: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  let first = "";
  let i = 0;
  for (; i < words.length; i++) {
    const next = first ? `${first} ${words[i]}` : (words[i] ?? "");
    if (width(next) > room && first) break;
    first = next;
  }
  const rest = words.slice(i).join(" ");
  if (!rest) return [first];
  if (width(rest) <= room) return [first, rest];
  let lo = 0;
  let hi = rest.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(`${rest.slice(0, mid).trimEnd()}…`) <= room) lo = mid;
    else hi = mid - 1;
  }
  return [first, `${rest.slice(0, lo).trimEnd()}…`];
}

/**
 * A card on a strip much wider than it is tall (a room ticker): its title on
 * an amber block at the left, and its first row big beside it, who said it
 * after. What a ticker shows from across a room. A card with no title (the
 * ticker of the meeting room it hangs in, whose name says nothing the room
 * doesn't) has the amber block alone, and its line two rows to be read in.
 */
export function drawStrip(canvas: HTMLCanvasElement, card: ScreenCard) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#14171d");
  g.addColorStop(1, "#0b0d11");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const font = (weight: number, size: number) => `${weight} ${Math.round(size)}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  // The room's name as big as fits in up to two fifths of the strip, never smaller than reads.
  let size = h * 0.26;
  ctx.font = font(800, size);
  const fits = w * 0.4 - h * 0.5;
  const wide = ctx.measureText(card.title).width;
  if (wide > fits) {
    size = Math.max(h * 0.17, (size * fits) / wide);
    ctx.font = font(800, size);
  }
  const block = Math.min(w * 0.4, ctx.measureText(card.title).width + h * 0.5);
  ctx.fillStyle = "#e2a23b";
  ctx.fillRect(0, 0, block, h);
  ctx.fillStyle = "#1a1408";
  ctx.fillText(clip(ctx, card.title, block - h * 0.4), h * 0.25, h / 2);
  if (!card.title) {
    // The live dot alone, as the strip read close up has beside its name.
    ctx.fillStyle = "#c0392b";
    ctx.beginPath();
    ctx.arc(block / 2, h / 2, h * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  const row = card.rows?.[0];
  const x = block + h * 0.3;
  const room = w - x - h * 0.3;
  if (!row) {
    ctx.fillStyle = "#8a93a6";
    ctx.font = font(600, h * 0.3);
    ctx.fillText(clip(ctx, card.empty ?? "", room), x, h / 2);
    return;
  }
  // Who said it, small, over what they said, big: the line is what reads from across a room.
  if (!card.title) {
    if (row.meta) {
      ctx.fillStyle = "#9fb4ff";
      ctx.font = font(700, h * 0.17);
      ctx.fillText(clip(ctx, row.meta, room), x, h * 0.18);
    }
    ctx.fillStyle = "#f4f1e8";
    ctx.font = font(600, h * 0.27);
    const lines = twoLines(row.text, room, (t) => ctx.measureText(t).width);
    const top = row.meta ? h * 0.47 : lines.length > 1 ? h * 0.33 : h / 2;
    lines.forEach((line, i) => {
      ctx.fillText(line, x, top + i * h * 0.31);
    });
    return;
  }
  if (row.meta) {
    ctx.fillStyle = "#9fb4ff";
    ctx.font = font(700, h * 0.2);
    ctx.fillText(clip(ctx, row.meta, room), x, h * 0.27);
  }
  ctx.fillStyle = "#f4f1e8";
  ctx.font = font(600, h * 0.34);
  ctx.fillText(clip(ctx, row.text, room), x, row.meta ? h * 0.64 : h / 2);
}
