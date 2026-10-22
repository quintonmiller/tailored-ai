/**
 * The watcher-kind seam: the registry, the checks a runner makes before it
 * trusts a watch or a result, and a sample kind written to the contract.
 *
 * Core runs no watches, so nothing here schedules one. The baseline rule (a
 * first check reports no change) is the kind's to keep and the runner's to
 * enforce; `watcherResult` holds it as well, and both halves are tested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { createPluginContext, type PluginContext } from "../plugin-context.js";
import { loadPlugins } from "../plugins.js";
import {
  getWatcherKind,
  listWatcherKinds,
  MAX_WATCH_CHANGE_CHARS,
  MAX_WATCH_SNAPSHOT_BYTES,
  registerWatcherKind,
  validateWatchConfig,
  type WatcherCheckContext,
  WatcherError,
  type WatcherKind,
  watcherKindRegistry,
  watcherResult,
  watchInterval,
} from "../watchers/registry.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let disposers: Array<() => void> = [];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  disposers = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const d of disposers.splice(0)) d();
  vi.restoreAllMocks();
});

/** A kind that checks nothing, for registry tests. */
const stub = (over: Partial<WatcherKind> = {}): WatcherKind => ({
  kind: "test_stub",
  description: "Checks nothing.",
  schema: { type: "object", properties: {} },
  defaultEvery: "1h",
  minEvery: "15m",
  check: () => ({ snapshot: { n: 0 } }),
  ...over,
});

const register = (kind: WatcherKind<any, any>) => {
  const dispose = registerWatcherKind(kind);
  disposers.push(dispose);
  return dispose;
};

/**
 * A sample kind written to the contract: the price a URL reports. It sets a
 * baseline on its first check, reports a change only when the price moved,
 * uses the runner's fetch and signal, and throws when the page won't answer.
 */
const price: WatcherKind<{ url: string }, { price: number }> = {
  kind: "test_price",
  description: "Whether the price at a URL moved.",
  schema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", pattern: "^https?://" } },
    additionalProperties: false,
  },
  defaultEvery: "1h",
  minEvery: "15m",
  async check(config, previous, ctx) {
    const res = await (ctx.fetch ?? fetch)(config.url, { signal: ctx.signal });
    if (!res.ok) throw new Error(`${config.url} answered ${res.status}`);
    const now = ((await res.json()) as { price: number }).price;
    const snapshot = { price: now };
    if (previous === undefined || previous.price === now) return { snapshot, value: now };
    const moved = now < previous.price ? "fell" : "rose";
    return { snapshot, value: now, change: `The price ${moved} from ${previous.price} to ${now}.` };
  },
};

/** A fetch that answers each call with the next of `answers`: a price, or an HTTP status to fail with. */
function pages(...answers: Array<number | { status: number }>): typeof fetch {
  return (async () => {
    const next = answers.shift();
    if (typeof next === "object") return new Response("", { status: next.status });
    return new Response(JSON.stringify({ price: next }), { status: 200 });
  }) as typeof fetch;
}

const ctxWith = (f: typeof fetch): WatcherCheckContext => ({
  now: new Date("2026-10-21T12:00:00Z"),
  signal: new AbortController().signal,
  fetch: f,
});

describe("the watcher-kind registry", () => {
  it("registers a kind, finds and lists it, and the disposer takes it back", () => {
    const dispose = register(stub());
    expect(getWatcherKind("test_stub")?.description).toBe("Checks nothing.");
    expect(listWatcherKinds().map((k) => k.kind)).toContain("test_stub");

    dispose();
    expect(getWatcherKind("test_stub")).toBeUndefined();
    expect(listWatcherKinds().map((k) => k.kind)).not.toContain("test_stub");
  });

  it("lists kinds in the order they came", () => {
    register(stub({ kind: "test_b" }));
    register(stub({ kind: "test_a" }));
    const ours = listWatcherKinds()
      .map((k) => k.kind)
      .filter((k) => k.startsWith("test_"));
    expect(ours).toEqual(["test_b", "test_a"]);
  });

  it("leaves a kind someone registered after it in place when the first disposer runs", () => {
    const first = register(stub());
    const second = stub({ description: "The replacement." });
    register(second);
    first();
    expect(getWatcherKind("test_stub")).toBe(second);
  });

  it("refuses a kind no runner could use, saying what to fix", () => {
    const refusals: Array<[Partial<WatcherKind>, RegExp]> = [
      [{ kind: "Page" }, /lowercase and starts with a letter/],
      [{ kind: "" }, /lowercase/],
      [{ description: " " }, /needs a description/],
      [{ schema: undefined as never }, /needs a schema/],
      [{ check: undefined as never }, /needs a check function/],
      [{ minEvery: "often" }, /minEvery is a length of time .* not "often"/],
      [{ defaultEvery: "weekdays at 9am" }, /defaultEvery is a length of time/],
      [{ defaultEvery: "5m", minEvery: "15m" }, /defaultEvery \(5m\) is shorter than its own minEvery \(15m\)/],
    ];
    for (const [over, message] of refusals) {
      expect(() => register(stub(over)), JSON.stringify(over)).toThrow(message);
    }
    expect(watcherKindRegistry.has("test_stub")).toBe(false);
  });

  it("says which schema keywords it can't check, and registers the kind anyway", () => {
    register(stub({ schema: { type: "object", properties: { url: { type: "string", format: "uri" } } } }));
    expect(getWatcherKind("test_stub")).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("url: format"));
  });
});

describe("a watch's config", () => {
  it("passes when it fits the kind's schema", () => {
    expect(validateWatchConfig(price, { url: "https://shop.example/item" })).toEqual([]);
  });

  it("names every way it doesn't, as corrections", () => {
    expect(validateWatchConfig(price, {})).toEqual(["`url` is required"]);
    expect(validateWatchConfig(price, { url: 5 })).toEqual(["`url` must be a string (got number 5)"]);
    expect(validateWatchConfig(price, { url: "ftp://x", every: "1h" })).toEqual([
      "`url` must match the pattern ^https?://",
      "`every` is not a field of this type (fields: url)",
    ]);
  });

  it("is an object", () => {
    expect(validateWatchConfig(price, "https://shop.example")).toEqual([
      'A test_price watch\'s config is an object of its settings, not "https://shop.example".',
    ]);
    expect(validateWatchConfig(price, undefined)[0]).toMatch(/is an object of its settings, not undefined/);
    expect(validateWatchConfig(price, [])[0]).toMatch(/not \[\]/);
  });
});

describe("a watch's interval", () => {
  it("is the kind's default when the watch names none", () => {
    expect(watchInterval(price)).toEqual({ ms: HOUR });
    expect(watchInterval(price, "")).toEqual({ ms: HOUR });
  });

  it("reads the words tend and schedules use", () => {
    expect(watchInterval(price, "2 hours")).toEqual({ ms: 2 * HOUR });
    expect(watchInterval(price, "30m")).toEqual({ ms: 30 * MINUTE });
    expect(watchInterval(price, "1 day")).toEqual({ ms: 24 * HOUR });
    expect(watchInterval(price, "15 minutes")).toEqual({ ms: 15 * MINUTE });
  });

  it("is raised to the kind's floor, and says what was asked for", () => {
    expect(watchInterval(price, "1m")).toEqual({ ms: 15 * MINUTE, raisedFrom: MINUTE });
    expect(watchInterval(price, "30 seconds")).toEqual({ ms: 15 * MINUTE, raisedFrom: 30_000 });
  });

  it("comes back as a correction when it isn't a length of time", () => {
    for (const every of ["soon", "weekdays at 9am", 30, "every 2h"]) {
      expect(watchInterval(price, every), String(every)).toMatch(/^every is a length of time like "15m"/);
    }
  });

  it("refuses a kind whose own intervals don't read, even one that skipped registration", () => {
    expect(() => watchInterval(stub({ minEvery: "never" }))).toThrow(WatcherError);
  });
});

describe("what a check returns", () => {
  it("keeps a snapshot up to the cap, counted in bytes of JSON", () => {
    // `{"s":"…"}` is 8 bytes around the string.
    const fits = { s: "a".repeat(MAX_WATCH_SNAPSHOT_BYTES - 8) };
    expect(watcherResult({ snapshot: fits }, null).snapshot).toEqual(fits);

    const over = { s: "a".repeat(MAX_WATCH_SNAPSHOT_BYTES - 7) };
    expect(() => watcherResult({ snapshot: over }, null)).toThrow(
      `The snapshot is ${MAX_WATCH_SNAPSHOT_BYTES + 1} bytes as JSON, over the ${MAX_WATCH_SNAPSHOT_BYTES}-byte cap`,
    );
  });

  it("counts bytes, not characters", () => {
    // Three bytes each in UTF-8: a third of the cap in characters is already full.
    const wide = { s: "€".repeat(Math.ceil(MAX_WATCH_SNAPSHOT_BYTES / 3)) };
    expect(() => watcherResult({ snapshot: wide }, null)).toThrow(/over the 4096-byte cap/);
  });

  it("refuses a result with no snapshot, or one that isn't JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => watcherResult({ change: "x" }, null)).toThrow(/returns a snapshot/);
    expect(() => watcherResult({ snapshot: null }, null)).toThrow(/returns a snapshot/);
    expect(() => watcherResult({ snapshot: circular }, null)).toThrow(/not JSON/);
    expect(() => watcherResult({ snapshot: 10n }, null)).toThrow(/not JSON/);
    expect(() => watcherResult({ snapshot: () => 1 }, null)).toThrow(/not JSON/);
    expect(() => watcherResult("changed", null)).toThrow(/returns \{ snapshot/);
  });

  it("hands back the snapshot as the plain JSON the next check will get", () => {
    const at = new Date("2026-10-21T12:00:00Z");
    expect(watcherResult({ snapshot: { at, skip: undefined, n: Number.NaN } }, null).snapshot).toEqual({
      at: "2026-10-21T12:00:00.000Z",
      n: null,
    });
  });

  it("makes a change one line, and cuts a long one where it says so", () => {
    expect(watcherResult({ snapshot: 1, change: "  The price\n fell.\t" }, 0).change).toBe("The price fell.");
    const long = watcherResult({ snapshot: 1, change: "word ".repeat(200) }, 0).change ?? "";
    expect(long.length).toBeLessThanOrEqual(MAX_WATCH_CHANGE_CHARS);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reads a blank change as no change", () => {
    expect(watcherResult({ snapshot: 1, change: " \n " }, 0)).toEqual({ snapshot: 1 });
  });

  it("drops a change on a watch's first check: the first check sets a baseline", () => {
    expect(watcherResult({ snapshot: { price: 9 }, change: "Everything is new." }, undefined)).toEqual({
      snapshot: { price: 9 },
    });
    // A store that keeps "no snapshot yet" as null means the same thing.
    expect(watcherResult({ snapshot: { price: 9 }, change: "Everything is new." }, null)).toEqual({
      snapshot: { price: 9 },
    });
    expect(watcherResult({ snapshot: { price: 9 }, change: "It moved." }, { price: 8 }).change).toBe("It moved.");
  });

  it("keeps a value that is a number or a line of text, and refuses anything else", () => {
    expect(watcherResult({ snapshot: 1, value: 182 }, 0).value).toBe(182);
    expect(watcherResult({ snapshot: 1, value: " €182\n" }, 0).value).toBe("€182");
    expect(() => watcherResult({ snapshot: 1, value: Number.POSITIVE_INFINITY }, 0)).toThrow(
      /finite number, not Infinity/,
    );
    expect(() => watcherResult({ snapshot: 1, value: { price: 1 } }, 0)).toThrow(/finite number, not object/);
    expect(() => watcherResult({ snapshot: 1, change: ["a"] }, 0)).toThrow(/one line of text, not object/);
  });
});

describe("a kind written to the contract", () => {
  /** What a runner does each time: check, settle the result, keep the snapshot. */
  async function run(f: typeof fetch, checks: number) {
    let previous: { price: number } | undefined;
    const seen: Array<string | undefined> = [];
    for (let i = 0; i < checks; i++) {
      const result = watcherResult(
        await price.check({ url: "https://shop.example/item" }, previous, ctxWith(f)),
        previous,
      );
      previous = result.snapshot as { price: number };
      seen.push(result.change);
    }
    return { seen, previous };
  }

  it("sets a baseline, stays quiet while nothing moves, and says what moved", async () => {
    const { seen, previous } = await run(pages(212, 212, 182), 3);
    expect(seen).toEqual([undefined, undefined, "The price fell from 212 to 182."]);
    expect(previous).toEqual({ price: 182 });
  });

  it("reports no change on its first check by itself, before any runner rule applies", async () => {
    const first = await price.check({ url: "https://shop.example/item" }, undefined, ctxWith(pages(212)));
    expect(first).toEqual({ snapshot: { price: 212 }, value: 212 });
  });

  it("throws when the check can't be done, so the runner counts a failure and keeps the last snapshot", async () => {
    await expect(
      price.check({ url: "https://shop.example/item" }, { price: 212 }, ctxWith(pages({ status: 503 }))),
    ).rejects.toThrow("https://shop.example/item answered 503");
  });
});

describe("ctx.watcherKinds", () => {
  const config = { plugins: ["watch-plugin"] } as unknown as AgentConfig;

  it("lets a plugin register, look up and list kinds through its context", () => {
    const ctx = createPluginContext();
    disposers.push(ctx.watcherKinds.register(stub()));
    expect(ctx.watcherKinds.get("test_stub")?.kind).toBe("test_stub");
    expect(ctx.watcherKinds.list().map((k) => k.kind)).toContain("test_stub");
  });

  it("takes a plugin's kinds back when the plugin is unloaded, and offers get and list through the loader", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let found: string[] = [];
    const [loaded] = await loadPlugins(config, async () => ({
      default: (ctx: PluginContext) => {
        ctx.watcherKinds.register(price);
        found = ctx.watcherKinds.list().map((k) => k.kind);
        expect(ctx.watcherKinds.get("test_price")).toBe(price);
      },
    }));
    expect(loaded.error).toBeUndefined();
    expect(found).toContain("test_price");
    expect(getWatcherKind("test_price")).toBe(price);

    await loaded.stop?.();
    expect(getWatcherKind("test_price")).toBeUndefined();
  });

  it("leaves nothing behind when a plugin's kind is refused partway through loading", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [loaded] = await loadPlugins(config, async () => ({
      default: (ctx: PluginContext) => {
        ctx.watcherKinds.register(price);
        ctx.watcherKinds.register(stub({ minEvery: "sometimes" }));
      },
    }));
    expect(loaded.error).toMatch(/minEvery is a length of time/);
    expect(getWatcherKind("test_price")).toBeUndefined();
  });
});
