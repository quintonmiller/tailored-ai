import { beforeEach, describe, expect, it } from "vitest";
import { _resetEgressPolicy, registerMediatorSession, unregisterMediatorSession } from "../browser/egress-policy.js";
import { WebFetchTool } from "../tools/web-fetch.js";

const CTX = {
  sessionId: "test",
  workingDirectory: "/tmp",
  env: {},
} as Parameters<WebFetchTool["execute"]>[1];

describe("web_fetch crosstalk policy", () => {
  beforeEach(() => _resetEgressPolicy());

  it("blocks fetches outside the active mediator allow-list", async () => {
    registerMediatorSession("s1", ["amazon.com"]);
    const tool = new WebFetchTool();
    const res = await tool.execute({ url: "https://attacker.test/exfil" }, CTX);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Refusing web_fetch/);
    expect(res.error).toMatch(/browser-mediator session is active/);
    unregisterMediatorSession("s1");
  });

  it("does NOT gate when no mediator session is active", async () => {
    // Don't actually fetch — just confirm the gate doesn't short-circuit.
    // We use an invalid scheme to fail fast inside the fetch path.
    const tool = new WebFetchTool();
    const res = await tool.execute({ url: "not-a-url" }, CTX);
    expect(res.error).toMatch(/Invalid URL/);
  });

  it("permits hosts inside the allow-list (will fail at fetch, not at policy)", async () => {
    registerMediatorSession("s1", ["127.0.0.1"]);
    const tool = new WebFetchTool();
    // Port 1 is reserved; the actual fetch will fail. We only assert that
    // it gets PAST the policy gate (no 'Refusing web_fetch' error).
    const res = await tool.execute({ url: "http://127.0.0.1:1/" }, CTX);
    expect(res.error ?? "").not.toMatch(/Refusing web_fetch/);
    unregisterMediatorSession("s1");
  });
});
