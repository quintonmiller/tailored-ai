/**
 * The worker→parent boundary.
 *
 * A 15-repeat run once completed every model call, graded every check, and then
 * wrote no report at all — the result crossed the boundary as a line on stdout,
 * and `process.exit()` in the worker discarded everything past ~146 KB. The
 * parent parsed half a JSON document, threw inside a `close` handler where the
 * surrounding promise could not catch it, and lost the whole run.
 *
 * So the size case runs across a real process boundary rather than calling the
 * two functions in one process. In-process, `writeFileSync` and `readFileSync`
 * would obviously agree; the bug was entirely about what survives an exiting
 * child, and only a spawn can show that.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAYLOAD_FILENAME, RESULT_FILENAME, readWorkerResult, writeWorkerResult } from "../protocol.js";
import type { ScenarioResult } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
const protocolModule = resolve(here, "../protocol.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tai-eval-protocol-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A result of roughly `runs` × 40 KB, the shape a failing high-repeat scenario produces. */
function bigResult(runs: number): ScenarioResult {
  return {
    id: "notices-a-truncated-tool-result",
    category: "tool-pressure",
    intent: "reports a truncated tool result rather than inventing the elided part",
    passRate: 0,
    runs: Array.from({ length: runs }, () => ({
      pass: false,
      checks: [{ kind: "reply_contains", pass: false, detail: "expected the reply to mention truncation" }],
      outcome: {
        reply: "x".repeat(200),
        posts: [],
        calls: [],
        // The request bodies are what make a failing run large, and they are the
        // whole reason they are kept: they are the diagnosis.
        requests: [{ system: "s".repeat(20_000), messages: [{ role: "user", content: "m".repeat(20_000) }] }],
        usage: { input: 3096, output: 220 },
        latencyMs: 21_000,
        providerErrors: [],
        retries: 0,
      },
    })),
  } as unknown as ScenarioResult;
}

/**
 * Spawn a child that writes `result` through the real writer and exits
 * immediately, exactly as the worker does.
 */
function spawnWriter(result: ScenarioResult): Promise<number | null> {
  const payloadPath = join(dir, PAYLOAD_FILENAME);
  const resultSource = join(dir, "result-source.json");
  writeFileSync(resultSource, JSON.stringify(result));

  const script = `
    import { readFileSync } from "node:fs";
    import { writeWorkerResult } from ${JSON.stringify(protocolModule)};
    // Log first: the worker logs freely, and the result must not be affected by it.
    process.stdout.write("[worker] some noise on stdout\\n");
    writeWorkerResult(${JSON.stringify(payloadPath)}, JSON.parse(readFileSync(${JSON.stringify(resultSource)}, "utf8")));
    process.exit(0);
  `;
  const scriptPath = join(dir, "writer.mjs");
  writeFileSync(scriptPath, script);

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    child.stdout.on("data", () => {});
    child.on("close", (code) => resolvePromise(code));
  });
}

describe("a result crossing the worker boundary", () => {
  it("survives at a size that a stdout write would have truncated", async () => {
    // 15 runs × ~40 KB is ~600 KB — four times the ~146 KB that survived
    // `process.exit()` on a pipe, and the size the reported run produced.
    const sent = bigResult(15);
    const code = await spawnWriter(sent);
    expect(code).toBe(0);

    const outcome = readWorkerResult(dir, code);
    expect(outcome).not.toHaveProperty("error");
    if ("error" in outcome) return;

    expect(outcome.result.runs).toHaveLength(15);
    expect(JSON.stringify(outcome.result).length).toBeGreaterThan(600_000);
    // Fidelity, not just arrival: the last run is the one a truncation eats.
    expect(outcome.result.runs[14]).toEqual(sent.runs[14]);
  }, 30_000);

  it("is unaffected by the worker logging to stdout", async () => {
    const code = await spawnWriter(bigResult(1));
    const outcome = readWorkerResult(dir, code);
    expect(outcome).not.toHaveProperty("error");
    if ("error" in outcome) return;
    expect(outcome.result.id).toBe("notices-a-truncated-tool-result");
  }, 30_000);
});

describe("when there is nothing good to read", () => {
  it("reports a worker that left no result rather than throwing", () => {
    const outcome = readWorkerResult(dir, 1);
    expect(outcome).toEqual({ error: expect.stringContaining("worker produced no result (exit 1)") });
  });

  it("quotes the worker's last output, which is usually the only account of why", () => {
    const outcome = readWorkerResult(dir, null, "loading model\nEACCES: permission denied, open '/x/agent.db'\n");
    expect(outcome).toEqual({ error: expect.stringContaining("EACCES: permission denied") });
  });

  it("reports an unreadable result loudly, with its size, rather than throwing", () => {
    // Exactly what a truncated result looked like: valid JSON that stops.
    writeFileSync(join(dir, RESULT_FILENAME), '{"id":"x","runs":[{"pass":fal');
    const outcome = readWorkerResult(dir, 0);
    expect(outcome).toHaveProperty("error");
    if (!("error" in outcome)) return;
    expect(outcome.error).toContain("unreadable");
    expect(outcome.error).toContain("29 bytes");
  });

  it("passes through the worker's own error payload", () => {
    writeWorkerResult(join(dir, PAYLOAD_FILENAME), { error: "no room backend registered for 'local'" });
    expect(readWorkerResult(dir, 1)).toEqual({ error: "no room backend registered for 'local'" });
  });

  it("does not mistake a real result carrying an error field for a failure", () => {
    // `runs` present means the scenario ran; anything else would discard a
    // graded result over an incidental field.
    writeWorkerResult(join(dir, PAYLOAD_FILENAME), { id: "x", category: "c", runs: [], passRate: 0, error: "" });
    const outcome = readWorkerResult(dir, 0);
    expect(outcome).toHaveProperty("result");
  });

  it("reports a missing directory rather than throwing", () => {
    expect(readWorkerResult(join(dir, "gone"), 0)).toHaveProperty("error");
  });
});

describe("the payload path the writer derives", () => {
  it("puts the result beside the payload, wherever that is", () => {
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeWorkerResult(join(nested, PAYLOAD_FILENAME), { id: "x", category: "c", runs: [], passRate: 1 });
    expect(readWorkerResult(nested, 0)).toHaveProperty("result");
  });
});
