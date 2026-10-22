/**
 * Whether a dead worker can say what killed it.
 *
 * A scenario whose worker dies is reported as an error rather than a low score,
 * which is right — a measurement that did not happen is not a bad result. But
 * for months that error read, in full:
 *
 *   worker produced no result (exit null); last output: [agents] migrated 6
 *   agent(s) from config.yaml to authored-resources: ceo, sales, operations…
 *
 * Both halves of which are useless. `exit null` is Node's way of saying "killed
 * by a signal" and names neither the signal nor the sender. And the "last
 * output" is the startup notice, because the harness piped stdout and routed
 * stderr to /dev/null — so the one stream a dying process explains itself on
 * was the one stream thrown away.
 *
 * That is not hypothetical either. `the-factory` and `the-lock` failed this way
 * in every arm of every benchmark they have ever appeared in, and the reports on
 * disk cannot say why, because the cause went to a discarded pipe.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkerResult } from "../protocol.js";

/** An empty directory, standing in for a worker that wrote no result file. */
const dirs: string[] = [];
function emptyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "worker-death-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function errorOf(out: ReturnType<typeof readWorkerResult>): string {
  if (!("error" in out)) throw new Error("expected an error, got a result");
  return out.error;
}

describe("a worker that died", () => {
  it("names the signal instead of reporting `exit null`", () => {
    // The three signals that actually show up mean three different things:
    // SIGKILL is the harness's own backstop firing, SIGABRT is V8 giving up on
    // the heap, SIGSEGV is a native crash. Reporting them identically as
    // "exit null" makes a timer and an out-of-memory look like the same bug.
    const out = errorOf(readWorkerResult(emptyDir(), null, "", { signal: "SIGABRT" }));
    expect(out).toContain("SIGABRT");
    expect(out).not.toContain("exit null");
  });

  it("explains itself from stderr, not from whatever stdout said last", () => {
    const out = errorOf(
      readWorkerResult(emptyDir(), null, "[agents] migrated 6 agent(s) from config.yaml", {
        signal: "SIGABRT",
        stderr: "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      }),
    );
    expect(out).toContain("JavaScript heap out of memory");
    // The startup chatter must not be what gets reported when a real cause exists.
    expect(out).not.toContain("migrated 6 agent(s)");
  });

  it("still falls back to stdout when the worker died quietly", () => {
    // Not every death writes to stderr. A worker SIGKILLed by the backstop
    // mid-call says nothing at all, and then the last stdout line is genuinely
    // the best account available.
    const out = errorOf(readWorkerResult(emptyDir(), null, "turn 47 of 72", { signal: "SIGKILL" }));
    expect(out).toContain("SIGKILL");
    expect(out).toContain("turn 47 of 72");
  });

  it("reports a plain non-zero exit as an exit, not a signal", () => {
    const out = errorOf(readWorkerResult(emptyDir(), 1, "", { stderr: "Error: config.yaml not found" }));
    expect(out).toContain("exit 1");
    expect(out).toContain("config.yaml not found");
  });

  it("does not disturb a worker that came back normally", () => {
    const dir = emptyDir();
    writeFileSync(join(dir, "result.json"), JSON.stringify({ runs: [{ pass: true }], passRate: 1 }));
    const out = readWorkerResult(dir, 0, "", { signal: null, stderr: "a deprecation warning" });
    expect("error" in out).toBe(false);
  });
});
