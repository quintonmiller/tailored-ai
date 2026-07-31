import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

const SESSION = "test-truncation-marker";

/** Throwaway home — see the note in exec-truncation.test.ts. */
const TEST_HOME = mkdtempSync(join(tmpdir(), "tai-exec-marker-test-"));
const OUTPUT_DIR = join(TEST_HOME, "exec-outputs", SESSION);
const PRIOR_HOME = process.env.TAI_HOME;

beforeAll(() => {
  process.env.TAI_HOME = TEST_HOME;
});

afterAll(() => {
  if (PRIOR_HOME === undefined) delete process.env.TAI_HOME;
  else process.env.TAI_HOME = PRIOR_HOME;
  rmSync(TEST_HOME, { recursive: true, force: true });
});

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
    const result = await tool.execute({ command: 'seq 1 5000 | tr "\\n" " "' }, makeCtx());
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
