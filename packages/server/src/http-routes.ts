/**
 * Adapter from core's framework-agnostic HTTP route seam onto Hono.
 *
 * Core owns an {@link HttpRouteRegistry} of `{ method, path, handler }`
 * descriptors (see `@tailored-ai/core` → `http/registry.ts`); plugins register
 * routes there via `ctx.http`. The server, after building its Hono app, calls
 * {@link mountPluginHttpRoutes} to wire each descriptor onto the router. Core
 * never imports Hono — the adaptation lives here, in the server.
 *
 * Auth: the server's `/api/*` bearer middleware already covers these paths
 * (they all live under `/api/…`). Routes declared `auth: "none"` are exempted
 * by the middleware (see `index.ts`), so this adapter doesn't re-check auth —
 * it only translates the request/response shapes.
 */

import type { AgentRuntime, HttpMethod, ResolvedHttpRoute, TaiHttpRequest } from "@tailored-ai/core";
import type { Hono } from "hono";

/**
 * Compile a route mount path (with optional `:param` segments) into a regex
 * matching a concrete request path. Used by the auth middleware to recognize
 * `auth: "none"` routes from the concrete URL. Anchored; `:param` matches a
 * single non-slash segment.
 */
export function routePathToRegex(mountPath: string): RegExp {
  const pattern = mountPath
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

/** Hono's per-route registrar method names, keyed by our method enum. */
const HONO_METHOD: Record<HttpMethod, "get" | "post" | "put" | "patch" | "delete" | "options"> = {
  GET: "get",
  HEAD: "get", // Hono serves HEAD off the GET handler.
  POST: "post",
  PUT: "put",
  PATCH: "patch",
  DELETE: "delete",
  OPTIONS: "options",
};

/**
 * Mount every route in the runtime's HTTP route registry onto the Hono app.
 * Idempotent per app instance only in the sense that the registry is read once
 * at startup; Hono can't unmount routes, so handlers read live runtime state
 * on each request rather than being re-mounted on reload. Call after the core
 * routes and the auth middleware are in place, before the SPA fallback.
 */
export function mountPluginHttpRoutes(app: Hono, runtime: AgentRuntime): void {
  for (const route of runtime.getHttpRoutes().list()) {
    mountOne(app, route);
  }
}

function mountOne(app: Hono, route: ResolvedHttpRoute): void {
  const register = HONO_METHOD[route.method];
  app[register](route.mountPath, async (c) => {
    const req: TaiHttpRequest = {
      method: c.req.method,
      path: c.req.path,
      params: c.req.param() as Record<string, string>,
      query: c.req.query(),
      headers: lowercaseHeaders(c.req.header()),
      json: <T = unknown>() => c.req.json() as Promise<T>,
      text: () => c.req.text(),
    };
    const res = await route.handler(req);
    // Build the response via `c.newResponse`, casting status to sidestep
    // Hono's literal-typed status overloads (status is a runtime number here).
    const headers: Record<string, string> = { ...(res.headers ?? {}) };
    let payload: string;
    if (res.json !== undefined) {
      payload = JSON.stringify(res.json);
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
      if (!hasContentType) headers["Content-Type"] = "application/json";
    } else {
      payload = res.body ?? "";
    }
    return c.newResponse(payload, (res.status ?? 200) as 200, headers);
  });
}

/** Lowercase header keys so handlers can read them case-insensitively. */
function lowercaseHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}
