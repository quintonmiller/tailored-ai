/**
 * Adapter from core's framework-agnostic HTTP route seam onto Hono.
 *
 * Core owns an {@link HttpRouteRegistry} of `{ method, path, handler }`
 * descriptors (see `@tailored-ai/core` → `http/registry.ts`); plugins register
 * routes there via `ctx.http`. The server calls {@link mountPluginHttpRoutes}
 * once, which serves them all from one mount that matches each request against
 * the registry as it is then. Core never imports Hono — the adaptation lives
 * here, in the server.
 *
 * Auth: the server's `/api/*` bearer middleware already covers these paths
 * (they all live under `/api/…`). Routes declared `auth: "none"` are exempted
 * by the middleware through {@link pluginAuthExemption}, so this adapter
 * doesn't re-check auth — it only translates the request/response shapes.
 */

import type { AgentRuntime, HttpMethod, HttpRouteRegistry, ResolvedHttpRoute, TaiHttpRequest } from "@tailored-ai/core";
import type { Context, Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router";

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

/** The request method a descriptor answers, as Hono routes it: HEAD is served off GET. */
const ROUTE_METHOD: Record<HttpMethod, string> = {
  GET: "GET",
  HEAD: "GET",
  POST: "POST",
  PUT: "PUT",
  PATCH: "PATCH",
  DELETE: "DELETE",
  OPTIONS: "OPTIONS",
};

/**
 * Something compiled from the registry, rebuilt only when the registry's
 * version moves: a reload's dispose and re-load change it, a request doesn't.
 */
function compiledFrom<T>(registry: HttpRouteRegistry, compile: (routes: readonly ResolvedHttpRoute[]) => T): () => T {
  let built: { version: number; value: T } | undefined;
  return () => {
    if (built?.version !== registry.version) {
      built = { version: registry.version, value: compile(registry.list()) };
    }
    return built.value;
  };
}

/**
 * Serve every route in the runtime's HTTP route registry. Hono can't unmount
 * a route, so rather than adapting each descriptor onto the app at startup,
 * this adds one middleware that matches each request against the registry as
 * it is then. A plugin a reload turns on is served from its first request
 * after, one turned off stops being served, and one re-loaded with a changed
 * handler is served the new handler, all without a restart.
 *
 * Call after the core routes and the auth middleware are in place, before the
 * SPA fallback: a core route still wins, a plugin route wins over the static
 * index, and a request no plugin route matches falls through to what follows.
 * Matching uses Hono's own router, so `:param` paths work as they did when each
 * route was added to the app.
 */
export function mountPluginHttpRoutes(app: Hono, runtime: AgentRuntime): void {
  const router = compiledFrom(runtime.getHttpRoutes(), (routes) => {
    const r = new TrieRouter<ResolvedHttpRoute>();
    for (const route of routes) r.add(ROUTE_METHOD[route.method], route.mountPath, route);
    return r;
  });
  app.use("*", async (c, next) => {
    // Hono routes a HEAD request as a GET and drops the body from the answer.
    const method = c.req.method === "HEAD" ? "GET" : c.req.method;
    // A TrieRouter always answers in the `[handler, params]` shape.
    const [matches] = router().match(method, c.req.path) as [[ResolvedHttpRoute, Record<string, string>][]];
    const first = matches[0];
    if (!first) return next();
    return respond(c, first[0], first[1]);
  });
}

/**
 * Whether a request is to a plugin route declared `auth: "none"`, read from
 * the registry as it is then, so a route a reload adds or removes is exempt,
 * or not, from the next request on.
 */
export function pluginAuthExemption(runtime: AgentRuntime): (method: string, path: string) => boolean {
  const matchers = compiledFrom(runtime.getHttpRoutes(), (routes) =>
    routes
      .filter((r) => r.auth === "none")
      .map((r) => ({ method: r.method as string, regex: routePathToRegex(r.mountPath) })),
  );
  return (method, path) => matchers().some((m) => m.method === method && m.regex.test(path));
}

async function respond(c: Context, route: ResolvedHttpRoute, params: Record<string, string>): Promise<Response> {
  const req: TaiHttpRequest = {
    method: c.req.method,
    path: c.req.path,
    params: decodeParams(params),
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
}

/** Percent-decode params the way `c.req.param()` does, leaving one that won't decode as it came. */
function decodeParams(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!v.includes("%")) {
      out[k] = v;
      continue;
    }
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Lowercase header keys so handlers can read them case-insensitively. */
function lowercaseHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}
