---
"@tailored-ai/core": patch
"@tailored-ai/trusted-actions": patch
---

The trusted-actions tools move to the package that owns the executor.

`@tailored-ai/trusted-actions` already extracted its HTTP routes out of
`@tailored-ai/server`, and its plugin entry says why: they are "product-specific
(Amazon / executor pass-throughs) and belong with the package that owns the
executor". The tools never followed.

So core kept shipping 340 lines of client code for one executor — including a
`purchase_item` tool that buys things on Amazon — which `CLAUDE.md` puts outside
the kernel: "a feature that serves one use case does not belong here, even a
popular one". `request_action`, `purchase_item`, `request_read` and
`check_action_status` now register from the same plugin entry as the routes,
through `ctx.tools` beside `ctx.http`.

**Nothing to change in any config.** The CLI already auto-loads
`@tailored-ai/trusted-actions/plugin` whenever `trustedActions.enabled` is set,
without requiring a `plugins:` entry, so the tools appear exactly when they did
before. The gate is preserved exactly: no tools unless `enabled`, `url` and
`sharedSecret` are all present — an install that never configured an executor
sees no change at all.

One small improvement falls out. The callback URL the executor posts results to
was assembled in core from a string literal that had to match the route path by
hand; both now derive from the same `BASE` constant in one file. A mismatch
there means actions complete and the agent is never told, with nothing failing
loudly, so removing the second copy is worth more than it looks.

Core's `AgentConfig` still carries the `trustedActions` block, because the
routes read it live too. Making it a plugin-opaque options bag is the remaining
half and is tracked separately.
