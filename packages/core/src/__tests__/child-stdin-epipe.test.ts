/**
 * #606. Writing to a child's stdin when the child has already gone raises
 * `EPIPE`, and an `EPIPE` on a stream with no `error` listener is an **uncaught
 * exception** — it does not reject the surrounding promise, it takes the
 * process down.
 *
 * That made a completely ordinary hook dangerous: a script that exits without
 * reading its input could fault the runtime that ran it. It surfaced as an
 * intermittent full-suite failure ("Vitest caught 1 unhandled error"), which is
 * the mild version; in a deployment the same race kills the agent.
 *
 * These drive `closeChildStdin` directly rather than through a hook, because
 * the failure is about the pipe rather than about hooks — three other call
 * sites share it.
 */

import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { closeChildStdin } from "../shell.js";

/** Resolves with the child's exit code once it is fully closed. */
function closed(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.on("close", (code) => resolve(code)));
}

/** Catches what an unhandled stream error would become: a process-level throw. */
async function withUncaughtCapture<T>(fn: () => Promise<T>): Promise<{ result: T; uncaught: Error[] }> {
  const uncaught: Error[] = [];
  const prior = process.listeners("uncaughtException");
  for (const l of prior) process.off("uncaughtException", l);
  const capture = (err: Error) => uncaught.push(err);
  process.on("uncaughtException", capture);
  try {
    const result = await fn();
    // Give a late async EPIPE a turn of the loop to land.
    await new Promise((r) => setTimeout(r, 50));
    return { result, uncaught };
  } finally {
    process.off("uncaughtException", capture);
    for (const l of prior) process.on("uncaughtException", l as (err: Error) => void);
  }
}

describe("closeChildStdin", () => {
  it("does not fault the process when the child exits without reading input", async () => {
    const { result, uncaught } = await withUncaughtCapture(async () => {
      // Exits immediately. The payload is large enough that it cannot fit in
      // the pipe buffer and be absorbed silently — this is what makes the race
      // deterministic rather than load-dependent.
      const child = spawn("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
      const done = closed(child);
      closeChildStdin(child, "x".repeat(2_000_000));
      return await done;
    });
    expect(uncaught).toEqual([]);
    expect(result).toBe(0);
  });

  it("keeps the child's exit code — a refusal is not lost to a broken pipe", async () => {
    // The case that actually failed in CI: a hook that exits 2 to block a tool
    // call, without reading stdin. Losing that verdict to a plumbing error on
    // the input pipe would be worse than the crash.
    const { result, uncaught } = await withUncaughtCapture(async () => {
      const child = spawn("sh", ["-c", "exit 2"], { stdio: ["pipe", "pipe", "pipe"] });
      const done = closed(child);
      closeChildStdin(child, "y".repeat(2_000_000));
      return await done;
    });
    expect(uncaught).toEqual([]);
    expect(result).toBe(2);
  });

  it("still delivers the input to a child that does read it", async () => {
    // The guard must not cost the feature: a hook that reads its payload gets it.
    const child = spawn("sh", ["-c", "cat"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    const done = closed(child);
    closeChildStdin(child, '{"hook":"payload"}');
    await done;
    expect(out).toBe('{"hook":"payload"}');
  });

  it("is silent about EPIPE, which is the ordinary case", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await withUncaughtCapture(async () => {
        const child = spawn("sh", ["-c", "exit 0"], { stdio: ["pipe", "pipe", "pipe"] });
        const done = closed(child);
        closeChildStdin(child, "z".repeat(2_000_000));
        return await done;
      });
      // A hook that ignores its input is normal. Logging it would train people
      // to ignore the log.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("tolerates a child with no stdin pipe at all", () => {
    const child = spawn("sh", ["-c", "exit 0"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(() => closeChildStdin(child, "anything")).not.toThrow();
  });
});
