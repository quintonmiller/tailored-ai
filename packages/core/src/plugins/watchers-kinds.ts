/**
 * The two kinds of watcher the watchers plugin brings: `page`, whether a
 * page's readable text changed, and `price`, whether a price on a page moved.
 * Both are written to the contract in `watchers/registry.ts`, and registered
 * through `ctx.watcherKinds` like any plugin's kind.
 *
 * Their settings are plain words, never selectors or patterns: an address,
 * and a phrase that says which part of the page matters. A model of any size
 * can write those, and a person can read them on the State page.
 */
import { createHash } from "node:crypto";
import { stripHtmlToText } from "../tools/web-fetch.js";
import type { WatcherCheckContext, WatcherKind } from "../watchers/registry.js";
import { clip } from "./watchers-records.js";

/** Lines of a page a `page` watch tells apart, to say which are new. Past these, it only knows the text changed. */
const TRACKED_LINES = 150;
/** How far from the phrase a price may be and still count as the one near it, in characters. */
const NEAR_CHARS = 150;
/** Default for `threshold`: how far a price moves, in percent, before it is reported. */
export const DEFAULT_THRESHOLD = 2;

const URL_SETTING = {
  type: "string",
  pattern: "^https?://",
  maxLength: 2000,
  description: "The page's address, starting http:// or https://.",
} as const;

// ----------------------------------------------------------------- reading

/**
 * A page's readable text, one block per line: `web_fetch`'s HTML-to-text, with
 * the entities it leaves (numeric ones, and currency names such as `&euro;`)
 * decoded too, since a price is often written that way.
 *
 * A non-breaking space between two digits is kept, as a narrow one, because
 * it is how much of Europe groups thousands (`1&nbsp;234,50&nbsp;€`), and
 * folding it to a plain space would read that price as 234.50. Every other
 * non-breaking space becomes a plain one, so a phrase typed with spaces still
 * finds `Opening&nbsp;hours`.
 */
export function readableText(body: string, contentType: string): string {
  const html = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  // web_fetch turns `&nbsp;` into a plain space; it is kept here until the digits around it are seen.
  const text = html ? stripHtmlToText(body.replace(/&nbsp;/gi, "\u00a0")) : body;
  return decodeEntities(text)
    .split("\n")
    .map((line) =>
      line
        .replace(/(?<=\d)[\u00a0\u202f](?=\d)/g, "\u202f")
        .replace(/[ \t\u00a0]+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

const NAMED: Record<string, string> = {
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  nbsp: "\u00a0",
  ndash: "–",
  mdash: "—",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,7});/g, (m, n) => codePoint(Number(n)) ?? m)
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => codePoint(Number.parseInt(n, 16)) ?? m)
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function codePoint(n: number): string | undefined {
  try {
    return String.fromCodePoint(n);
  } catch {
    return undefined;
  }
}

/** The page's `<title>`, when it has one. */
function titleOf(body: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  const title = match ? decodeEntities(stripHtmlToText(match[1])).replace(/\s+/g, " ").trim() : "";
  return title || undefined;
}

/** Fetch a page and read it, or throw, in a sentence, why it couldn't be read. */
async function fetchPage(url: string, ctx: WatcherCheckContext): Promise<{ body: string; text: string }> {
  const get = ctx.fetch ?? fetch;
  const host = hostOf(url);
  const res = await get(url, { signal: ctx.signal });
  if (!res.ok) throw new Error(`${host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text|html|json|xml/i.test(type))
    throw new Error(`${host} sent ${type.split(";")[0]}, not a page of text.`);
  const body = await res.text();
  return { body, text: readableText(body, type) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function hash(text: string, chars = 16): string {
  return createHash("sha256").update(text).digest("hex").slice(0, chars);
}

/** A phrase in quotes, the way a change line names it. */
function quoted(text: string, max = 80): string {
  return `“${clip(text, max)}”`;
}

// -------------------------------------------------------------------- page

export interface PageConfig {
  url: string;
  contains?: string;
}

/** What a `page` watch keeps: the text's hash and its lines' hashes, or the part around the phrase. */
export type PageSnapshot =
  | { hash: string; lines: string[] }
  | { found: true; hash: string; part: string }
  | { found: false };

/**
 * The part of the page around a phrase: the line it is on, and the next line
 * too when the phrase ends its line, the way a heading or a label does, so
 * "Tickets" followed by "Sold out" reads as one. Undefined when the phrase
 * isn't on the page.
 */
export function partAround(text: string, phrase: string): string | undefined {
  const lines = text.split("\n");
  const want = phrase.toLowerCase();
  const i = lines.findIndex((line) => line.toLowerCase().includes(want));
  if (i < 0) return undefined;
  const line = lines[i];
  const next = lines[i + 1];
  const label = line
    .toLowerCase()
    .replace(/[\s:.\-–—]+$/, "")
    .endsWith(want);
  return label && next ? `${line} ${next}` : line;
}

export const pageKind: WatcherKind<PageConfig, PageSnapshot> = {
  kind: "page",
  description: "Whether a page's readable text changed, or only the part around a phrase you name.",
  schema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: URL_SETTING,
      contains: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Only watch the part of the page around this phrase, such as tickets or opening hours.",
      },
    },
  },
  defaultEvery: "1h",
  minEvery: "15m",
  async check(config, previous, ctx) {
    const { body, text } = await fetchPage(config.url, ctx);
    const phrase = config.contains?.trim();
    if (phrase) {
      const part = partAround(text, phrase);
      const snapshot: PageSnapshot = part ? { found: true, hash: hash(part), part: clip(part, 200) } : { found: false };
      const value = part ? clip(part, 120) : `${quoted(phrase, 60)} isn't on the page`;
      // A snapshot of another shape (the whole page, or one a person edited) is no baseline for this.
      if (!previous || !("found" in previous) || (previous.found && typeof previous.hash !== "string")) {
        return { snapshot, value };
      }
      if (!previous.found && part)
        return { snapshot, value, change: `${quoted(phrase)} is on the page now: ${quoted(part, 160)}.` };
      if (previous.found && !part) return { snapshot, value, change: `${quoted(phrase)} is no longer on the page.` };
      if (previous.found && part && previous.hash !== hash(part)) {
        return {
          snapshot,
          value,
          change: `The part around ${quoted(phrase, 60)} changed: now ${quoted(part, 140)}, was ${quoted(String(previous.part ?? ""), 80)}.`,
        };
      }
      return { snapshot, value };
    }

    const lines = text.split("\n");
    const tracked = [...new Set(lines.map((line) => hash(line, 6)))].slice(0, TRACKED_LINES);
    const snapshot: PageSnapshot = { hash: hash(text), lines: tracked };
    const value = titleOf(body) ?? clip(lines[0] ?? "", 120);
    if (!previous || !("lines" in previous) || !Array.isArray(previous.lines) || previous.hash === snapshot.hash) {
      return { snapshot, value };
    }
    return { snapshot, value, change: describeLines(lines, previous.lines) };
  },
};

/** One line saying how a page's text changed, given its lines now and the hashes of its lines before. */
function describeLines(lines: string[], before: string[]): string {
  const had = new Set(before);
  const now = new Set<string>();
  const added: string[] = [];
  for (const line of lines) {
    const h = hash(line, 6);
    if (now.has(h)) continue;
    now.add(h);
    if (now.size <= TRACKED_LINES && !had.has(h)) added.push(line);
  }
  const gone = before.filter((h) => !now.has(h)).length;
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (added.length === 0 && gone === 0)
    return "The page's text changed, though no line it was watching is new or gone.";
  const parts = [
    ...(added.length ? [count(added.length, "new line")] : []),
    ...(gone ? [`${count(gone, "line")} gone`] : []),
  ];
  const first = added.length ? ` First new: ${quoted(added[0], 160)}.` : "";
  return `The page changed: ${parts.join(", ")}.${first}`;
}

// ------------------------------------------------------------------- price

export interface PriceConfig {
  url: string;
  near?: string;
  threshold?: number;
}

/** What a `price` watch keeps: the price it last reported, which every later one is measured from. */
export interface PriceSnapshot {
  amount: number;
  currency: string;
  text: string;
}

export interface FoundPrice {
  amount: number;
  /** The currency as the page writes it, upper-cased: `€`, `US$`, `EUR`. */
  currency: string;
  /** The price as the page writes it, spaces folded: `€182`, `1.234,50 €`. */
  text: string;
}

const SYMBOLS = "€$£¥₹₩₽₺₪฿₫₴₦₱";
const CODES =
  "EUR|USD|GBP|JPY|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK|HUF|INR|BRL|MXN|CNY|HKD|SGD|ZAR|TRY|ILS|THB|KRW|RON|BGN|ISK";
const CURRENCY = `(?:[A-Z]{1,2}\\$|[${SYMBOLS}]|(?<![A-Za-z])(?:${CODES})(?![A-Za-z]))`;
// Thousands in groups of three (with a comma, a dot or a non-breaking space, which `readableText` keeps), then up to two decimals.
const AMOUNT = "\\d{1,3}(?:[.,\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?";
const PRICE = new RegExp(`(${CURRENCY})\\s?(${AMOUNT})|(${AMOUNT})\\s?(${CURRENCY})`, "g");

/**
 * Every price in `text`, in order. A comma or dot followed by one or two
 * digits at the end is the decimal point; the rest are thousands, so
 * `1,234.50`, `1.234,50` and `1 234,50` all read as 1234.5.
 */
export function pricesIn(text: string): Array<FoundPrice & { start: number; end: number }> {
  const found: Array<FoundPrice & { start: number; end: number }> = [];
  for (const m of text.matchAll(PRICE)) {
    const currency = (m[1] ?? m[4] ?? "").toUpperCase();
    const amount = parseAmount(m[2] ?? m[3] ?? "");
    if (amount === undefined) continue;
    const start = m.index ?? 0;
    found.push({ amount, currency, text: m[0].replace(/\s+/g, " "), start, end: start + m[0].length });
  }
  return found;
}

export function parseAmount(raw: string): number | undefined {
  const digits = raw.replace(/[\u00a0\u202f ]/g, "");
  const last = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  const decimals = last >= 0 ? digits.length - last - 1 : 0;
  const normal =
    last >= 0 && decimals <= 2
      ? `${digits.slice(0, last).replace(/[.,]/g, "")}.${digits.slice(last + 1)}`
      : digits.replace(/[.,]/g, "");
  const amount = Number(normal);
  return Number.isFinite(amount) ? amount : undefined;
}

/**
 * The price a watch means: with no phrase, the first on the page; with one,
 * the price nearest the first place the phrase appears, on either side and
 * within {@link NEAR_CHARS} characters, so "€182 per night" and "Per night:
 * €182" both find 182. A tie goes to the one after.
 */
export function findPrice(text: string, near?: string): FoundPrice | undefined {
  const prices = pricesIn(text);
  if (!near?.trim()) return prices[0] ? strip(prices[0]) : undefined;
  const at = text.toLowerCase().indexOf(near.trim().toLowerCase());
  if (at < 0) return undefined;
  const end = at + near.trim().length;
  let best: { price: FoundPrice; gap: number } | undefined;
  for (const p of prices) {
    const gap = p.end <= at ? at - p.end : p.start >= end ? p.start - end : 0;
    if (gap > NEAR_CHARS) continue;
    const after = p.start >= end;
    if (!best || gap < best.gap || (gap === best.gap && after)) best = { price: strip(p), gap };
  }
  return best?.price;
}

function strip(p: FoundPrice): FoundPrice {
  return { amount: p.amount, currency: p.currency, text: p.text };
}

function percent(n: number): string {
  const abs = Math.abs(n);
  return abs >= 1 ? `${Math.round(abs)}%` : `${abs.toFixed(1)}%`;
}

export const priceKind: WatcherKind<PriceConfig, PriceSnapshot> = {
  kind: "price",
  description:
    "Whether a price on a page moved by at least a set percent: the first price there, or the one nearest a phrase you name.",
  schema: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: URL_SETTING,
      near: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "Words next to the price, such as per night or total. Without them, the first price on the page.",
      },
      threshold: {
        type: "number",
        minimum: 0,
        maximum: 100,
        description: `How far it must move, in percent, before you hear. Default ${DEFAULT_THRESHOLD}.`,
      },
    },
  },
  defaultEvery: "2h",
  minEvery: "30m",
  async check(config, previous, ctx) {
    const { text } = await fetchPage(config.url, ctx);
    const near = config.near?.trim();
    if (near && !text.toLowerCase().includes(near.toLowerCase())) {
      throw new Error(`${quoted(near)} isn't on the page.`);
    }
    const price = findPrice(text, near);
    if (!price)
      throw new Error(near ? `There's no price near ${quoted(near)} on the page.` : "There's no price on the page.");
    const now: PriceSnapshot = { amount: price.amount, currency: price.currency, text: price.text };
    if (!previous || typeof previous.amount !== "number" || typeof previous.currency !== "string") {
      return { snapshot: now, value: price.text };
    }
    if (previous.currency !== price.currency) {
      return {
        snapshot: now,
        value: price.text,
        change: `The price is now ${price.text}, in another currency (was ${previous.text}).`,
      };
    }
    const threshold = config.threshold ?? DEFAULT_THRESHOLD;
    const moved =
      previous.amount === 0
        ? price.amount === 0
          ? 0
          : 100
        : ((price.amount - previous.amount) / previous.amount) * 100;
    if (price.amount === previous.amount || Math.abs(moved) < threshold) {
      // The snapshot stays at the price last reported, so a slow drift adds up to a change in the end.
      return { snapshot: previous, value: price.text };
    }
    const way = price.amount < previous.amount ? "fell" : "rose";
    const by = previous.amount === 0 ? "" : ` (${way === "fell" ? "down" : "up"} ${percent(moved)})`;
    return {
      snapshot: now,
      value: price.text,
      change: `The price ${way} from ${previous.text} to ${price.text}${by}.`,
    };
  },
};
