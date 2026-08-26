/**
 * Commands run by an agent get no stdin.
 *
 * `execFile`'s default gives the child an open stdin pipe that is never
 * written to and never closed. A CLI that reads stdin when it is not a TTY
 * therefore blocks until the tool's timeout kills it — and because the kill
 * discards the buffers, the agent sees empty stdout, empty stderr and a bare
 * "Command failed", which reads as "that binary isn't installed".
 *
 * Found with the Notion CLI: `ntn api v1/users/me` succeeded, while
 * `ntn api v1/users/me | jq -r .name` hung for the full 30 seconds. The model
 * concluded, reasonably and wrongly, that ntn was not installed.
 */
import { describe, expect, it } from "vitest";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

const ctx: ToolContext = { sessionId: "stdin-test", workingDirectory: process.cwd(), env: {} };

describe("ExecTool stdin", () => {
  it("gives the command a closed stdin rather than an open pipe", async () => {
    const tool = new ExecTool(undefined, 5000);
    // Reads until EOF. With an open pipe this blocks until the timeout; with
    // stdin closed it returns immediately.
    const result = await tool.execute({ command: "cat; echo done" }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain("done");
  });

  it("does not hang when a command reads stdin inside a pipeline", async () => {
    const tool = new ExecTool(undefined, 5000);
    const started = performance.now();
    const result = await tool.execute({ command: "cat | wc -c" }, ctx);

    expect(result.success).toBe(true);
    // The shape of the original bug: it would sit here for the whole timeout.
    expect(performance.now() - started).toBeLessThan(4000);
  });
});
