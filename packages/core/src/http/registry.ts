/**
 * HTTP route seam — lets plugins mount HTTP routes on the TAI server without
 * coupling core to a web framework. Core owns a framework-agnostic
 * {@link HttpRouteRegistry} of route descriptors; the server (Hono today)
 * iterates the registry after building its app and adapts each descriptor onto
 * its own router. Core never imports Hono; the dependency direction stays
 * server → core.
 *
 * A plugin registers routes through `ctx.http` (see plugin-context.ts):
 *
 *     ctx.http.register({ method: "GET", path: "subscriptions", handler });
 *     ctx.http.mount("billing", [{ method: "GET", path: "plans", handler }]);
 *
 * Both forms namespace under `/api/ext/<prefix>/…` so a plugin can never shadow
 * a core route. `register` without a prefix mounts under `/api/ext/`. The
 * `mount(prefix, routes)` form prepends `<prefix>/` to each route's path.
 *
 * The escape hatch — `absolute: true` — opts a descriptor out of the namespace
 * and mounts it at the verbatim `path` (which must start with `/`). It exists
 * for first-party packages that must preserve a legacy path the UI or an
 * external service already calls (the trusted-actions migration uses it to keep
 * `/api/trusted-actions/*` working). Treat it as a deliberate, reviewed
 * exception, not a default.
 */

/** Namespace prefix every non-absolute plugin route mounts under. */
export const HTTP_ROUTE_NAMESPACE = "/api/ext";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/**
 * Framework-agnostic request handed to a plugin route handler. Intentionally
 * minimal — enough to read params/query/headers/body and not a re-creation of
 * Express's `req`. The server adapter populates it from its native request.
 */
export interface TaiHttpRequest {
  method: string;
  /** Resolved path the route was matched at (the full mounted path). */
  path: string;
  /** Path parameters parsed from `:name` segments in the descriptor path. */
  params: Record<string, string>;
  /** Query-string parameters (last value wins for repeated keys). */
  query: Record<string, string>;
  /** Request headers, lowercased keys. */
  headers: Record<string, string>;
  /** Parse the body as JSON. Rejects/throws on invalid JSON. */
  json<T = unknown>(): Promise<T>;
  /** Read the body as text. */
  text(): Promise<string>;
}

/**
 * Framework-agnostic response a handler returns. The server adapter maps it
 * onto its native response. Exactly one body shape should be set; when `json`
 * is present it wins and a `Content-Type: application/json` header is implied.
 */
export interface TaiHttpResponse {
  /** HTTP status. Defaults to 200 when omitted. */
  status?: number;
  /** Response headers. Lowercased or canonical keys both work. */
  headers?: Record<string, string>;
  /** JSON body — serialized by the adapter. Mutually exclusive with `body`. */
  json?: unknown;
  /** Raw text/string body. Mutually exclusive with `json`. */
  body?: string;
}

export type HttpRouteHandler = (req: TaiHttpRequest) => Promise<TaiHttpResponse> | TaiHttpResponse;

/**
 * One registered route. `path` is relative to the namespace unless
 * `absolute` is set, in which case it is the verbatim mount path.
 */
export interface HttpRouteDescriptor {
  method: HttpMethod;
  /**
   * Route path. For namespaced routes this is appended to
   * `/api/ext/<prefix>/`; leading/trailing slashes are normalized away. For
   * `absolute` routes this is used verbatim and must start with `/`.
   * Supports Hono-style `:param` segments.
   */
  path: string;
  handler: HttpRouteHandler;
  /**
   * Auth mode. `"token"` (default) means the route sits behind the server's
   * `server.authToken` bearer check like every other `/api/*` route.
   * `"none"` exempts it — the handler is responsible for its own auth (e.g. a
   * webhook/callback that authenticates with its own shared secret). Use
   * `"none"` only for routes called by non-browser services.
   */
  auth?: "token" | "none";
  /**
   * Opt out of the `/api/ext/<prefix>/` namespace and mount at the verbatim
   * `path`. Reserved for first-party packages preserving a legacy path. When
   * set, `path` must start with `/`.
   */
  absolute?: boolean;
}

/**
 * A fully-resolved route ready for the server adapter: the descriptor plus the
 * final mount path the server should register it at.
 */
export interface ResolvedHttpRoute extends HttpRouteDescriptor {
  /** Final mount path (namespace-resolved or verbatim absolute). */
  mountPath: string;
}

/** Normalize a path fragment: strip leading/trailing slashes. */
function trimSlashes(p: string): string {
  return p.replace(/^\/+|\/+$/g, "");
}

/**
 * Runtime-owned registry of plugin HTTP routes. Lives on the runtime and
 * deliberately survives `reload()` — web routers (Hono) can't unmount routes
 * once added, so the registry tracks the desired set and route handlers read
 * live runtime state on each request. The server iterates {@link list} once
 * after building its app.
 */
export class HttpRouteRegistry {
  private routes: ResolvedHttpRoute[] = [];

  /**
   * Register a single route. `prefix` (when given) namespaces it under
   * `/api/ext/<prefix>/`; absolute routes ignore the prefix and namespace.
   * Throws on a duplicate `method + mountPath` so two plugins can't silently
   * fight over the same path.
   *
   * Returns the resolved mount path so callers (e.g. a plugin disposer) can
   * {@link deregister} the route on teardown — the runtime disposes and
   * re-loads runtime-context plugins on every reload, so a plugin that
   * registers routes should deregister them in its disposer to stay
   * re-registerable.
   */
  register(descriptor: HttpRouteDescriptor, prefix?: string): string {
    const mountPath = this.resolveMountPath(descriptor, prefix);
    const clash = this.routes.find((r) => r.method === descriptor.method && r.mountPath === mountPath);
    if (clash) {
      throw new Error(`HTTP route already registered: ${descriptor.method} ${mountPath}`);
    }
    this.routes.push({ ...descriptor, mountPath });
    return mountPath;
  }

  /**
   * Remove a previously-registered route by method + resolved mount path.
   * Returns true when a route was removed. Note: the server (Hono) can't
   * unmount routes already adapted onto its router, so deregistering after
   * the server has started only affects the registry's bookkeeping (and the
   * auth-exempt set, which is computed once at server build). Its real use is
   * keeping the registry clean across the reload dispose/reload cycle.
   */
  deregister(method: HttpMethod, mountPath: string): boolean {
    const before = this.routes.length;
    this.routes = this.routes.filter((r) => !(r.method === method && r.mountPath === mountPath));
    return this.routes.length < before;
  }

  /**
   * Mount a batch of routes under a shared `prefix`. Equivalent to calling
   * {@link register} for each with the same prefix. Returns the resolved
   * mount paths in input order.
   */
  mount(prefix: string, routes: HttpRouteDescriptor[]): string[] {
    return routes.map((r) => this.register(r, prefix));
  }

  /** All resolved routes, in registration order. */
  list(): readonly ResolvedHttpRoute[] {
    return this.routes;
  }

  /** Clear all routes. Used by tests; the runtime never clears in production. */
  clear(): void {
    this.routes = [];
  }

  private resolveMountPath(descriptor: HttpRouteDescriptor, prefix?: string): string {
    if (descriptor.absolute) {
      if (!descriptor.path.startsWith("/")) {
        throw new Error(`absolute HTTP route path must start with "/": got "${descriptor.path}"`);
      }
      return descriptor.path;
    }
    const segments = [HTTP_ROUTE_NAMESPACE];
    if (prefix) {
      const cleanPrefix = trimSlashes(prefix);
      if (!cleanPrefix) throw new Error("HTTP route prefix must be non-empty");
      segments.push(cleanPrefix);
    }
    const cleanPath = trimSlashes(descriptor.path);
    if (cleanPath) segments.push(cleanPath);
    return segments.join("/");
  }
}

/**
 * Registry view exposed to plugins via `ctx.http`. Mirrors the registry's
 * `register`/`mount` but bakes a `prefix` into both so a plugin's routes are
 * confined to its own namespace. A plugin gets its prefix from the host (the
 * loader passes the plugin module's id); when none is available the routes
 * land directly under `/api/ext/`.
 */
export interface HttpRegistryView {
  /**
   * Register one route under this plugin's namespace. Returns a disposer that
   * deregisters the route — call it from your plugin's disposer so the route
   * doesn't collide when the runtime re-loads the plugin on reload.
   */
  register(descriptor: HttpRouteDescriptor): () => void;
  /**
   * Mount a batch of routes under `<plugin-namespace>/<prefix>/`. Returns a
   * single disposer that deregisters all of them.
   */
  mount(prefix: string, routes: HttpRouteDescriptor[]): () => void;
}

/**
 * Build the `ctx.http` view for a plugin. `defaultPrefix` namespaces bare
 * `register` calls (typically the plugin's id). `mount(prefix, …)` nests under
 * `<defaultPrefix>/<prefix>/` when a default prefix is present, else under
 * `<prefix>/`.
 */
export function createHttpRegistryView(registry: HttpRouteRegistry, defaultPrefix?: string): HttpRegistryView {
  const joinPrefix = (a: string | undefined, b: string | undefined): string | undefined => {
    const parts = [a, b].map((s) => (s ? trimSlashes(s) : "")).filter(Boolean);
    return parts.length > 0 ? parts.join("/") : undefined;
  };
  return {
    register(descriptor: HttpRouteDescriptor): () => void {
      const mountPath = registry.register(descriptor, defaultPrefix);
      return () => registry.deregister(descriptor.method, mountPath);
    },
    mount(prefix: string, routes: HttpRouteDescriptor[]): () => void {
      const resolved = joinPrefix(defaultPrefix, prefix) ?? prefix;
      const mountPaths = registry.mount(resolved, routes);
      return () => {
        for (let i = 0; i < routes.length; i++) {
          registry.deregister(routes[i].method, mountPaths[i]);
        }
      };
    },
  };
}
