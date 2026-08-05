/**
 * Three providers learned the same lesson independently: some request-shape
 * constraints are per-model, no static rule predicts them, and the only way to
 * find out is to be told no. Each grew its own ladder, memo and warn-once.
 *
 * What is shared is the scaffolding. What is not — which 400s are recoverable
 * and what the corrected shape is — stays a provider callback, because vendors
 * word the same refusal differently, including OpenAI between its own two
 * endpoints.
 *
 * The property that matters most here is termination. The error text is the
 * *input* to recovery, so a vendor rewording a message must cost a missed
 * recovery, never a hang.
 */
import { describe, expect, it, vi } from "vitest";
import { ProviderHttpError, QuirkMemo, runQuirkLadder, WarnOnce } from "../providers/quirks.js";

describe("runQuirkLadder", () => {
  it("returns the first success without calling recover", async () => {
    const recover = vi.fn();
    const out = await runQuirkLadder<string, string>({
      initial: "a",
      key: (s) => s,
      attempt: async (s) => `ok:${s}`,
      recover,
    });
    expect(out).toBe("ok:a");
    expect(recover).not.toHaveBeenCalled();
  });

  it("walks corrections until one is accepted", async () => {
    const seen: string[] = [];
    const out = await runQuirkLadder<string, string>({
      initial: "high",
      key: (s) => s,
      attempt: async (s) => {
        seen.push(s);
        if (s !== "medium") throw new Error(`no ${s}`);
        return "ok";
      },
      recover: (s) => (s === "high" ? "low" : "medium"),
    });
    expect(out).toBe("ok");
    expect(seen).toEqual(["high", "low", "medium"]);
  });

  it("rethrows untouched when recover declines", async () => {
    // The default that matters: retrying an unrelated failure with a different
    // body turns one clear error into two confusing ones.
    const attempt = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    await expect(
      runQuirkLadder({ initial: "a", key: (s: string) => s, attempt, recover: () => undefined }),
    ).rejects.toThrow("quota exceeded");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("throws the error from the attempt that failed, not a wrapper", async () => {
    const original = new ProviderHttpError(400, "{}", "API error 400: {}");
    await expect(
      runQuirkLadder({
        initial: "a",
        key: (s: string) => s,
        attempt: async () => {
          throw original;
        },
        recover: () => undefined,
      }),
    ).rejects.toBe(original);
  });

  it("terminates on a recover that keeps proposing the same shape", async () => {
    // The failure mode a retry counter hides and a `tried` set cannot have.
    let calls = 0;
    await expect(
      runQuirkLadder({
        initial: "a",
        key: (s: string) => s,
        attempt: async () => {
          calls++;
          throw new Error("nope");
        },
        recover: () => "a",
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });

  it("terminates on a recover that cycles between two shapes", async () => {
    let calls = 0;
    await expect(
      runQuirkLadder({
        initial: "a",
        key: (s: string) => s,
        attempt: async () => {
          calls++;
          throw new Error("nope");
        },
        recover: (s) => (s === "a" ? "b" : "a"),
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(2); // a, b — then "a" is already tried
  });

  it("keys on identity, not object reference", async () => {
    let calls = 0;
    await expect(
      runQuirkLadder<{ effort: string }, string>({
        initial: { effort: "high" },
        key: (s) => s.effort,
        attempt: async () => {
          calls++;
          throw new Error("nope");
        },
        // A fresh object each time, same meaning. Reference equality would loop.
        recover: () => ({ effort: "high" }),
      }),
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});

describe("QuirkMemo", () => {
  it("creates a record on first touch and keeps it thereafter", () => {
    const memo = new QuirkMemo<{ rejected?: boolean }>(() => ({}));
    expect(memo.has("m")).toBe(false);
    memo.for("m").rejected = true;
    expect(memo.for("m").rejected).toBe(true);
    expect(memo.has("m")).toBe(true);
  });

  it("peeks without creating, so a first attempt can ask 'have you refused before?'", () => {
    const memo = new QuirkMemo<{ rejected?: boolean }>(() => ({}));
    expect(memo.peek("m")).toBeUndefined();
    expect(memo.has("m")).toBe(false);
  });

  it("keeps models apart — two models behind one provider can differ", () => {
    const memo = new QuirkMemo<{ rejected?: boolean }>(() => ({}));
    memo.for("cheap").rejected = true;
    expect(memo.peek("expensive")).toBeUndefined();
  });

  it("gives each model a distinct record, not a shared one", () => {
    const memo = new QuirkMemo<{ efforts: Set<string> }>(() => ({ efforts: new Set() }));
    memo.for("a").efforts.add("none");
    expect(memo.for("b").efforts.size).toBe(0);
  });

  it("forgets on request", () => {
    const memo = new QuirkMemo<{ x?: number }>(() => ({}));
    memo.for("m").x = 1;
    memo.forget("m");
    expect(memo.peek("m")).toBeUndefined();
  });
});

describe("WarnOnce", () => {
  it("says a thing once per key", () => {
    const said: string[] = [];
    const warn = new WarnOnce((m) => said.push(m));
    warn.say("effort:m", "first");
    warn.say("effort:m", "second");
    expect(said).toEqual(["first"]);
  });

  it("keys separately per model and per quirk", () => {
    const said: string[] = [];
    const warn = new WarnOnce((m) => said.push(m));
    warn.say("effort:a", "a effort");
    warn.say("effort:b", "b effort");
    warn.say("summary:a", "a summary");
    expect(said).toHaveLength(3);
  });

  it("defaults to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    new WarnOnce().say("k", "hello");
    expect(spy).toHaveBeenCalledWith("hello");
    spy.mockRestore();
  });
});

describe("ProviderHttpError", () => {
  it("keeps the message every provider already threw", () => {
    const err = new ProviderHttpError(400, "body", "OpenAI API error 400: body");
    expect(err.message).toBe("OpenAI API error 400: body");
    expect(err).toBeInstanceOf(Error);
  });

  it("carries status and body so recognition never parses a message it composed", () => {
    const err = new ProviderHttpError(429, "slow down", "x");
    expect(err.status).toBe(429);
    expect(err.bodyText).toBe("slow down");
  });

  it("parses a JSON body, and returns undefined for one that is not", () => {
    expect(new ProviderHttpError(400, '{"error":{"param":"reasoning.effort"}}', "x").json()).toEqual({
      error: { param: "reasoning.effort" },
    });
    expect(new ProviderHttpError(502, "<html>gateway</html>", "x").json()).toBeUndefined();
  });
});
