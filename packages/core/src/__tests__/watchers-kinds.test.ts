/**
 * The `page` and `price` kinds, against canned pages, and the `fetch` the
 * runner hands them. No network: every page comes from a fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHostSpacing, watchFetch } from "../plugins/watchers-fetch.js";
import {
  findPrice,
  type PageConfig,
  type PageSnapshot,
  type PriceConfig,
  type PriceSnapshot,
  pageKind,
  parseAmount,
  partAround,
  priceKind,
  readableText,
} from "../plugins/watchers-kinds.js";
import { createEgressPolicy } from "../security/egress-policy.js";
import { registerWatcherKind, type WatcherCheckContext, watcherResult } from "../watchers/registry.js";

/** The page the fake fetch serves, and how. */
let body: string;
let status: number;
let contentType: string;
let requested: string[];

const pageFetch = (async (url: string | URL | Request) => {
  requested.push(String(url));
  return new Response(body, { status, headers: { "content-type": contentType } });
}) as typeof fetch;

function ctx(): WatcherCheckContext {
  return { now: new Date("2026-10-22T10:00:00Z"), signal: new AbortController().signal, fetch: pageFetch };
}

/** Check twice, the way the runner would: a baseline, then the page as it is set now. */
async function page(config: PageConfig, before: string, after: string) {
  body = before;
  const first = watcherResult(await pageKind.check(config, undefined, ctx()), undefined);
  body = after;
  const second = watcherResult(await pageKind.check(config, first.snapshot as PageSnapshot, ctx()), first.snapshot);
  return { first, second };
}

async function price(config: PriceConfig, before: string, after: string) {
  body = before;
  const first = watcherResult(await priceKind.check(config, undefined, ctx()), undefined);
  body = after;
  const second = watcherResult(await priceKind.check(config, first.snapshot as PriceSnapshot, ctx()), first.snapshot);
  return { first, second };
}

const URL_ = "https://hotels.example/lisbon";

function hotel(rooms: string): string {
  return `<!doctype html><html><head><title>Casa Alfama &amp; Rooms</title><style>.x{color:red}</style></head>
<body><script>var t = Date.now();</script><h1>Casa Alfama</h1>${rooms}<p>Free cancellation</p></body></html>`;
}

beforeEach(() => {
  body = "";
  status = 200;
  contentType = "text/html; charset=utf-8";
  requested = [];
  resetHostSpacing();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the page and price kinds", () => {
  it("register cleanly: plain names, one-line descriptions, schemas core checks in full, intervals that read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const kind of [pageKind, priceKind]) registerWatcherKind({ ...kind })();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("reading a page", () => {
  it("is web_fetch's text, with numeric and currency entities decoded too", () => {
    const text = readableText("<p>From &euro;182 &#8364;99 &#x20AC;12 &amp; &pound;5</p><div>next</div>", "text/html");
    expect(text).toBe("From €182 €99 €12 & £5\nnext");
  });

  it("takes the line a phrase is on, and the next one when that line is short", () => {
    const text = "Casa Alfama\nTickets\nSold out\nOpening hours:\n9 to 5\nFree cancellation\nBreakfast included";
    expect(partAround(text, "tickets")).toBe("Tickets Sold out");
    expect(partAround(text, "opening hours")).toBe("Opening hours: 9 to 5");
    expect(partAround(text, "free cancel")).toBe("Free cancellation");
    expect(partAround(text, "late checkout")).toBeUndefined();
  });
});

describe("the page kind", () => {
  it("takes a baseline first, with the title as its reading, and stays quiet while the text is the same", async () => {
    const html = hotel("<p>Double room</p>");
    const { first, second } = await page({ url: URL_ }, html, html);
    expect(first.change).toBeUndefined();
    expect(first.value).toBe("Casa Alfama & Rooms");
    expect(second.change).toBeUndefined();
    expect(requested).toEqual([URL_, URL_]);
  });

  it("says which lines are new and how many went, in one line", async () => {
    const { second } = await page(
      { url: URL_ },
      hotel("<p>Double room</p><p>Twin room</p>"),
      hotel("<p>Double room</p><p>Suite with river view</p><p>Family room</p>"),
    );
    expect(second.change).toBe("The page changed: 2 new lines, 1 line gone. First new: “Suite with river view”.");
  });

  it("ignores what scripts and styles do, which aren't readable text", async () => {
    const { second } = await page(
      { url: URL_ },
      hotel("<p>Double room</p>").replace("Date.now()", "1"),
      hotel("<p>Double room</p>").replace("Date.now()", "2").replace("color:red", "color:blue"),
    );
    expect(second.change).toBeUndefined();
  });

  it("with `contains`, watches only the part around the phrase", async () => {
    const before = hotel("<h2>Tickets</h2><p>4 left</p><p>Updated 10:00</p>");
    const after = hotel("<h2>Tickets</h2><p>Sold out</p><p>Updated 10:30</p>");
    const { first, second } = await page({ url: URL_, contains: "tickets" }, before, after);
    expect(first.value).toBe("Tickets 4 left");
    expect(second.change).toBe("The part around “tickets” changed: now “Tickets Sold out”, was “Tickets 4 left”.");

    // Elsewhere on the page changes nothing it reports.
    const quiet = await page({ url: URL_, contains: "tickets" }, before, before.replace("10:00", "11:00"));
    expect(quiet.second.change).toBeUndefined();
  });

  it("with `contains`, says when the phrase appears or goes", async () => {
    const without = hotel("<p>Double room</p>");
    const withIt = hotel("<p>Double room</p><p>Late checkout available</p>");
    const appeared = await page({ url: URL_, contains: "late checkout" }, without, withIt);
    expect(appeared.first.value).toBe("“late checkout” isn't on the page");
    expect(appeared.second.change).toBe("“late checkout” is on the page now: “Late checkout available”.");
    const gone = await page({ url: URL_, contains: "late checkout" }, withIt, without);
    expect(gone.second.change).toBe("“late checkout” is no longer on the page.");
  });

  it("throws, as the contract asks, when the page can't be read", async () => {
    status = 404;
    await expect(pageKind.check({ url: URL_ }, undefined, ctx())).rejects.toThrow("hotels.example answered 404.");
    status = 200;
    contentType = "application/pdf";
    await expect(pageKind.check({ url: URL_ }, undefined, ctx())).rejects.toThrow(
      "hotels.example sent application/pdf, not a page of text.",
    );
  });

  it("refuses settings a model might reach for that aren't plain words", () => {
    expect(pageKind.schema.additionalProperties).toBe(false);
    expect(Object.keys(pageKind.schema.properties ?? {})).toEqual(["url", "contains"]);
  });
});

describe("finding a price", () => {
  it.each([
    ["182", 182],
    ["1,234", 1234],
    ["1,234.50", 1234.5],
    ["1.234,50", 1234.5],
    ["1 234,50", 1234.5],
    ["12.99", 12.99],
    ["12,9", 12.9],
    ["182.000", 182000],
  ])("reads %s as %d", (raw, want) => {
    expect(parseAmount(raw)).toBe(want);
  });

  it("finds the first price, or the one nearest the phrase on either side", () => {
    const text = "Rooms from €150\nDouble room €182 per night\nSuite €310 per night";
    expect(findPrice(text)?.text).toBe("€150");
    expect(findPrice(text, "per night")).toEqual({ amount: 182, currency: "€", text: "€182" });
    expect(findPrice("Per night: US$ 199.00", "per night")).toEqual({
      amount: 199,
      currency: "US$",
      text: "US$ 199.00",
    });
    expect(findPrice("Total 1.234,50 EUR incl. taxes", "total")).toEqual({
      amount: 1234.5,
      currency: "EUR",
      text: "1.234,50 EUR",
    });
    expect(findPrice("Was £120, now £99 per night", "per night")?.amount).toBe(99);
    expect(findPrice("No numbers here", "per night")).toBeUndefined();
  });
});

describe("the price kind", () => {
  it("takes a baseline first and reports a move past the threshold in one line", async () => {
    const { first, second } = await price(
      { url: URL_, near: "per night" },
      hotel("<p>Double room €212 per night</p>"),
      hotel("<p>Double room €182 per night</p>"),
    );
    expect(first.change).toBeUndefined();
    expect(first.value).toBe("€212");
    expect(second.change).toBe("The price fell from €212 to €182 (down 14%).");
    expect(second.snapshot).toEqual({ amount: 182, currency: "€", text: "€182" });
  });

  it("stays quiet under the threshold, measured from the price it last reported, so a slow drift adds up", async () => {
    const config = { url: URL_, near: "per night", threshold: 5 };
    body = hotel("<p>€200 per night</p>");
    const base = watcherResult(await priceKind.check(config, undefined, ctx()), undefined);
    body = hotel("<p>€196 per night</p>");
    const small = watcherResult(await priceKind.check(config, base.snapshot as PriceSnapshot, ctx()), base.snapshot);
    expect(small.change).toBeUndefined();
    expect(small.value).toBe("€196");
    expect(small.snapshot).toEqual(base.snapshot);
    body = hotel("<p>€189 per night</p>");
    const drift = watcherResult(await priceKind.check(config, small.snapshot as PriceSnapshot, ctx()), small.snapshot);
    expect(drift.change).toBe("The price fell from €200 to €189 (down 6%).");
  });

  it("says when it rose, and when the page switched currency", async () => {
    const rose = await price({ url: URL_ }, hotel("<p>$100</p>"), hotel("<p>$110</p>"));
    expect(rose.second.change).toBe("The price rose from $100 to $110 (up 10%).");
    const other = await price({ url: URL_ }, hotel("<p>€100</p>"), hotel("<p>$100</p>"));
    expect(other.second.change).toBe("The price is now $100, in another currency (was €100).");
  });

  it("throws when the phrase or the price isn't there, so a sold-out page counts as a failed check", async () => {
    body = hotel("<p>Sold out</p>");
    await expect(priceKind.check({ url: URL_, near: "per night" }, undefined, ctx())).rejects.toThrow(
      "“per night” isn't on the page.",
    );
    await expect(priceKind.check({ url: URL_ }, undefined, ctx())).rejects.toThrow("There's no price on the page.");
    body = hotel("<p>Call us for the price per night</p>");
    await expect(priceKind.check({ url: URL_, near: "per night" }, undefined, ctx())).rejects.toThrow(
      "There's no price near “per night” on the page.",
    );
  });
});

describe("the fetch a check is handed", () => {
  const fake = vi.fn<typeof fetch>();
  let clock: number;

  function guarded(policy = createEgressPolicy({ allowHosts: ["hotels.example", "cdn.example"] })) {
    return watchFetch({ policy: () => policy, spacingMs: 10_000, maxBytes: 1000, now: () => clock, fetch: fake });
  }

  beforeEach(() => {
    clock = 0;
    fake.mockReset();
    fake.mockImplementation(async () => new Response("ok", { status: 200 }));
  });

  it("says it is web_fetch, and asks for text", async () => {
    await guarded()(URL_);
    const headers = new Headers(fake.mock.calls[0][1]?.headers);
    expect(headers.get("user-agent")).toBe("autonomous-agent/0.1 (bot)");
    expect(headers.get("accept")).toContain("text/html");
  });

  it("honours the egress policy, before asking and at every redirect", async () => {
    const strict = createEgressPolicy({}, async () => ["10.0.0.5"]);
    await expect(guarded(strict)("https://intranet.example/")).rejects.toThrow(
      "intranet.example is not reachable from here: private (RFC1918) (resolves to 10.0.0.5).",
    );
    expect(fake).not.toHaveBeenCalled();

    fake.mockImplementationOnce(
      async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
    );
    const policy = createEgressPolicy({ allowHosts: ["hotels.example"] });
    await expect(guarded(policy)(URL_)).rejects.toThrow("169.254.169.254 is not reachable from here");
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect it may", async () => {
    fake.mockImplementationOnce(
      async () => new Response(null, { status: 301, headers: { location: "https://cdn.example/x" } }),
    );
    const res = await guarded()(URL_);
    expect(await res.text()).toBe("ok");
    expect(fake.mock.calls.map((c) => String(c[0]))).toEqual([URL_, "https://cdn.example/x"]);
  });

  it("refuses an answer over the size limit", async () => {
    fake.mockImplementation(async () => new Response("x".repeat(1001)));
    await expect(guarded()(URL_)).rejects.toThrow("hotels.example sent more than the 1 KB a watch reads.");
    clock += 10_000;
    fake.mockImplementation(async () => new Response("x", { headers: { "content-length": "5000" } }));
    await expect(guarded()(URL_)).rejects.toThrow("hotels.example sent 5 KB, over the 1 KB a watch reads.");
  });

  it("asks one host at most once per spacing, queueing the rest", async () => {
    vi.useFakeTimers();
    const get = guarded();
    await get(URL_);
    const second = get(`${URL_}?b`);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake).toHaveBeenCalledTimes(1);
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await second;
    expect(fake).toHaveBeenCalledTimes(2);
    // Another host doesn't wait.
    await get("https://cdn.example/");
    expect(fake).toHaveBeenCalledTimes(3);
  });
});
