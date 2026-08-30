---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

TAI can run itself as a service, and hook the moments it starts and stops.

`tai` only ran in the foreground, so anything that had to survive a closed
terminal needed a supervisor written per deployment. `tai start` / `stop` /
`restart` / `status` now do that, with pid and log files under the home
directory — so `TAI_HOME` (or `-c`) selects the instance and no registry of
instances exists anywhere.

**Four lifecycle events, declared in the existing `hooks.on`:**

```yaml
hooks:
  allowScripts: true
  on:
    tai:init:start:                     # config read, nothing built yet
      - type: script
        options: { command: ~/bin/pre-start.sh }
    tai:shutdown:end:                   # teardown done, before exit
      - type: script
        options: { command: ~/bin/post-stop.sh }
```

They fire **inside** the TAI process. That is the thing an earlier design got
wrong: "before start" is before the *runtime*, not before TAI, and treating the
two as the same led to a proposal for a separate mechanism in the supervising
CLI. It would have cost something concrete — a shutdown hook in its own
short-lived process cannot call a tool, where `tai:shutdown:start` fires with
the runtime still up and can.

**Capability tiers, because what a hook can do depends on when it runs.**
`tai:init:start` and `tai:shutdown:end` have no runtime, so no tool is
registered. A handler declares what it needs and an event declares what it
offers:

```ts
registerEventHookHandler("tool", handler, { requires: "runtime" });
```

Not a closed union of action types: handler kinds stay an open string so a
plugin can register its own, and core still never learns their names. Without
this a `tool` hook at `tai:init:start` would bind cleanly and never run —
`runEventHooks` treats an unregistered kind as *absent, not failed* — which is
the exact silent-inert shape this codebase keeps paying for. It is now a
`validateConfig` warning and a refusal at dispatch.

**A `script` handler in core**, registered only when `hooks.allowScripts` is
true. It has to be core rather than a plugin because `tai:init:start` fires
before plugins load; it has to be gated because it hands config the ability to
run arbitrary programs, and "do not enable the plugin" cannot gate something
that must exist before plugins. It passes the payload as environment and never
opens stdin — writing to a child that exits without reading is #606.

Only `tai:init:start` can refuse, and a refusal aborts the start. The shutdown
events cannot: a hook able to veto a stop makes an instance unstoppable, which
is worse than whatever it was protecting.

Both shutdown events carry `reason` (`stop` or `restart`), reaching a script as
`TAI_REASON`. Without it `tai restart` releases whatever `tai:shutdown:end`
releases and immediately re-acquires it — measured cycling a 27B model server on
every restart, which is the most common operation there is.
