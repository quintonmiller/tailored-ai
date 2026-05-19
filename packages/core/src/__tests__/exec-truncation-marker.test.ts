import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

const SESSION = "test-truncation-marker";
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

describe("exec truncation marker — char-bloated single-line output", () => {
  it("marker contains bytes count and Full output path, separated from content by blank line", async () => {
    const tool = new ExecTool();
    // Produce a single long line well over 4000 bytes so the char-bloated branch fires.
    // seq 1 5000 generates ~25KB of digits+spaces on one line.
    const result = await tool.execute(
      { command: 'seq 1 5000 | tr "\\n" " "' },
      makeCtx(),
    );
    expect(result.success).toBe(true);

    const lines = result.output.split("\n");
    const marker = lines[0];

    // Marker line contains byte count and "bytes truncated"
    expect(marker).toMatch(/bytes truncated/);
    expect(marker).toMatch(/Full output:/);

    // Second line is blank — separator between marker and content
    expect(lines[1]).toBe("");

    // Content starts on the third line
    expect(lines[2]).toBeDefined();
    expect(lines[2].length).toBeGreaterThan(0);
  }, 15_000);
});
