import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capToolOutput } from "../agent/tool-output.js";
import type { ToolContext } from "../tools/interface.js";
import { ReadTool } from "../tools/read.js";

/**
 * Reaching the middle of an over-cap result (#466).
 *
 * `capToolOutput` cuts middle-out and saves the full output, and until now the
 * saved copy was a dead end: `read` took only a path, so reading it ran through
 * the same cap, on the same bytes, at the same limit — byte-identical, elision
 * included. Measured: `advice followed -> byte-identical result: true`,
 * `elided middle recovered: false`. The only route to the middle was `exec`
 * with `sed`, which agents found by trial and error when they found it at all.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "read-paging-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: "s", workingDirectory: dir, env: {}, ...overrides };
}

/** Distinct per position, so a window proves where it came from. */
function ruler(length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) out += `${i}|`;
  return out.slice(0, length);
}

describe("read windows", () => {
  it("returns the whole file when it fits", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");

    const result = await new ReadTool().execute({ path: "a.txt" }, ctx({ maxOutputChars: 32_000 }));

    expect(result.output).toBe("hello");
  });

  it("serves a prefix that fits the budget and names the offset that continues it", async () => {
    writeFileSync(join(dir, "big.txt"), ruler(10_000));

    const result = await new ReadTool().execute({ path: "big.txt" }, ctx({ maxOutputChars: 2_000 }));

    expect(result.output.length).toBeLessThanOrEqual(2_000);
    expect(result.output).toMatch(/read\(path="big\.txt", offset=\d+\) continues from here/);
    expect(result.output).toContain("characters remain");
  });

  it("continues from the offset it gave, with no gap and no overlap", async () => {
    // The property that makes paging worth having. An offset that is off by a
    // window is worse than no offset: it looks like it worked.
    const body = ruler(10_000);
    writeFileSync(join(dir, "big.txt"), body);
    const tool = new ReadTool();

    let offset = 0;
    let assembled = "";
    for (let page = 0; page < 20; page++) {
      const result = await tool.execute({ path: "big.txt", offset }, ctx({ maxOutputChars: 2_000 }));
      const next = result.output.match(/offset=(\d+)\)/);
      assembled += result.output.replace(/\n\n\[[^\]]*\]$/, "");
      if (!next) break;
      offset = Number(next[1]);
    }

    expect(assembled).toBe(body);
  });

  it("honours an explicit limit over the budget", async () => {
    writeFileSync(join(dir, "big.txt"), ruler(10_000));

    const result = await new ReadTool().execute({ path: "big.txt", limit: 50 }, ctx({ maxOutputChars: 32_000 }));

    expect(result.output.startsWith(ruler(10_000).slice(0, 50))).toBe(true);
    expect(result.output).toContain("9,950 of 10,000 characters remain");
  });

  it("says where a resumed read picked up", async () => {
    writeFileSync(join(dir, "big.txt"), ruler(10_000));

    const result = await new ReadTool().execute({ path: "big.txt", offset: 4_000 }, ctx({ maxOutputChars: 32_000 }));

    expect(result.output).toContain("Resumed at character 4,000 of 10,000");
  });

  it("returns an empty window past the end rather than an error", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");

    const result = await new ReadTool().execute({ path: "a.txt", offset: 99 }, ctx());

    expect(result.success).toBe(true);
    expect(result.output).toContain("Resumed at character 5 of 5");
  });

  it("rejects a negative offset and a zero limit", async () => {
    writeFileSync(join(dir, "a.txt"), "hello");
    const tool = new ReadTool();

    expect((await tool.execute({ path: "a.txt", offset: -1 }, ctx())).error).toMatch(/offset/);
    expect((await tool.execute({ path: "a.txt", limit: 0 }, ctx())).error).toMatch(/limit/);
  });

  it("takes the numbers a model sends as strings", async () => {
    writeFileSync(join(dir, "big.txt"), ruler(1_000));

    const result = await new ReadTool().execute({ path: "big.txt", offset: "100", limit: "50" }, ctx());

    expect(result.output.startsWith(ruler(1_000).slice(100, 150))).toBe(true);
  });

  it("reads the whole file when no budget is set, as it always did", async () => {
    // `maxOutputChars` is advisory and absent for any caller that builds a
    // ToolContext itself. Silently truncating those would be a regression
    // dressed as a feature.
    const body = ruler(100_000);
    writeFileSync(join(dir, "big.txt"), body);

    const result = await new ReadTool().execute({ path: "big.txt" }, ctx());

    expect(result.output).toBe(body);
  });
});

describe("the elided middle of a capped result", () => {
  it("is reachable by paging the saved copy", async () => {
    // The measurement from the issue, run the other way round — and run
    // through the cap, because the cap is what made it a dead end. A `read`
    // whose result is not capped proves nothing: the trap was that the
    // recovery read was cut by the same function, at the same limit, on the
    // same bytes, and so came back byte-identical.
    const LIMIT = 4_000;
    const raw = ruler(40_000);
    const capped = await capToolOutput(raw, { toolName: "grep", limit: LIMIT, sessionId: "s", scratchDir: dir });

    const saved = capped.match(/Full output: (\S+)/)?.[1];
    expect(saved).toBeTruthy();

    /** One round of the agent loop: execute, then cap what it returned. */
    const readThroughTheLoop = async (offset: number): Promise<string> => {
      const result = await new ReadTool().execute({ path: saved as string, offset }, ctx({ maxOutputChars: LIMIT }));
      return capToolOutput(result.output, { toolName: "read", limit: LIMIT, sessionId: "s", scratchDir: dir });
    };

    const pages: string[] = [];
    let offset = 0;
    for (let page = 0; page < 40; page++) {
      const output = await readThroughTheLoop(offset);
      pages.push(output);
      const next = output.match(/offset=(\d+)\)/);
      if (!next) break;
      offset = Number(next[1]);
    }

    // Every page is a fresh window, not the same string again — the exact
    // property the old behaviour failed.
    expect(new Set(pages).size).toBe(pages.length);
    const assembled = pages.map((p) => p.replace(/\n\n\[[^\]]*\]$/, "")).join("");
    expect(assembled).toBe(raw);
    // Everything between head and tail, which no call could previously return.
    expect(assembled).toContain(raw.slice(2_800, -1_200));
  });

  it("names the saved file and the offset to resume it", async () => {
    const capped = await capToolOutput(ruler(40_000), {
      toolName: "grep",
      limit: 4_000,
      sessionId: "s",
      scratchDir: dir,
    });

    expect(capped).toMatch(/read\(path="\S+", offset=4000\)/);
    // The old sentence claimed the saved copy was another copy of this string.
    expect(capped).not.toContain("reading the saved copy, returns this same");
  });

  it("still says the middle is gone when the copy could not be saved", async () => {
    const capped = await capToolOutput(ruler(40_000), {
      toolName: "grep",
      limit: 4_000,
      sessionId: "s",
      // A path that cannot be created, so persistence fails and the marker
      // must not point at a file that is not there.
      scratchDir: "/dev/null/nope",
    });

    expect(capped).toContain("cannot be recovered");
    expect(capped).not.toContain("read(path=");
  });
});
