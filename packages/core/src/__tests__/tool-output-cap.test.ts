import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { capToolOutput, DEFAULT_MAX_TOOL_OUTPUT_CHARS, resolveToolOutputLimit } from "../agent/tool-output.js";

/**
 * The measured incident: one `mcp_notion_API-post-search` returned 70,485
 * chars / 27,187 real tokens against an 18,800-token history budget, so
 * trimHistory evicted the user's question and the agent answered an hour-old
 * welcome message instead. Three times in forty minutes.
 */

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "tai-tool-output-"));
});

const opts = (over: Partial<Parameters<typeof capToolOutput>[1]> = {}) => ({
  toolName: "mcp_notion_API-post-search",
  limit: 1000,
  sessionId: "s1",
  scratchDir,
  ...over,
});

describe("capToolOutput", () => {
  it("returns output that fits, untouched", async () => {
    const raw = "x".repeat(500);
    expect(await capToolOutput(raw, opts())).toBe(raw);
  });

  it("leaves output alone when the limit is 0", async () => {
    const raw = "x".repeat(50_000);
    expect(await capToolOutput(raw, opts({ limit: 0 }))).toBe(raw);
  });

  it("caps oversized output and keeps head and tail", async () => {
    const raw = `HEAD_MARKER${"x".repeat(50_000)}TAIL_MARKER`;

    const capped = await capToolOutput(raw, opts());

    expect(capped.length).toBeLessThan(raw.length);
    expect(capped).toContain("HEAD_MARKER");
    expect(capped).toContain("TAIL_MARKER");
    expect(capped).toContain("chars omitted");
  });

  it("names the tool and the real size so the agent can tell what happened", async () => {
    const capped = await capToolOutput("x".repeat(70_485), opts());

    expect(capped).toContain("mcp_notion_API-post-search");
    expect(capped).toContain("70,485");
  });

  /**
   * The obvious move for a model handed a partial answer is to run the same
   * call again — which returns this same string. Saying so is the difference
   * between a cap and a loop.
   */
  it("tells the agent that repeating the call will not help", async () => {
    const capped = await capToolOutput("x".repeat(50_000), opts());

    expect(capped).toMatch(/same truncated result/i);
    expect(capped).toMatch(/narrow the request/i);
  });

  it("writes the full output to disk and points at it", async () => {
    const raw = `UNIQUE_BODY${"x".repeat(50_000)}`;

    const capped = await capToolOutput(raw, opts());

    const files = readdirSync(join(scratchDir, "s1"));
    expect(files).toHaveLength(1);
    const saved = readFileSync(join(scratchDir, "s1", files[0]), "utf8");
    expect(saved).toBe(raw);
    expect(capped).toContain(files[0]);
  });

  /**
   * The loop's stuck-model detector compares consecutive tool results
   * verbatim. A marker carrying a timestamp or otherwise unique path makes two
   * identical results compare unequal and silently disables that guard — which
   * is the guard that catches a model re-issuing the truncated call. `exec`'s
   * existing truncation names its file by timestamp and has this bug.
   */
  it("is byte-identical for identical input, so the repeat detector still fires", async () => {
    const raw = "x".repeat(50_000);

    const first = await capToolOutput(raw, opts());
    const second = await capToolOutput(raw, opts());

    expect(second).toBe(first);
    // Content-addressed, so the same payload is one file, not two.
    expect(readdirSync(join(scratchDir, "s1"))).toHaveLength(1);
  });

  it("gives different payloads different files", async () => {
    await capToolOutput(`A${"x".repeat(50_000)}`, opts());
    await capToolOutput(`B${"x".repeat(50_000)}`, opts());

    expect(readdirSync(join(scratchDir, "s1"))).toHaveLength(2);
  });

  /**
   * A persistence failure must still truncate. Returning the full string
   * because the scratch write failed would reinstate the blowup this exists to
   * prevent.
   */
  it("still truncates when the full output cannot be saved", async () => {
    const raw = "x".repeat(50_000);

    // A path that cannot be created: an existing file used as a directory.
    const capped = await capToolOutput(raw, opts({ scratchDir: "/dev/null/nope" }));

    expect(capped.length).toBeLessThan(raw.length);
    expect(capped).toMatch(/could not be saved/i);
  });
});

describe("resolveToolOutputLimit", () => {
  it("prefers a per-tool limit over the global one", () => {
    expect(resolveToolOutputLimit("mcp_notion_API-post-search", { "mcp_notion_API-post-search": 8000 }, 32_000)).toBe(
      8000,
    );
  });

  it("falls back to the global limit", () => {
    expect(resolveToolOutputLimit("read", { exec: 4000 }, 32_000)).toBe(32_000);
  });

  it("falls back to the default when nothing is configured", () => {
    expect(resolveToolOutputLimit("read", undefined, undefined)).toBe(DEFAULT_MAX_TOOL_OUTPUT_CHARS);
  });

  it("honours an explicit 0 rather than treating it as unset", () => {
    expect(resolveToolOutputLimit("read", { read: 0 }, 32_000)).toBe(0);
  });
});

describe("the marker's file pointer is readable", () => {
  /**
   * A pointer we hand out and then refuse is worse than no pointer. Agents
   * with a worktree boundary (coder, reviewer, anything the task watcher
   * dispatches) are exactly the ones that hit large outputs.
   */
  it("is inside the sandbox scratch allowlist, including the legacy ~/.tai location", async () => {
    const { checkSandboxBoundary } = await import("../tools/sandbox-boundary.js");
    const { homedir } = await import("node:os");

    const pointer = join(homedir(), ".tai", "tool-outputs", "s1", "some_tool-abc123.txt");
    const verdict = checkSandboxBoundary(pointer, {
      sessionId: "s1",
      workingDirectory: "/tmp/worktree",
      workingDirectoryBoundary: "/tmp/worktree",
      env: {},
    } as never);

    expect(verdict.ok).toBe(true);
  });
});
