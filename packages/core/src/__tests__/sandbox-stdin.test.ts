/**
 * The host sandbox is the path exec actually takes in a live deployment.
 *
 * `buildLoopOptions` gives every agent a sandbox — defaulting to `host` — so
 * `ExecTool.execute` returns at its `context.sandbox` branch and never reaches
 * its own `execFile` call. Closing stdin in ExecTool alone therefore fixed
 * nothing that a running agent does, which is exactly how it played out: the
 * fix verified green in isolation while the deployment kept hanging for 27
 * seconds on every `ntn api` call.
 *
 * Both spawn sites now close stdin. This test pins the one that runs.
 */
import { describe, expect, it } from "vitest";
import { HostSandbox } from "../sandboxes/host.js";
import { ExecTool } from "../tools/exec.js";
import type { ToolContext } from "../tools/interface.js";

describe("HostSandbox stdin", () => {
  it("gives the command a closed stdin", async () => {
    const sandbox = new HostSandbox();
    const handle = await sandbox.prepare({ cwd: process.cwd() });

    const started = Date.now();
    // Reads to EOF. With an open pipe this blocks until the 30s default.
    const result = await sandbox.exec(handle, "cat; echo done", { timeoutMs: 5000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("done");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("does not hang when ExecTool routes through the sandbox", async () => {
    const sandbox = new HostSandbox();
    const handle = await sandbox.prepare({ cwd: process.cwd() });
    const ctx: ToolContext = {
      sessionId: "sandbox-stdin",
      workingDirectory: process.cwd(),
      env: {},
      sandbox,
      sandboxHandle: handle,
    };

    const started = Date.now();
    const result = await new ExecTool(undefined, 5000).execute({ command: "cat | wc -c" }, ctx);

    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});
