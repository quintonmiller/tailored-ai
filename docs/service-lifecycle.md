# Running TAI as a service, and hooking its lifecycle

`tai` used to run only in the foreground. Anything that had to survive a closed
terminal needed a supervisor, and every deployment wrote its own.

```
tai start   [-c <config>]   Start in the background, wait until ready
tai stop    [-c <config>]   Stop, waiting for a clean exit
tai restart [-c <config>]
tai status  [-c <config>]   Running, and answering?
```

Pid and log files live under the home directory:

```
<home>/run/agent.pid
<home>/logs/agent.log
```

So **`TAI_HOME` (or `-c`) is the instance**, and there is no registry of
instances to keep in step with reality. Pid liveness is the only truth: a
crashed process releases its slot with nothing stale to clean up, and a pid file
whose process is gone is treated as absent rather than as a lock.

`start` waits for **ready**, not for *spawned* — it polls `/api/health` and
watches the child, so a start that dies during boot reports a failure with the
tail of the log rather than a pid and a lie.

## The four lifecycle events

They are ordinary hooks, declared in the deployment's `hooks.on`. What makes
them their own thing is that two of them fire when the runtime does not exist.

| event | fires | runtime | a hook here can be |
|---|---|---|---|
| `tai:init:start` | config read, nothing built | no | a script |
| `tai:init:end` | channels connected, a turn can run | yes | a script or a tool |
| `tai:shutdown:start` | teardown begins | yes | a script or a tool |
| `tai:shutdown:end` | teardown done, before exit | no | a script |

**A lifecycle hook runs inside the TAI process.** `tai:init:start` is not
"before TAI" in any sense a hook could care about: the process is up, config has
been read, and only the runtime is missing. An earlier design took the phrase
literally, concluded the phase was unbuildable, and proposed a separate
mechanism in the supervising CLI — which would have cost something real, because
a shutdown hook in its own short-lived process cannot call a tool.

Only `tai:init:start` can refuse, and a refusal aborts the start:

- **Refusing a start is most of the value.** "The thing this deployment needs is
  not there, do not come up." A TAI that starts anyway looks healthy and fails on
  its first turn with an error pointing somewhere other than the cause.
- **The shutdown events cannot refuse.** A hook able to veto a stop makes an
  instance unstoppable, which is worse than whatever it was protecting.
- **`tai:init:end` cannot refuse** because the runtime is already serving.
  Refusing there would be a stop wearing a refusal's clothes.

## Capability tiers

What a hook can do depends on when it runs, so a handler declares what it needs
and an event declares what it offers.

```ts
registerEventHookHandler("tool", handler, { requires: "runtime" });
registerScriptHookHandler(); //  requires: "process"
```

`process` means a running process and the config; `runtime` means the database,
tool registry and event bus are up. `process` is satisfied by any phase;
`runtime` only by a phase that has one.

This is deliberately **not** a closed union of action types. Handler kinds are an
open string so a plugin can register its own and core never learns their names —
a plugin declares its tier and the check stays structural.

Without it, a `tool` hook on `tai:init:start` would bind cleanly and never run.
`runEventHooks` treats an unregistered handler kind as *absent, not failed*: it
logs and continues. That is the silent-inert shape this codebase keeps paying
for, so it is caught twice — a `validateConfig` warning naming the fix, and a
refusal at dispatch naming what is usable instead.

## The `script` handler

```yaml
hooks:
  allowScripts: true
  on:
    tai:init:start:
      - type: script
        options:
          command: ~/bin/pre-start.sh
          args: ["--verbose"]     # optional
          timeoutMs: 300000       # optional, default 120000
```

- **Exit 0 passes; any other exit is a refusal**, with stderr as the reason.
- **The payload arrives as environment**, never on stdin. `TAI_HOOK_EVENT` names
  the event; other payload keys become `TAI_UPPER_SNAKE`. Absent values are
  omitted rather than becoming the string `"null"`, which reads as a value and
  is how a shell script takes the wrong branch. Nothing is written to the
  child's stdin, so a program that ignores its input cannot raise an unhandled
  `EPIPE` from inside the runtime ([#606]).
- **A program that cannot be run is reported as absent, not as a refusal.** A
  typo in a path must not block the thing the hook was meant to guard.

### Why it is in core, and why it is off by default

It has to be **core** because `tai:init:start` fires before plugins load, and a
handler that arrives after its event is a hook that silently never ran.

It has to be **gated** because a registered `script` kind hands *config* the
ability to run arbitrary programs with the agent's privileges. Every other hook
can only reach a tool the deployment already registered and enabled — a real
boundary, and one this removes. `builtin:claude-hooks` gates its own `command`
handler by shipping `enabled: false`, but that cannot work here: "do not enable
the plugin" cannot gate something that must exist before plugins.

So the gate is `hooks.allowScripts`, off by default. With it off, nothing
registers the kind and a `script` hook reports the ordinary "no handler"
message — absent, and visible.

## Worked example: a shared model server

The case this was built for. The model server has to be up before TAI needs it,
and the GPU should come back when TAI goes away.

```yaml
hooks:
  allowScripts: true
  on:
    tai:init:start:
      - type: script
        options: { command: ~/bin/model-server-up.sh }
    tai:shutdown:end:
      - type: script
        options: { command: ~/bin/model-server-down.sh }
```

`model-server-up.sh` starts the server and blocks until it answers, exiting
non-zero if it does not — which aborts the start. `model-server-down.sh` stops
it, and should check the *device* rather than the stop command's return value:
"stopped" is a claim about bookkeeping, and the two come apart.

What the scripts do stays in the deployment's own repo. Core learns that a hook
exists, never what it runs.

## Related

- [`agents-and-hooks.md`](./agents-and-hooks.md) — the rest of the hook surface,
  and whose hook is whose.
- [#603] — in-process `runtime.started` / `runtime.stopping` bus events, for
  plugins that want to observe these moments rather than act at them.

[#603]: https://github.com/quintonmiller/tailored-ai/issues/603
[#606]: https://github.com/quintonmiller/tailored-ai/issues/606
