import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

const SESSION = "test-truncation";
const OUTPUT_DIR = join(homedir(), ".tai", "exec-outputs", SESSION);

function makeCtx(): ToolContext {
  return {
    sessionId: SESSION,
    workingDirectory: process.cwd(),
    env: {},
  };
}

beforeEach(() => {
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

afterEach(() => {
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true, force: true });
});

describe("ExecTool output truncation", () => {
  it("passes small output through unchanged (no truncation)", async () => {
    const tool = new ExecTool(["echo"]);
    const result = await tool.execute({ command: "echo hello world" }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.output.trim()).toBe("hello world");
    expect(result.output).not.toContain("truncated");
  });

  it("truncates large output and saves the full to disk", async () => {
    // No allowlist so we can use seq+sed via bash pipeline.
    const tool = new ExecTool();
    // Emit 200 lines of padded text — past the 4000-byte threshold.
    const result = await tool.execute(
      { command: `seq 1 200 | sed 's/^/line /; s/$/ padding padding padding padding padding/'` },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(result.output.length).toBeLessThan(5000); // bounded
    expect(result.output).toMatch(/truncated/);
    expect(result.output).toMatch(/Full output:/);
    const m = result.output.match(/Full output: ([^\]\s]+)/);
    expect(m).not.toBeNull();
    const path = m![1];
    expect(existsSync(path)).toBe(true);
    const full = readFileSync(path, "utf8");
    expect(full.length).toBeGreaterThan(result.output.length);
    expect(full).toContain("line 1 ");
    expect(full).toContain("line 200 ");
  }, 15_000);

  it("honors a custom scratchDir (regression for #60)", async () => {
    const scratchRoot = join(homedir(), ".tai-test-scratch");
    if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true });
    try {
      const tool = new ExecTool(undefined, undefined, scratchRoot);
      const result = await tool.execute(
        { command: `seq 1 200 | sed 's/^/line /; s/$/ padding padding padding padding padding/'` },
        makeCtx(),
      );
      expect(result.success).toBe(true);
      const m = result.output.match(/Full output: ([^\]\s]+)/);
      expect(m).not.toBeNull();
      expect(m![1].startsWith(scratchRoot)).toBe(true);
      expect(existsSync(m![1])).toBe(true);
    } finally {
      if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it("still settles the tool promise when scratch persistence fails (regression for #60)", async () => {
    // Point at a path we can't create — /dev/null/anything → ENOTDIR.
    const tool = new ExecTool(undefined, undefined, "/dev/null/forbidden");
    const result = await tool.execute(
      { command: `seq 1 200 | sed 's/^/line /; s/$/ padding padding padding padding padding/'` },
      makeCtx(),
    );
    // Without the fix, the inner write throws and the outer Promise hangs
    // until vitest's test timeout. With the fix, we get a clean truncated
    // result with a "could not be persisted" warning.
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/truncated/);
    expect(result.output).toMatch(/Full output could not be persisted/);
  }, 15_000);

  it("keeps head and tail in the visible output", async () => {
    const tool = new ExecTool();
    // 300 lines of padded text — comfortably past the 4000-byte threshold
    // AND past the 50-line head+tail combined so middle truncation kicks in.
    const result = await tool.execute(
      { command: `seq 1 300 | sed 's/^/line /; s/$/ padding padding padding padding/'` },
      makeCtx(),
    );
    expect(result.output).toContain("line 1 "); // head
    expect(result.output).toContain("line 300 "); // tail
    expect(result.output).toContain("lines omitted");
  }, 15_000);
});
