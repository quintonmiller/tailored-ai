import type { WorkflowEngine } from "../workflows/engine.js";

/**
 * Polls one or more RSS / Atom feeds on an interval and fires a workflow
 * once per *new* entry it hasn't seen before.
 *
 * Parsing is regex-based on purpose: avoids a new XML dependency and works
 * fine for the well-defined subset of `<item>` / `<entry>` tags every
 * mainstream feed emits. Pathological feeds fall back to whatever pieces
 * the regex can extract.
 *
 * Dedupe state lives in memory; restarting the process re-primes from the
 * current feed contents (no fires until something new shows up).
 */

export interface RssTriggerConfig {
  /** Feed URL (RSS 2.0 or Atom). */
  url: string;
  /** Poll interval in seconds. Default 600 (10 min). Min 60. */
  intervalSeconds?: number;
  /** Optional case-insensitive substring filter against entry titles. */
  matchTitle?: string;
}

export interface RssPollerOptions {
  workflowEngine: WorkflowEngine;
  /** Override the fetch impl for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the clock (ms epoch) for tests. */
  now?: () => number;
}

export interface RssEntry {
  id: string;
  title: string;
  link: string;
  summary: string;
  published_at: string;
  author: string;
}

interface Registration {
  workflowName: string;
  config: RssTriggerConfig;
  intervalSeconds: number;
  seen: Set<string>;
  timer: ReturnType<typeof setInterval>;
}

const MIN_INTERVAL_SECONDS = 60;
const DEFAULT_INTERVAL_SECONDS = 600;

export class RssPoller {
  private opts: RssPollerOptions;
  private regs: Registration[] = [];
  private fetchImpl: typeof fetch;

  constructor(opts: RssPollerOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  register(workflowName: string, config: RssTriggerConfig): void {
    const interval = Math.max(config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS);
    const reg: Registration = {
      workflowName,
      config,
      intervalSeconds: interval,
      seen: new Set(),
      timer: setInterval(() => this.poll(reg).catch(() => undefined), interval * 1000),
    };
    this.regs.push(reg);
    // Priming pass — populates seen so registration doesn't fire the whole
    // feed history at once.
    this.prime(reg).catch((err: Error) => {
      console.warn(`[rss-poll] priming "${workflowName}" failed: ${err.message}`);
    });
  }

  stop(): void {
    for (const r of this.regs) clearInterval(r.timer);
    this.regs = [];
  }

  size(): number {
    return this.regs.length;
  }

  private async prime(reg: Registration): Promise<void> {
    const entries = await this.fetchEntries(reg.config.url);
    for (const e of entries) reg.seen.add(e.id);
  }

  private async poll(reg: Registration): Promise<void> {
    let entries: RssEntry[];
    try {
      entries = await this.fetchEntries(reg.config.url);
    } catch (err) {
      console.warn(`[rss-poll] fetch failed for "${reg.workflowName}": ${(err as Error).message}`);
      return;
    }
    const fresh = entries.filter((e) => !reg.seen.has(e.id));
    for (const e of fresh) reg.seen.add(e.id);
    const match = reg.config.matchTitle?.toLowerCase();
    for (const entry of fresh) {
      if (match && !entry.title.toLowerCase().includes(match)) continue;
      try {
        await this.opts.workflowEngine.runWorkflow(
          reg.workflowName,
          { ...entry, url: reg.config.url },
          "programmatic",
        );
      } catch (err) {
        console.warn(
          `[rss-poll] failed to fire workflow "${reg.workflowName}" for entry ${entry.id}: ${(err as Error).message}`,
        );
      }
    }
    if (reg.seen.size > 5000) {
      reg.seen = new Set([...reg.seen].slice(-2000));
    }
  }

  private async fetchEntries(url: string): Promise<RssEntry[]> {
    const res = await this.fetchImpl(url, { headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`);
    }
    const body = await res.text();
    return parseFeed(body);
  }
}

/**
 * Parse an RSS 2.0 or Atom feed into a flat list of entries. Exported for
 * unit tests. Tolerant: anything missing falls back to empty strings; the
 * dedupe `id` falls back to `link || title` when `<guid>` / `<id>` are absent.
 */
export function parseFeed(body: string): RssEntry[] {
  // Atom uses <entry>; RSS uses <item>. Many WordPress feeds emit both. Try
  // RSS first since it's by far the most common shape; fall back to Atom if
  // there are no <item> blocks.
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const items = body.match(itemRegex);
  if (items && items.length > 0) {
    return items.map(parseRssItem);
  }
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  const entries = body.match(entryRegex);
  if (entries && entries.length > 0) {
    return entries.map(parseAtomEntry);
  }
  return [];
}

function parseRssItem(block: string): RssEntry {
  const title = extractTag(block, "title") || "";
  const link = extractTag(block, "link") || "";
  const guid = extractTag(block, "guid") || "";
  const summary =
    extractTag(block, "description") ||
    extractTag(block, "content:encoded") ||
    "";
  const published = extractTag(block, "pubDate") || extractTag(block, "dc:date") || "";
  const author = extractTag(block, "author") || extractTag(block, "dc:creator") || "";
  return {
    id: guid || link || title,
    title: cleanText(title),
    link: cleanText(link),
    summary: cleanText(summary),
    published_at: cleanText(published),
    author: cleanText(author),
  };
}

function parseAtomEntry(block: string): RssEntry {
  const title = extractTag(block, "title") || "";
  const id = extractTag(block, "id") || "";
  const summary = extractTag(block, "summary") || extractTag(block, "content") || "";
  const published = extractTag(block, "published") || extractTag(block, "updated") || "";
  const linkMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  const link = linkMatch?.[1] ?? "";
  const authorMatch = /<author\b[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/i.exec(block);
  const author = authorMatch?.[1] ?? "";
  return {
    id: id || link || title,
    title: cleanText(title),
    link: cleanText(link),
    summary: cleanText(summary),
    published_at: cleanText(published),
    author: cleanText(author),
  };
}

function extractTag(block: string, tag: string): string {
  // Escape `:` so namespaced tags like `dc:creator` match cleanly.
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i");
  const m = re.exec(block);
  return m?.[1] ?? "";
}

function cleanText(text: string): string {
  // Strip CDATA wrappers and decode the handful of entities that show up in
  // every feed. Anything more exotic stays as-is — the workflow can post-
  // process via agent_run if needed.
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}
