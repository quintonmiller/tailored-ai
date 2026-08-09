/**
 * The worker↔parent protocol, and both halves of it.
 *
 * It lives alone in its own module for a boring but load-bearing reason: the
 * worker runs its scenario at import time, so importing a constant *from* the
 * worker made the parent process run a scenario of its own on startup. Keeping
 * the reader and the writer here too means a test can drive the real pair
 * rather than a re-implementation of both.
 *
 * The result travels as a file rather than a line on stdout. It used to be a
 * marked line, which worked until a run got big: stdout to a pipe is
 * asynchronous, so `process.exit()` in the worker discarded whatever had not
 * drained yet — measured at ~146 KB on Linux — and the parent was left parsing
 * half a JSON document, which threw inside a `close` handler and took down a
 * run whose model time had already been spent. A 15-repeat scenario keeping a
 * request body per failing run clears 146 KB easily. A file has no ceiling and
 * needs no flush.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioResult } from "./types.js";

/** The parent's input, written before the worker is spawned. */
export const PAYLOAD_FILENAME = "payload.json";

/** The worker's output, written into the same temp dir. */
export const RESULT_FILENAME = "result.json";

/**
 * `writeFileSync` rather than a stream: the write has to be complete before
 * `process.exit`, and for a regular file that is what synchronous means. This
 * is the whole reason the result is a file.
 */
export function writeWorkerResult(payloadPath: string, result: unknown): void {
  writeFileSync(join(dirname(payloadPath), RESULT_FILENAME), JSON.stringify(result));
}

/**
 * Read back what the worker left, or say why there is nothing to read.
 *
 * Never throws. Every failure here is one scenario reported as an error — an
 * exception would escape through a `close` handler, where the promise around it
 * cannot catch it, and lose the whole run's results along with it.
 */
export function readWorkerResult(
  dir: string,
  exitCode: number | null,
  tail = "",
): { result: ScenarioResult } | { error: string } {
  let raw: string;
  try {
    raw = readFileSync(join(dir, RESULT_FILENAME), "utf8");
  } catch {
    // No result file at all: the worker died before it got that far. Its last
    // few lines of output are usually the only account of why.
    const why = tail.trim() ? `; last output: ${tail.trim().split("\n").slice(-3).join(" / ")}` : "";
    return { error: `worker produced no result (exit ${exitCode})${why}` };
  }

  let parsed: ScenarioResult & { error?: string };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `worker result was unreadable (${(err as Error).message}, ${raw.length} bytes, exit ${exitCode})` };
  }

  // The worker's own failure path writes `{error}` and no runs.
  if (parsed.error && !parsed.runs) return { error: parsed.error };
  return { result: parsed };
}
