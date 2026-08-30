/**
 * The tools moved out of `@tailored-ai/core` into this package (#616), so the
 * thing worth testing is that they still *appear* — a tool set that silently
 * stops registering looks exactly like a model choosing not to call anything.
 *
 * The routes had already moved for the same reason ("product-specific... belong
 * with the package that owns the executor"); the tools had not followed, which
 * left core shipping client code for one executor, including a tool that buys
 * things on Amazon.
 */

import type { AgentConfig } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { buildTrustedActionsTools } from "../plugin.js";

const configured = {
  trustedActions: { enabled: true, url: "http://executor:3100", sharedSecret: "shh" },
  server: { port: 3000 },
} as unknown as AgentConfig;

describe("buildTrustedActionsTools", () => {
  it("registers all four tools when the executor is configured", () => {
    expect(
      buildTrustedActionsTools(configured)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["check_action_status", "purchase_item", "request_action", "request_read"]);
  });

  it("registers nothing when the executor is not configured", () => {
    // The gate core used, preserved exactly: an install that never set this up
    // sees no tools, rather than four that fail on first call.
    expect(buildTrustedActionsTools({} as AgentConfig)).toEqual([]);
    expect(buildTrustedActionsTools({ trustedActions: { enabled: false } } as unknown as AgentConfig)).toEqual([]);
  });

  it("registers nothing when enabled but missing url or secret", () => {
    // Half-configured is the dangerous shape: enabling without credentials
    // would otherwise hand the agent tools that cannot authenticate.
    const noUrl = { trustedActions: { enabled: true, sharedSecret: "shh" } } as unknown as AgentConfig;
    const noSecret = { trustedActions: { enabled: true, url: "http://x" } } as unknown as AgentConfig;
    expect(buildTrustedActionsTools(noUrl)).toEqual([]);
    expect(buildTrustedActionsTools(noSecret)).toEqual([]);
  });

  it("points the callback at the configured server port", () => {
    const onPort = { ...(configured as object), server: { port: 4321 } } as unknown as AgentConfig;
    expect(describeCallback(onPort)).toBe("http://host.docker.internal:4321/api/trusted-actions/callback");
  });

  it("falls back to port 3000 when no server block is set", () => {
    // Exercises the `?? 3000` default, which the case above does not: it sets
    // a port explicitly, so the fallback never runs. Caught by a control run —
    // breaking the default left that test green.
    const noServer = {
      trustedActions: (configured as unknown as { trustedActions: object }).trustedActions,
    } as unknown as AgentConfig;
    expect(describeCallback(noServer)).toBe("http://host.docker.internal:3000/api/trusted-actions/callback");
  });

  it("honours an explicit callbackBaseUrl, without doubling the slash", () => {
    const withBase = {
      trustedActions: {
        ...(configured as never as { trustedActions: object }).trustedActions,
        callbackBaseUrl: "https://tai.example.com/",
      },
    } as unknown as AgentConfig;
    expect(describeCallback(withBase)).toBe("https://tai.example.com/api/trusted-actions/callback");
  });
});

/** Read the callback URL the tools were constructed with. */
function describeCallback(config: AgentConfig): string {
  const tools = buildTrustedActionsTools(config) as unknown as Array<Record<string, unknown>>;
  for (const t of tools) {
    for (const v of Object.values(t)) {
      if (v && typeof v === "object" && typeof (v as { callbackUrl?: unknown }).callbackUrl === "string") {
        return (v as { callbackUrl: string }).callbackUrl;
      }
    }
  }
  throw new Error("no callbackUrl found on any constructed tool");
}
