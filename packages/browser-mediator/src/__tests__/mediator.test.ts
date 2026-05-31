import { createServer, type Server } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { anthropicToolSpec, handleAnthropicToolCall } from "../adapters/anthropic.js";
import { handleOpenAIToolCall, openaiToolSpec } from "../adapters/openai.js";
import { createTaiTool } from "../adapters/tai.js";
import { classifyButtonText, DEFAULT_ALWAYS_HITL, isAlwaysHitl } from "../always-hitl.js";
import {
  activeSessionIds,
  isHostAllowed,
  registerMediatorSession,
  unregisterMediatorSession,
} from "../egress-policy.js";
import { BrowserMediator } from "../mediator.js";
import { sanitizeOutput } from "../output-sanitizer.js";

function resetPolicy() {
  for (const id of activeSessionIds()) unregisterMediatorSession(id);
}

describe("pure-logic exports", () => {
  beforeEach(resetPolicy);

  it("classifyButtonText covers the canonical risky buttons", () => {
    expect(classifyButtonText("Place your order")).toBe("place-order");
    expect(classifyButtonText("Pay $42")).toBe("payment-form-fill");
    expect(classifyButtonText("Submit")).toBe("submit");
    expect(classifyButtonText("Add to cart")).toBeNull();
  });

  it("isAlwaysHitl uses the default list when no domain config", () => {
    expect(isAlwaysHitl("place-order", "amazon.com", {})).toBe(true);
    expect(isAlwaysHitl("submit", "amazon.com", {})).toBe(true);
    expect(DEFAULT_ALWAYS_HITL.length).toBeGreaterThan(0);
  });

  it("sanitizeOutput redacts Luhn-checked PANs and SSNs", () => {
    const out = sanitizeOutput("PAN 4242424242424242, SSN 111-22-3333");
    expect(out).toContain("[REDACTED-PAN]");
    expect(out).toContain("[REDACTED-SSN]");
    expect(out).not.toContain("4242424242424242");
  });

  it("egress policy intersects multiple sessions", () => {
    registerMediatorSession("s1", ["a.test", "b.test"]);
    registerMediatorSession("s2", ["b.test"]);
    expect(isHostAllowed("a.test")).toBe(false); // s2 doesn't allow
    expect(isHostAllowed("b.test")).toBe(true);
    unregisterMediatorSession("s2");
    expect(isHostAllowed("a.test")).toBe(true);
  });
});

describe("BrowserMediator session id", () => {
  it("mints fresh ids per instance and matches subdomain rule", () => {
    const a = new BrowserMediator();
    const b = new BrowserMediator();
    expect(a.sessionId).not.toEqual(b.sessionId);
    const m = new BrowserMediator({ egressAllowList: ["amazon.com"] });
    expect(m.hostAllowed("www.amazon.com")).toBe(true);
    expect(m.hostAllowed("attacker.test")).toBe(false);
  });
});

describe("adapter shapes", () => {
  it("OpenAI tool spec has type=function and name=browser_mediator", () => {
    const spec = openaiToolSpec();
    expect(spec.type).toBe("function");
    expect(spec.function.name).toBe("browser_mediator");
    expect(spec.function.parameters).toBeDefined();
  });

  it("Anthropic tool spec has name + input_schema", () => {
    const spec = anthropicToolSpec();
    expect(spec.name).toBe("browser_mediator");
    expect(spec.input_schema).toBeDefined();
  });

  it("TAI adapter exposes execute() and a Tool-shaped object", () => {
    const tool = createTaiTool({ egressAllowList: [] });
    expect(tool.name).toBe("browser_mediator");
    expect(typeof tool.execute).toBe("function");
  });
});

// -------- Integration: real Chromium against a tiny local server --------

async function browserAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

async function startServer(html: string): Promise<{ server: Server; url: string }> {
  return await new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("bad address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

describe("adapter integration (real chromium)", () => {
  let SKIP = false;
  beforeEach(async () => {
    resetPolicy();
    SKIP = !(await browserAvailable());
    if (SKIP) console.warn("[adapter-integration] skipping — no browser");
  });

  it("OpenAI adapter end-to-end against a local page", async () => {
    if (SKIP) return;
    const { server, url } = await startServer(`<html><body><h1>OpenAI adapter test</h1></body></html>`);
    const mediator = new BrowserMediator({ egressAllowList: ["127.0.0.1"] });
    try {
      const navJson = JSON.stringify({ action: "navigate", url });
      const navResult = await handleOpenAIToolCall(mediator, navJson);
      expect(navResult.ok).toBe(true);
      expect(navResult.content).toContain("Navigated to");

      const readResult = await handleOpenAIToolCall(mediator, JSON.stringify({ action: "read_text" }));
      expect(readResult.content).toContain("OpenAI adapter test");
    } finally {
      await mediator.close();
      server.close();
    }
  });

  it("Anthropic adapter end-to-end against a local page", async () => {
    if (SKIP) return;
    const { server, url } = await startServer(`<html><body><h1>Claude adapter test</h1></body></html>`);
    const mediator = new BrowserMediator({ egressAllowList: ["127.0.0.1"] });
    try {
      const nav = await handleAnthropicToolCall(mediator, { action: "navigate", url });
      expect(nav.is_error).toBe(false);
      const read = await handleAnthropicToolCall(mediator, { action: "read_text" });
      expect(read.content).toContain("Claude adapter test");
    } finally {
      await mediator.close();
      server.close();
    }
  });

  it("resolveSecret hook expands $ns.key inside type_text without leaking", async () => {
    if (SKIP) return;
    const { server, url } = await startServer(`<html><body><input id="pw" type="text" /></body></html>`);
    const audit: Array<{ result: string; args: Record<string, unknown> }> = [];
    const mediator = new BrowserMediator({
      egressAllowList: ["127.0.0.1"],
      resolveSecret: async (ns, key) => (ns === "test" && key === "password" ? "the-actual-secret" : null),
      audit: (e) => audit.push({ result: e.result, args: e.args as Record<string, unknown> }),
    });
    try {
      await mediator.start();
      await mediator.navigate(url);
      const r = await mediator.typeText("text=", "$test.password");
      expect(r).not.toContain("the-actual-secret");
      const typeEntry = audit.find((a) => JSON.stringify(a.args).includes("nodeIdOrText"));
      expect(JSON.stringify(typeEntry?.args)).not.toContain("the-actual-secret");
      expect(JSON.stringify(typeEntry?.args)).toContain("<masked:$test.password>");
    } finally {
      await mediator.close();
      server.close();
    }
  });
});
