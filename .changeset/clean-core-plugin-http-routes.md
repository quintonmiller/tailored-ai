---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/trusted-actions": patch
---

Plugin-mounted HTTP routes; move trusted-actions endpoints out of the core
server (#206).

Plugins can now mount HTTP routes on the TAI server through a framework-agnostic
seam. Core owns a runtime `HttpRouteRegistry` of descriptors
(`{ method, path, handler, auth?, absolute? }`) where the handler takes a simple
`TaiHttpRequest` and returns a `TaiHttpResponse` — core never imports Hono.
Plugins register via `ctx.http.register(...)` / `ctx.http.mount(prefix, ...)`,
namespaced under `/api/ext/<plugin-id>/…` so they can't shadow core routes. An
opt-in `absolute: true` escape hatch mounts a verbatim path for first-party
packages preserving a legacy path; `auth: "none"` exempts a route from the
server bearer check for service-called webhooks. The server iterates the
registry after building its Hono app (`mountPluginHttpRoutes`) inside the
existing `server.authToken` middleware; routes register at startup and survive
reload (the registry persists; handlers read live runtime state).

The Amazon-specific `/api/trusted-actions/*` endpoints (executor pass-throughs +
the executor → TAI callback) move out of `@tailored-ai/server` into
`@tailored-ai/trusted-actions` (`./plugin` subpath), registered through the new
seam — the dogfood for the contract. They keep their historical paths via
`absolute: true`, so the UI keeps working; the callback keeps its exact
shared-secret auth via `auth: "none"`. The CLI auto-loads the route plugin as a
runtime-context plugin when `trustedActions.enabled`, with the package as an
`optionalDependencies`.

No behavior change for existing deployments: the same endpoints respond at the
same paths with unchanged auth.
