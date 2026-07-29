import { describe, expect, it, vi } from "vitest";
import { executeHooks } from "../agent/hooks.js";
import type { Tool, ToolResult } from "../tools/interface.js";

function tool(name: string, execute: () => Promise<ToolResult>): Tool {
  return { name, description: name, parameters: { type: "object", properties: {} }, execute } as unknown as Tool;
}

const ok = (output: string) => tool("gmail", async () => ({ success: true, output }));
const throws = () =>
  tool("gmail", async () => {
    throw new Error("oauth2: invalid_grant");
  });
const reportsFailure = () =>
  tool("gmail", async () => ({ success: false, output: "", error: "oauth2: invalid_grant" }));

describe("executeHooks — failing hooks must not silently produce empty context", () => {
  it("aborts when a hook throws", async () => {
    const result = await executeHooks([{ tool: "gmail" }], [throws()], {}, "s1");

    expect(result.failed).toBe(true);
    expect(result.failure).toMatch(/invalid_grant/);
    expect(result.skipped).toBe(false);
  });

  it("aborts when a hook reports success:false without throwing", async () => {
    // This is the shape that caused the damage: the tool returned cleanly with
    // an error and an empty output, `skipIf: ^No results` did not match the
    // empty string, and the run proceeded with a prompt claiming to contain
    // emails that were not there.
    const result = await executeHooks([{ tool: "gmail", skipIf: "^No results" }], [reportsFailure()], {}, "s1");

    expect(result.failed).toBe(true);
    expect(result.failure).toMatch(/invalid_grant/);
  });

  it("skips a hook whose tool is not registered without killing the pipeline", async () => {
    // A missing tool means a disabled plugin or a rename — a config problem,
    // not the "prompt promises data that isn't there" problem. Taking every
    // unrelated hook down with it would be a much wider blast radius than the
    // bug this fail-closed path exists to fix.
    const later = vi.fn(async () => ({ success: true, output: "later ran" }));
    const result = await executeHooks(
      [{ tool: "nonexistent" }, { tool: "calendar" }],
      [tool("calendar", later)],
      {},
      "s1",
    );

    expect(result.failed).toBe(false);
    expect(later).toHaveBeenCalled();
    expect(result.outputs).toContain("later ran");
  });

  it("continues past a failure only when explicitly told to", async () => {
    const second = vi.fn(async () => ({ success: true, output: "second ran" }));
    const result = await executeHooks(
      [{ tool: "gmail", onError: "continue" }, { tool: "calendar" }],
      [throws(), tool("calendar", second)],
      {},
      "s1",
    );

    expect(result.failed).toBe(false);
    expect(second).toHaveBeenCalled();
    expect(result.outputs).toContain("second ran");
  });

  it("reports success normally when every hook succeeds", async () => {
    const result = await executeHooks([{ tool: "gmail" }], [ok("3 new emails")], {}, "s1");

    expect(result.failed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.outputs).toEqual(["3 new emails"]);
  });

  it("still honors skipIf on a successful hook", async () => {
    const result = await executeHooks([{ tool: "gmail", skipIf: "^No results" }], [ok("No results")], {}, "s1");

    expect(result.skipped).toBe(true);
    expect(result.failed).toBe(false);
  });
});
