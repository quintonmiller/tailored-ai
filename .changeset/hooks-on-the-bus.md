---
"@tailored-ai/core": patch
---

Config-declared hooks reach the whole bus, not two fixed points.

`hooks.beforeRun` and `hooks.afterRun` see the start and end of a turn.
Everything else — a tool about to run, a room turn ending, a schedule firing —
took writing a plugin, which is a different job with a different audience. A
deployment that wanted "check this before my coder runs `exec`" had to ship
TypeScript.

`hooks.on` binds the same kind of hook to any runtime event:

```yaml
agents:
  coder:
    hooks:
      on:
        agent.pre_tool_use:
          - when: { tool: exec }
            tool: policy_check
            denyIf: "BLOCK"
```

The event names are **TAI's own** — `RuntimeEventMap` and
`RuntimeWaterfallMap`, the same catalog plugins subscribe to. That is the whole
reason to build it this way rather than adopting someone else's schema: a typo
becomes a `validateConfig` warning naming the near miss, instead of a hook that
parses, validates and never fires. A compile-time assertion keeps the runtime
list and the type map from drifting, and caught five missing events the moment
it was added.

Three decisions worth knowing. `denyIf` refuses on events that *can* be refused
and is a warning on ones that cannot, so it never looks like a control it is
not. A policy hook that errors refuses by default — a check that could not run
has not passed, and the refusal names the hook and the error rather than being a
mystery. And `when` matches exactly unless wrapped in slashes, because these
gate tool execution and an unanchored pattern quietly matching a neighbouring
tool name is the wrong kind of surprise.

A hook is still a call to a registered tool with the runtime's context. It
cannot spawn a process: that hands config arbitrary code execution with the
agent's privileges, which is a deliberate decision rather than a side effect of
adding a handler type.

Delivered by `builtin:config-hooks`, enabled by default and free when unused —
it subscribes only to events some agent actually names. Existing `beforeRun` /
`afterRun` blocks are untouched, and cron job hooks keep the turn-only shape
since a scheduled run has no business opening a subscription.
