/**
 * TAI plugin entry — registers the `/api/trusted-actions/*` HTTP routes on the
 * TAI server through core's HTTP route seam (`ctx.http`). These routes used to
 * live in `@tailored-ai/server`; they are product-specific (Amazon / executor
 * pass-throughs) and belong with the package that owns the executor.
 *
 * The routes proxy the executor's `/internal/*` endpoints (authenticating with
 * the shared secret from `config.trustedActions`) plus the executor → TAI
 * callback. They keep their historical absolute paths via the registry's
 * `absolute: true` escape hatch so the UI (`/api/trusted-actions/subscriptions`)
 * and the executor (`/api/trusted-actions/callback`) keep working unchanged.
 *
 * Auth:
 *   - subscriptions / history sit behind the server's `server.authToken`
 *     bearer check like every other `/api/*` route (`auth: "token"`, default).
 *   - the callback is called by the executor service, not a browser. It is
 *     exempt from the server auth (`auth: "none"`) and does its own
 *     shared-secret check, preserving the exact behavior it had in the server.
 *
 * Wire this in as a runtime-context plugin (it needs `ctx.runtime` for live
 * config + the session DB):
 *
 *     plugins:
 *       - module: "@tailored-ai/trusted-actions/plugin"
 */

import {
  getSession,
  type HttpRouteDescriptor,
  type Plugin,
  type PluginContext,
  saveMessage,
  type TaiHttpRequest,
  type TaiHttpResponse,
} from "@tailored-ai/core";
import { CheckActionStatusTool, PurchaseItemTool, RequestActionTool, RequestReadTool } from "./tools.js";

/** Base path the routes have always lived at. Kept for back-compat. */
const BASE = "/api/trusted-actions";

/**
 * Build the four route descriptors against a live runtime. Exported for tests
 * so they can assert paths / auth without running the loader.
 */
export function buildTrustedActionsRoutes(runtime: NonNullable<PluginContext["runtime"]>): HttpRouteDescriptor[] {
  /**
   * Pass-through to the executor's `/internal/*` endpoints. Reads config live
   * each call so a runtime reload picks up url/secret changes. Returns a 503
   * envelope (not a throw) when the executor isn't configured, matching the
   * old server behavior.
   */
  async function callExecutor(path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
    const ta = runtime.getConfig().trustedActions;
    if (!ta?.enabled || !ta.url || !ta.sharedSecret) {
      return {
        status: 503,
        body: JSON.stringify({ error: "Trusted-actions executor not configured" }),
      };
    }
    const url = ta.url.replace(/\/$/, "") + path;
    const resp = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${ta.sharedSecret}`,
        "Content-Type": "application/json",
      },
    });
    return { status: resp.status, body: await resp.text() };
  }

  /** GET /api/trusted-actions/subscriptions */
  const subscriptions: HttpRouteDescriptor = {
    method: "GET",
    path: `${BASE}/subscriptions`,
    absolute: true,
    handler: async (): Promise<TaiHttpResponse> => {
      const r = await callExecutor("/internal/subscriptions");
      return { status: r.status, body: r.body, headers: { "Content-Type": "application/json" } };
    },
  };

  /** POST /api/trusted-actions/subscriptions/:op  (op ∈ approve|reject|delete) */
  const subscriptionOp: HttpRouteDescriptor = {
    method: "POST",
    path: `${BASE}/subscriptions/:op`,
    absolute: true,
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const op = req.params.op;
      if (op !== "approve" && op !== "reject" && op !== "delete") {
        return { status: 404, json: { error: "unknown subscription op" } };
      }
      const body = await req.json().catch(() => ({}));
      const r = await callExecutor(`/internal/subscriptions/${op}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { status: r.status, body: r.body, headers: { "Content-Type": "application/json" } };
    },
  };

  /** GET /api/trusted-actions/history */
  const history: HttpRouteDescriptor = {
    method: "GET",
    path: `${BASE}/history`,
    absolute: true,
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const qs = new URLSearchParams();
      if (req.query.before) qs.set("before", req.query.before);
      if (req.query.limit) qs.set("limit", req.query.limit);
      const path = `/internal/actions/history${qs.toString() ? `?${qs.toString()}` : ""}`;
      const r = await callExecutor(path);
      return { status: r.status, body: r.body, headers: { "Content-Type": "application/json" } };
    },
  };

  /**
   * POST /api/trusted-actions/callback — executor → TAI. Fires when an action
   * enters a terminal state. Injects a system message into the originating
   * session so the agent's next turn can react.
   *
   * Auth: own shared-secret check (`auth: "none"`), exempt from the server's
   * authToken because the caller is the executor service, not a browser. The
   * executor's host must be allow-listed to reach TAI's port (host.docker.
   * internal in the docker-compose setup).
   */
  const callback: HttpRouteDescriptor = {
    method: "POST",
    path: `${BASE}/callback`,
    absolute: true,
    auth: "none",
    handler: async (req: TaiHttpRequest): Promise<TaiHttpResponse> => {
      const ta = runtime.getConfig().trustedActions;
      if (!ta?.sharedSecret) {
        return { status: 503, json: { error: "trustedActions not configured" } };
      }
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${ta.sharedSecret}`) {
        return { status: 401, json: { error: "Unauthorized" } };
      }
      let body: {
        action_id?: string;
        type?: string;
        status?: string;
        session_id?: string;
        result?: unknown;
        error?: string | null;
      };
      try {
        body = await req.json();
      } catch {
        return { status: 400, json: { error: "Invalid JSON" } };
      }
      if (!body.action_id || !body.status) {
        return { status: 400, json: { error: "Missing action_id or status" } };
      }

      // Inject a one-line system message into the originating session so the
      // agent can see the outcome on its next turn. Skip silently when the
      // session refers to an ephemeral one-shot run (no DB row).
      let injected = false;
      if (body.session_id && body.session_id !== "tai-agent") {
        const session = getSession(runtime.db, body.session_id);
        if (session) {
          try {
            const lines: string[] = [
              `[trusted-actions notification] Action ${body.action_id} (${body.type || "unknown"}) → ${body.status}.`,
            ];
            if (body.result) {
              lines.push(`result: ${JSON.stringify(body.result).slice(0, 800)}`);
            }
            if (body.error) lines.push(`error: ${body.error}`);
            // role="user" with an explicit prefix. "system" can't be used
            // mid-history (vLLM and others require system messages to be
            // consecutive at the start); "tool" needs a tool_call_id we don't
            // have. The bracketed prefix is enough for the agent to recognize
            // it as an automated event.
            saveMessage(runtime.db, body.session_id, {
              role: "user",
              content: lines.join("\n"),
            });
            injected = true;
          } catch (err) {
            console.warn(
              `[trusted-actions callback] could not inject into session ${body.session_id}:`,
              err instanceof Error ? err.message : err,
            );
          }
        } else {
          console.log(
            `[trusted-actions callback] ${body.action_id} → ${body.status} (session ${body.session_id} not persistent — no message injected)`,
          );
        }
      }
      return { status: 200, json: { received: true, injected } };
    },
  };

  return [subscriptions, subscriptionOp, history, callback];
}

/**
 * The agent-facing half: four tools that enqueue and poll approval-gated
 * actions against the executor.
 *
 * These lived in `@tailored-ai/core` until now, which put client code for one
 * executor — including a tool that buys things on Amazon — inside the kernel.
 * The routes moved out for exactly that reason; the tools simply had not
 * followed yet. Core now ships no knowledge of this integration.
 *
 * Same gate as before: the factory returns `[]` unless the executor is
 * configured, so an install without one sees no tools, exactly as when core
 * held the registration. And because the CLI already auto-loads this plugin
 * whenever `trustedActions.enabled` is set, no deployment needs a config edit
 * for the tools to keep appearing.
 *
 * Config is read at construction rather than per call, matching what core did.
 * The routes next door read it live because they outlive a reload; a tool set
 * is rebuilt on reload anyway.
 */
export function buildTrustedActionsTools(config: {
  trustedActions?: { enabled?: boolean; url?: string; sharedSecret?: string; callbackBaseUrl?: string };
  server?: { port?: number };
}): Array<RequestActionTool | PurchaseItemTool | RequestReadTool | CheckActionStatusTool> {
  const ta = config.trustedActions;
  if (!ta?.enabled || !ta.url || !ta.sharedSecret) return [];
  const taiBase = ta.callbackBaseUrl ?? `http://host.docker.internal:${config.server?.port ?? 3000}`;
  const opts = {
    url: ta.url,
    sharedSecret: ta.sharedSecret,
    callbackUrl: `${taiBase.replace(/\/$/, "")}${BASE}/callback`,
  };
  return [
    new RequestActionTool(opts),
    new PurchaseItemTool(opts),
    new RequestReadTool(opts),
    new CheckActionStatusTool(opts),
  ];
}

/**
 * Plugin entry. Registers the trusted-actions HTTP routes through the seam.
 * No-op without a runtime (the routes need live config + the session DB).
 *
 * Returns a disposer that deregisters the routes. The runtime re-loads
 * runtime-context plugins on every reload (after disposing the prior ones), so
 * deregistering on teardown keeps the routes re-registerable instead of
 * throwing a "already registered" collision on the second load.
 */
const plugin: Plugin = (ctx: PluginContext) => {
  if (!ctx.runtime) return;
  const disposers = buildTrustedActionsRoutes(ctx.runtime).map((route) => ctx.http.register(route));
  disposers.push(ctx.tools.register("trusted_actions", buildTrustedActionsTools));
  return () => {
    for (const dispose of disposers) dispose();
  };
};

export default plugin;
