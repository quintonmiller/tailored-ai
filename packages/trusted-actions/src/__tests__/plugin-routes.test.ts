import {
  type AgentConfig,
  type AgentRuntime,
  findOrCreateSession,
  getSessionMessages,
  initDatabase,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTrustedActionsRoutes } from "../plugin.js";

type Db = ReturnType<typeof initDatabase>;

/**
 * Minimal runtime stub — the plugin only reads `getConfig().trustedActions`
 * and `db` (for getSession/saveMessage in the callback). Cast through unknown
 * so we don't have to satisfy the whole AgentRuntime surface.
 */
function fakeRuntime(db: Db, trustedActions: AgentConfig["trustedActions"]): AgentRuntime {
  return {
    db,
    getConfig: () => ({ trustedActions }) as AgentConfig,
  } as unknown as AgentRuntime;
}

let db: Db;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const enabledConfig = { enabled: true, url: "http://executor:3100", sharedSecret: "shh" } as const;

function findRoute(runtime: AgentRuntime, method: string, path: string) {
  const route = buildTrustedActionsRoutes(runtime).find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function makeReq(over: Partial<Parameters<ReturnType<typeof findRoute>["handler"]>[0]> = {}) {
  return {
    method: "GET",
    path: "/api/trusted-actions",
    params: {},
    query: {},
    headers: {},
    json: async () => ({}),
    text: async () => "",
    ...over,
  } as Parameters<ReturnType<typeof findRoute>["handler"]>[0];
}

describe("trusted-actions plugin route descriptors", () => {
  it("registers the four routes at their historical absolute paths", () => {
    const routes = buildTrustedActionsRoutes(fakeRuntime(db, enabledConfig));
    const paths = routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(paths).toEqual(
      [
        "GET /api/trusted-actions/subscriptions",
        "GET /api/trusted-actions/history",
        "POST /api/trusted-actions/subscriptions/:op",
        "POST /api/trusted-actions/callback",
      ].sort(),
    );
    // All mount at the verbatim legacy path (absolute), not under /api/ext.
    expect(routes.every((r) => r.absolute === true)).toBe(true);
  });

  it("marks only the callback as auth:'none' (executor-called)", () => {
    const routes = buildTrustedActionsRoutes(fakeRuntime(db, enabledConfig));
    const callback = routes.find((r) => r.path === "/api/trusted-actions/callback");
    expect(callback?.auth).toBe("none");
    for (const r of routes.filter((r) => r.path !== "/api/trusted-actions/callback")) {
      // undefined defaults to "token"
      expect(r.auth ?? "token").toBe("token");
    }
  });
});

describe("subscriptions pass-through", () => {
  it("proxies the executor with the shared secret and returns its body", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ subs: [] }), { status: 200 }));
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "GET", "/api/trusted-actions/subscriptions");
    const res = await route.handler(makeReq());
    expect(res.status).toBe(200);
    expect(res.body).toBe(JSON.stringify({ subs: [] }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://executor:3100/internal/subscriptions",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer shh" }),
      }),
    );
  });

  it("returns 503 when the executor is not configured", async () => {
    const runtime = fakeRuntime(db, { enabled: false, url: "", sharedSecret: "" });
    const route = findRoute(runtime, "GET", "/api/trusted-actions/subscriptions");
    const res = await route.handler(makeReq());
    expect(res.status).toBe(503);
  });

  it("rejects an unknown subscription op with 404", async () => {
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "POST", "/api/trusted-actions/subscriptions/:op");
    const res = await route.handler(makeReq({ method: "POST", params: { op: "explode" } }));
    expect(res.status).toBe(404);
  });
});

describe("callback auth + injection", () => {
  it("401s without the shared-secret bearer", async () => {
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "POST", "/api/trusted-actions/callback");
    const res = await route.handler(makeReq({ method: "POST", headers: {} }));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong secret", async () => {
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "POST", "/api/trusted-actions/callback");
    const res = await route.handler(makeReq({ method: "POST", headers: { authorization: "Bearer nope" } }));
    expect(res.status).toBe(401);
  });

  it("injects a system message into the originating session on success", async () => {
    const session = findOrCreateSession(db, "web:test", "m", "p");
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "POST", "/api/trusted-actions/callback");
    const res = await route.handler(
      makeReq({
        method: "POST",
        headers: { authorization: "Bearer shh" },
        json: async () =>
          ({
            action_id: "act_1",
            type: "purchase.amazon",
            status: "completed",
            session_id: session.id,
            result: { ok: true },
          }) as never,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, injected: true });
    const messages = getSessionMessages(db, session.id);
    const injected = messages.find((m) => String(m.content).includes("[trusted-actions notification]"));
    expect(injected).toBeTruthy();
    expect(String(injected?.content)).toContain("act_1");
  });

  it("does not inject for an ephemeral (non-persistent) session", async () => {
    const runtime = fakeRuntime(db, enabledConfig);
    const route = findRoute(runtime, "POST", "/api/trusted-actions/callback");
    const res = await route.handler(
      makeReq({
        method: "POST",
        headers: { authorization: "Bearer shh" },
        json: async () => ({ action_id: "act_2", status: "completed", session_id: "does-not-exist" }) as never,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, injected: false });
  });
});
