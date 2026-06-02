/**
 * Integration test: WebFetchTool surfaces an EgressPolicy denial as a
 * structured ToolResult error instead of letting the fetch run. Closes
 * the wiring side of #57.
 */

import { describe, expect, it } from "vitest";
import { EgressPolicy } from "../security/egress-policy.js";
import type { ToolContext } from "../tools/interface.js";
import { WebFetchTool } from "../tools/web-fetch.js";

function ctx(): ToolContext {
  return { sessionId: "test", workingDirectory: process.cwd(), env: {} };
}

describe("WebFetchTool + EgressPolicy wiring", () => {
  it("returns a structured error when the policy blocks the URL", async () => {
    const policy = new EgressPolicy(); // strict defaults
    const tool = new WebFetchTool(5_000, policy);
    const res = await tool.execute({ url: "http://10.0.0.1/" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Egress denied/);
    expect(res.error).toMatch(/RFC1918/);
  });

  it("blocks the metadata IP regardless of the host string used", async () => {
    const policy = new EgressPolicy();
    const tool = new WebFetchTool(5_000, policy);
    const res = await tool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/metadata/);
  });

  it("respects allowHosts for an explicit internal opt-in", async () => {
    const policy = new EgressPolicy({ allowHosts: ["internal.example.com"] }, async () => ["10.0.0.1"]);
    const tool = new WebFetchTool(5_000, policy);
    // The fetch itself will fail (no network), but the relevant
    // assertion is that the failure isn't an Egress denial — the
    // policy's allowHosts let it through.
    const res = await tool.execute({ url: "http://internal.example.com/" }, ctx());
    if (!res.success) {
      expect(res.error).not.toMatch(/Egress denied/);
    }
  }, 8_000);
});
