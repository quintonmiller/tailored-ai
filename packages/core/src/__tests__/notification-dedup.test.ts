import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  type NotificationDedupConfig,
  NotificationGate,
  normalizeForDedup,
  PASSTHROUGH_GATE,
  resolveGate,
  wordSetSimilarity,
} from "../notifications/dedup.js";

let db: Database.Database;
let settings: NotificationDedupConfig | undefined;

const gate = () => new NotificationGate(db, () => settings);

const candidate = (content: string, over: Partial<{ source: string; target: string; key: string }> = {}) => ({
  source: over.source ?? "cron:email-summary",
  channel: "discord",
  target: over.target ?? "OWNER",
  content,
  key: over.key,
});

beforeEach(() => {
  db = initDatabase(":memory:");
  settings = undefined;
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("NotificationGate", () => {
  it("sends the first time and suppresses a byte-identical repeat", async () => {
    const g = gate();
    const send = vi.fn(async () => undefined);

    const first = await g.deliver(candidate("Your Hyatt reservation needs details."), send);
    const second = await g.deliver(candidate("Your Hyatt reservation needs details."), send);

    expect(first.send).toBe(true);
    expect(first.verdict).toBe("new");
    expect(second.send).toBe(false);
    expect(second.verdict).toBe("repeat-exact");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("counts how many repeats it withheld", async () => {
    const g = gate();
    const send = vi.fn(async () => undefined);
    for (let i = 0; i < 5; i++) await g.deliver(candidate("same news"), send);

    expect(send).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT sent_count, suppressed_count FROM notification_log").get() as {
      sent_count: number;
      suppressed_count: number;
    };
    expect(row.sent_count).toBe(1);
    expect(row.suppressed_count).toBe(4);
  });

  it("suppresses a reworded restatement, not just an identical one", async () => {
    // The real failure mode: a model asked to summarize unchanged state rarely
    // emits the same bytes twice. Exact hashing alone would let this through.
    const g = gate();
    const send = vi.fn(async () => undefined);
    const first =
      "Stuck development tasks: ptask_sb_317186 Docker-sandbox E2E is blocked and needs your review before it can proceed.";
    const reworded =
      "Stuck development tasks: ptask_sb_317186 Docker-sandbox E2E is blocked and needs your review before it can proceed today.";

    await g.deliver(candidate(first), send);
    const second = await g.deliver(candidate(reworded), send);

    expect(second.send).toBe(false);
    expect(second.verdict).toBe("repeat-similar");
    expect(second.similarity).toBeGreaterThanOrEqual(0.92);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never suppresses by similarity when a number changed — that IS the news", async () => {
    // These two differ by one token out of ~16, well above the similarity
    // threshold, but the number is the entire point of the message.
    const g = gate();
    const send = vi.fn(async () => undefined);
    const before = "Your flight from Seattle to Columbia on June 26 is currently priced at $312 round trip.";
    const after = "Your flight from Seattle to Columbia on June 26 is currently priced at $412 round trip.";

    await g.deliver(candidate(before), send);
    const second = await g.deliver(candidate(after), send);

    expect(second.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never suppresses a polarity flip — 'successfully' vs 'unsuccessfully' is the whole message", async () => {
    // Word-set similarity is length-relative: in a 40-word body one swapped
    // token still scores ~0.95. Without a polarity veto this is silently
    // dropped, which is the worst possible failure for this feature.
    const g = gate();
    const send = vi.fn(async () => undefined);
    const good =
      "Nightly backup of the home server finished. All configured volumes were processed in order, the archive was written to the offsite bucket, and the integrity check on the resulting snapshot completed successfully without warnings.";
    const bad = good.replace("successfully", "unsuccessfully");

    await g.deliver(candidate(good), send);
    const second = await g.deliver(candidate(bad), send);

    expect(second.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never suppresses a message that adds new information to a previous one", async () => {
    // Jaccard is symmetric, so an unchanged digest plus one appended line still
    // scores high — and that line is exactly what the user needs to see.
    const g = gate();
    const send = vi.fn(async () => undefined);
    const digest =
      "Morning digest. The deploy pipeline is green, no alerts fired overnight, your calendar is clear until the afternoon, and the apartment search returned nothing new since yesterday evening.";
    const withNews = `${digest} Alice requested review on the billing webhook branch.`;

    await g.deliver(candidate(digest), send);
    const second = await g.deliver(candidate(withNews), send);

    expect(second.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("charges the suppression counter to the row that actually matched", async () => {
    // first_sent_at has one-second resolution and no uniqueness, so re-deriving
    // the row from it charged whichever row SQLite scanned first.
    const g = gate();
    const send = vi.fn(async () => undefined);
    const a = "The billing service returned elevated latency across the checkout endpoints this morning again.";
    const b = "Apartment listing on Pine Street went live and matches every filter you set up last week.";

    await g.deliver(candidate(a), send);
    await g.deliver(candidate(b), send);
    const decision = await g.deliver(candidate(`${a} again`), send);

    expect(decision.send).toBe(false);
    const rows = db.prepare("SELECT id, suppressed_count, preview FROM notification_log ORDER BY id").all() as Array<{
      id: number;
      suppressed_count: number;
      preview: string;
    }>;
    const charged = rows.filter((r) => r.suppressed_count > 0);
    expect(charged).toHaveLength(1);
    expect(charged[0].id).toBe(decision.entryId);
    expect(charged[0].preview).toContain("billing service");
  });

  it("lets genuinely different news through", async () => {
    const g = gate();
    const send = vi.fn(async () => undefined);

    await g.deliver(candidate("Airbnb Staff Frontend position 7962101 is still open as of this morning."), send);
    const second = await g.deliver(
      candidate("Your flight to Columbia on June 26 dropped to $312, down from $480 last week."),
      send,
    );

    expect(second.send).toBe(true);
    expect(second.verdict).toBe("new");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("treats short messages exactly, never by similarity", async () => {
    // "Done." and "Failed." share little, but short strings collide too easily
    // for a set-overlap score to be trustworthy.
    const g = gate();
    const send = vi.fn(async () => undefined);
    await g.deliver(candidate("Build passed"), send);
    const second = await g.deliver(candidate("Build failed"), send);

    expect(second.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("scopes suppression per recipient and per source", async () => {
    const g = gate();
    const send = vi.fn(async () => undefined);
    await g.deliver(candidate("shared text"), send);

    const otherTarget = await g.deliver(candidate("shared text", { target: "SOMEONE_ELSE" }), send);
    const otherSource = await g.deliver(candidate("shared text", { source: "cron:digest" }), send);

    expect(otherTarget.send).toBe(true);
    expect(otherSource.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("treats the same news as fresh again once the window lapses", async () => {
    // The window is evaluated by SQLite's own datetime('now'), which fake
    // timers do not affect — so age the stored row instead of the clock.
    settings = { windowHours: 24 };
    const g = gate();
    const send = vi.fn(async () => undefined);
    const text = "weekly reminder text that is long enough to be real";

    await g.deliver(candidate(text), send);
    db.prepare("UPDATE notification_log SET last_sent_at = datetime('now', '-48 hours')").run();
    const later = await g.deliver(candidate(text), send);

    expect(later.send).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keys on caller-supplied identity so rewording still counts as the same fact", async () => {
    const g = gate();
    const send = vi.fn(async () => undefined);
    const key = "task:ptask_9:blocked";

    await g.deliver(candidate("Task ptask_9 is blocked and needs input", { key }), send);
    const second = await g.deliver(candidate("Completely different words entirely", { key }), send);

    expect(second.send).toBe(false);
    expect(second.verdict).toBe("repeat-key");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends everything when dedup is disabled", async () => {
    settings = { enabled: false };
    const g = gate();
    const send = vi.fn(async () => undefined);
    await g.deliver(candidate("same"), send);
    await g.deliver(candidate("same"), send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not record a send that threw, so the retry still goes out", async () => {
    const g = gate();
    const failing = vi.fn(async () => {
      throw new Error("discord down");
    });
    await expect(g.deliver(candidate("important"), failing)).rejects.toThrow("discord down");

    const ok = vi.fn(async () => undefined);
    const retry = await g.deliver(candidate("important"), ok);
    expect(retry.send).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe("resolveGate", () => {
  it("falls back to passthrough when no gate is wired", async () => {
    const send = vi.fn(async () => undefined);
    await resolveGate(undefined).deliver(candidate("x"), send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("falls back to passthrough when the accessor throws — never drops a message", async () => {
    const send = vi.fn(async () => undefined);
    const resolved = resolveGate(() => {
      throw new Error("runtime not ready");
    });
    expect(resolved).toBe(PASSTHROUGH_GATE);
    await resolved.deliver(candidate("x"), send);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("normalizeForDedup", () => {
  it("ignores case, whitespace, and markdown emphasis", () => {
    expect(normalizeForDedup("**Hello**   World\n\n")).toBe("hello world");
  });

  it("keeps numbers distinct — different counts are different news", () => {
    expect(normalizeForDedup("3 new listings")).not.toBe(normalizeForDedup("5 new listings"));
  });
});

describe("wordSetSimilarity", () => {
  it("scores identical text 1 and disjoint text 0", () => {
    expect(wordSetSimilarity("a b c", "a b c")).toBe(1);
    expect(wordSetSimilarity("a b c", "x y z")).toBe(0);
  });
});
