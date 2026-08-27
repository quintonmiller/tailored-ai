# Architecture

Deep notes on the runtime, factories, and how to add new tools/channels/providers. Top-level overview lives in [CLAUDE.md](../CLAUDE.md).

## AgentRuntime

`packages/core/src/runtime.ts` holds all mutable state (config, tools, model provider, time provider) and provides getters that return the current values. Key behaviors:

- **`reload()`** — re-reads `config.yaml`, rebuilds tools, model provider, and time provider. All-or-nothing: keeps previous state on failure. It can fire **mid-turn**: `updateRawConfig` reloads after every config write, so the `admin` tool lets an agent rebuild its own provider between rounds, and an external edit to `config.yaml` does the same via the watcher. Anything holding per-turn or per-run state on a rebuilt collaborator loses it — see [defensive-patterns.md](./defensive-patterns.md#a-reload-can-rebuild-a-collaborator-in-the-middle-of-a-turn).
- **`startWatching()`** — uses `fs.watch` with 500ms debounce to auto-reload on config file changes.
- **`resolveHooks({ agentName?, overrideHooks? })`** — resolves merged hooks for an agent + optional overrides (e.g. cron job hooks).
- **`generation`** — monotonic counter that increments on each successful reload.
- Factory functions (`createTools`, `createProvider`) are defined in `packages/core/src/factories.ts` and injected into the runtime.
- The agent loop accepts optional `getTools`/`getProvider` closures to re-resolve per iteration. Tool-change detection injects a transient system message when the tool set changes mid-loop.
- All subsystems (server, discord, cron, delegate) hold a runtime reference and read state at request time.

### Time provider

`runtime.getTimeProvider()` owns the current instant and the IANA timezone used
for civil-time calculations. Resolution order is `time.timezone`, the selected
provider's `timeZone()`, then the host timezone. The built-in `system` provider
returns the real clock. Plugins register alternative clocks through
`ctx.timeProviders.register(id, factory)` and users select one with
`time.provider`; the provider can read its opaque `time.options` config.

Absolute instants remain UTC in SQLite and comparisons. The provider boundary
is for current-time injection, timezone-aware calendar math, timers, quiet-hour
windows, and rendered prompt timestamps. It is resolved before tools on startup
and reload so every consumer sees one coherent clock generation.

## The global pause switch

`/pause` in Discord stops agents starting new runs on their own, without stopping TAI. `/resume` lifts it.

It exists because every other off switch is the wrong shape. Killing the process loses in-flight work. Editing config calls `reload()`, and `ChannelLifecycleManager` restarts a transport whose config block changed — so pausing from Discord would drop the Discord gateway you just used to ask for it. `autopilot pause` covers one of six subsystems that can start a run.

### What it blocks, and what it deliberately does not

`/pause` blocks **autonomous** runs: anything nothing living asked for.

| Gate | Site |
|---|---|
| All workflow-driven runs — cron, webhooks, all eight trigger pollers (email, calendar, RSS, weather, sensor, finance, geofence, file-drop) | `workflows/engine.ts` `runWorkflow`, by `trigger` |
| Webhook routes with `action: agent` (these reach the loop *without* the workflow engine) | `packages/server/src/index.ts`, webhook route |
| Cron timer firings | `cron/scheduler.ts` `runScheduled` |
| Autopilot ticks and the stuck-task re-dispatch scan | `autopilot/worker.ts` `runTick`, `scanStuckTasks` |
| Exploratory ticks | `exploratory/worker.ts` `tick` |
| Stall retries (`task.dispatch_requested`) and the tasks tool handing work to another agent | `task-watcher.ts` `handleDispatchRequest`, `notifyById` |
| Room check-ins, and wakes caused only by other agents | `rooms/watcher.ts` `runCheckIn`, `pollOnce`, `runWake` |
| One agent starting a loop in another | `runtime.ts` `deliverAgentMessage` |

It deliberately leaves **human-initiated** runs working: `POST /api/chat`, `POST /api/command`, Discord DMs and slash commands, Slack, the CLI, cron "Run now", `/room status`, the exploratory manual-run route, `runWorkflow` with trigger `http` or `tool`, and an agent answering *you* in a room.

That split is the whole design. A pause that also kills your own messages is indistinguishable from an outage, and it takes away the instruments you would use to find out what went wrong — `/memory`, `/room status`, asking an agent what it just did. `/pause scope:all` blocks the human paths too; each of them then says it is paused rather than going quiet, for the same reason.

**In-flight runs finish.** The gates refuse new runs only. Aborting a half-finished tool call turns an expensive mistake into an expensive mistake plus an inconsistent worktree. A `trigger_workflow` child passes `continuation: true` so a pause cannot cut a running parent in half.

### Reading and writing it

State is the `runtime_settings` singleton table (`agents_paused`, `pause_scope`, `paused_at`, `paused_by`) — the same shape as `autopilot_settings`, and in SQLite for the reload reason above.

- `runtime.isAgentsPaused("autonomous" | "human")` — read live on **every** check. Never cache it; a cached copy means the pause does not land until something reloads, which is the one failure this feature cannot have.
- `runtime.getPauseState()` — the full row, for surfaces that report *why* rather than just refuse.
- `runtime.setAgentsPaused({ paused, scope?, by? })` — writes and, on a real change, emits `agents.pause_changed` on the runtime bus.

Adding an autonomous entry point? Gate it. The two that are easy to miss are paths that reach `runAgentLoop` without passing through `runWorkflow` (the webhook `action: agent` route) and paths where one agent starts another (`deliverAgentMessage`). See also [rooms](./rooms.md#runaway-protection) and [tasks & autopilot](./tasks-and-autopilot.md#autopilot).

## Factories (`packages/core/src/factories.ts`)

Composition layer that constructs tools, providers, and meta tools:

- **`createTools(config, contextDir, configPath?, opts?)`** — walks the tool-factory registry and aggregates every tool each factory produces. Both built-in and plugin tools go through the same path. Accepts optional `CreateToolsOptions` with `db`, `resolveOutbound`/`getOwnerId` closures, task backend / resolver, embedding provider, and event bus — all passed as `ToolFactoryContext` to each factory.
- **`createProvider(config)`** — creates the AI provider + model from config.
- **`createMetaTools(runtime, contextDir, kbDir)`** — creates delegate, task_status, admin, run_workflow, resource_admin, load_skill, and core_memory tools.

## Adding a New Tool

All tools — built-in and plugin — register through the tool-factory registry. `createTools()` is a pure registry walk with no if-chains.

**Code-level tool** (requires TypeScript):
1. Create `packages/core/src/tools/<name>.ts` implementing the `Tool` interface from `packages/core/src/tools/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.tools` if needed
3. Register in `packages/core/src/tools/builtin.ts` (built-in) or in your plugin module (external):
   ```ts
   registerToolFactory("my_tool", (config, ctx) => {
     if (!config.tools.my_tool?.enabled) return [];
     return [new MyTool(config.tools.my_tool, ctx.db)];
   });
   ```
4. Add the module import to `factories.ts` (built-ins) or ensure your plugin imports the file as a side effect
5. Export from `packages/core/src/index.ts`

**Plugin tool** (external package):
Call `registerToolFactory(id, factory)` from `@tailored-ai/core` on module import. The factory receives the full `AgentConfig` and `ToolFactoryContext` (db, contextDir, resolveOutbound, etc.). Return `[]` to opt out when disabled or unconfigured.

**Custom tool** (config-only, no code):
Add an entry under `custom_tools` in `config.yaml`. Custom tools are shell command templates with `{{param}}` interpolation. They are rebuilt on every runtime reload, so adding one via the admin tool or editing `config.yaml` makes it available immediately.

```yaml
custom_tools:
  hello:
    description: "Say hello to someone"
    parameters:
      name: { type: "string", description: "Name to greet" }
    command: "echo Hello {{name}}"
    timeout_ms: 5000  # optional, default 30s
```

## Adding a New Channel

1. Create `packages/core/src/channels/<name>.ts` implementing `Channel` from `packages/core/src/channels/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.channels`
3. Wire it up in `packages/cli/src/index.ts` in the `runServe()` function
4. Export from `packages/core/src/index.ts`
5. Sessions are keyed per-user: use `findOrCreateSession(db, "channelname:userId", model, provider)`

## Adding a New Provider

1. Create `packages/core/src/providers/<name>.ts` implementing `AIProvider` from `packages/core/src/providers/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.providers`
3. Add provider creation in `packages/core/src/factories.ts` in the `createProvider()` function
4. Export from `packages/core/src/index.ts`

### Learning a model's request-shape quirks

Vendors reject request shapes per model, in ways no version rule predicts:
`gpt-5.3-chat-latest` takes only `medium` reasoning effort while `gpt-5.2` takes
anything, and newer Claude models 400 on any `temperature` at all. The API tells
you, so the shape is: send, read the refusal, correct, remember for the process.

`packages/core/src/providers/quirks.ts` holds the parts that generalise:

- `runQuirkLadder({ initial, key, attempt, recover })` — retries with corrected
  shapes until one is accepted. Termination is structural: a shape whose `key`
  has already been tried is never tried again, so the loop is bounded by the
  number of distinct shapes rather than by a counter or by trusting error text.
- `QuirkMemo` — per-model learned facts, created on first touch.
- `WarnOnce` — say it once per (model, quirk). Silently degrading a request the
  caller asked for is the failure these recoveries exist to avoid, but the
  correction repeats on every call.
- `ProviderHttpError` — carries status and body to `recover`, so recognition
  never re-parses a message the provider formatted itself.

`recover` returning `undefined` rethrows untouched, and that is the right
default: retrying an unrelated failure with a different body turns one clear
error into two confusing ones. Recognition itself stays in the provider — which
400s are recoverable and what the fix is, is vendor knowledge that does not
generalise.

## Adding a UI Provider

The server mounts a UI via the registry in `packages/core/src/ui/registry.ts`. The CLI ships the bundled web dashboard as the `"builtin"` provider; plugins register additional providers at import time.

1. Implement a `UiProviderFactory` that returns a `UiProvider` — `{ id, staticDir?, mount? }`. Use `staticDir` to point at a pre-built bundle (server mounts it at `/*` with SPA fallback); use `mount(app)` to register custom Hono routes (runs before the static fallback so plugin routes win over the SPA index).
2. Register at module import: `registerUiProviderFactory("my-ui", (runtime, slice) => ...)`. `slice` is the matching `server.ui.my-ui` block from config.
3. Tell users to set `server.ui.provider: my-ui` in their `config.yaml`. The kill-switch `server.ui.enabled: false` skips UI entirely.

## Registration disposers

Every `register` in core returns a `Disposer` — the inverse of the registration
it just made. That holds for `Registry<T>` (which all ten factory registries are
built on), `StepExecutorRegistry.registerFactory`, the slash-command registry,
the HTTP route view, and every `PluginContext` namespace.

```ts
const dispose = ctx.tools.register("echo", () => [echoTool]);
// …later
dispose();   // the factory is gone; nothing else moved
```

Two properties are load-bearing:

- **It removes only the entry that call made.** If something re-registered the
  same id afterwards, that entry belongs to whoever registered it. A disposer
  that deleted it would silently break a live registration it never owned —
  invisible until something that should work stops working.
- **It is idempotent.** Calling it twice is a no-op, so composing disposers
  never needs a guard at the call site.

**Plugins get this for free.** `loadPlugins` passes a per-entry collector into
the context, so every registration a plugin makes through `ctx` is captured and
composed onto `LoadedPlugin.stop` along with whatever the plugin's own
`register(ctx)` returned. Unloading a plugin is then the inverse of loading it,
without the plugin author writing an uninstall path. The plugin's own disposer
runs first — it may still need what it registered while shutting down — and the
registrations come out last-in-first-out.

Ignoring the return value is fine and changes nothing; the contract is there for
whoever owns a lifecycle.

Two limits worth knowing. **Side-effect plugins are not covered**: they call the
module-scope `register*` functions at import time with no context, so nothing
observes what they added. And `reload()` still clears the event bus wholesale
rather than unwinding per plugin — see [#533](https://github.com/quintonmiller/tailored-ai/issues/533)
for what remains.

## Event dispatch modes

The bus has three modes, and the mode is part of an event's contract rather than
a choice at the call site.

| Mode | Call | A listener can | Declared in |
|---|---|---|---|
| broadcast | `emit` | observe | `RuntimeEventMap` |
| vetoable | `emitAsync` | observe, or return `false` to block | `RuntimeEventMap` |
| waterfall | `waterfall` | observe, transform, or short-circuit | `RuntimeWaterfallMap` |

`emit` is synchronous and fire-and-forget. `emitAsync` awaits subscribers in
registration order and returns `false` if any vetoed — a throwing handler counts
as non-veto, so a broken observability plugin can't accidentally block real work.

**Waterfall** is around-middleware. A listener receives `(payload, next)`:

```ts
bus.onWaterfall("myplugin.outbound", async (msg, next) => {
  return next({ ...msg, text: redact(msg.text) });   // delegate
});
```

Call `next(payload)` to delegate and return its result; return your own value
without calling `next` to short-circuit and own the outcome. A listener that
only annotates **must** delegate. `{ prepend: true }` runs a listener before
ones registered earlier — for a policy that decides whether the rest of the
chain runs at all, not for ordinary use.

Two failure rules, matching the rest of the bus: a **throwing listener is
skipped** and the chain continues with the payload it was handed; a listener
that **returns nothing** is a pass-through, so a forgotten `return` cannot
silently drop every listener after it.

Waterfall events live in a separate map so a waterfall can never be `emit`ed by
accident. `RuntimeWaterfallMap` is extended by declaration merging, in core and
in plugins alike:

```ts
declare module "@tailored-ai/core" {
  interface RuntimeWaterfallMap {
    "myplugin.outbound": { text: string };
  }
}
```

Core declares one: `agent.context_slots`. See [the loop's bus](#the-loops-bus).

### The loop's bus

That was blocked on a plainer problem: `runAgentLoop` had no bus at all. It
neither took one nor read one, which is why the loop kept absorbing features
that belong beside it — `prompt.ts`, `context.ts`, `memory-inject.ts`,
`chat-live-state.ts`, `watcher.ts` and `load-skill.ts` each append their own
block from inside, because there was no way to subscribe to "a request is being
assembled" and hand one back.

`AgentLoopOptions.events` now carries an `EventBus`, filled in by
`runtime.buildLoopOptions()` from `runtime.events`, so every caller that goes
through the runtime gets it without changing. It is **optional**: the benchmark
harness and most tests build loop options by hand, and a loop built without a
runtime should dispatch to nobody rather than refuse to run.

#### `agent.context_slots`

The first thing dispatched on it, and the first core waterfall: the slot list a
turn is about to render.

```ts
bus.onWaterfall("agent.context_slots", async (payload, next) =>
  next({ ...payload, slots: payload.slots.filter((s) => s.id !== "expensive") }),
);
```

The payload carries the turn's `agent`, `sessionId`, `projectId` and
`userMessage` alongside `slots`, so a subscriber can decide per agent or per
message without reaching for anything the loop has not already resolved.

Two properties worth knowing:

- **The list arrives before anything renders**, so a subscriber can stop a slot
  running rather than discard what it produced. A slot that is expensive, or
  that reads something the subscriber knows is unavailable, is better not called.
- **An empty chain returns what it was handed**, so a turn with a bus and no
  subscribers assembles a byte-identical prompt to one with no bus at all. That
  is what makes the seam safe to land ahead of any consumer, and it is asserted
  directly rather than assumed.

`renderContextSlots` was chosen as the first consumer because it is already a
pure function over a slot list: a subscriber needs no knowledge of how the
system prompt is composed, which is the property
[#417](https://github.com/quintonmiller/tailored-ai/issues/417) is after. See
[#548](https://github.com/quintonmiller/tailored-ai/issues/548).

#### `agent.request_assembled`

What the model was actually shown. Broadcast, once per request that reached a
provider.

```ts
bus.on("agent.request_assembled", (r) => {
  if (!r.answered) return; // a rung that failed and moved the chain on
  appendJsonl(`${home}/requests.jsonl`, {
    session: r.sessionId,
    round: r.round,
    phase: r.phase,
    system: r.params.messages[0].content,
    messages: r.params.messages.length,
    of: r.historyLength,
    slots: r.slots,
  });
});
```

`params` is the `ChatParams` object the provider was handed — system prompt, the
messages that survived trimming, tool schemas, sampling, hydrated media. The
other fields are what the loop knows and the request does not: `round` and
`phase`, which rung sent it (`attempt`, `rung`, `answered`), the `historyLength`
the request was trimmed from, and `slots` — what each context slot contributed
and whether its own budget cut it short.

**A faithful copy, not a projection.** It is cheaper to store the loop's state
and rebuild the request later, and it is wrong: `paramsFor` re-trims the history
per fallback rung, so which messages went out depends on which rung answered,
and a reconstruction from session state would confidently produce the head
rung's request instead. Authoritative and wrong is worse than absent. The test
for this asserts object identity rather than deep equality, so a shaping step
inserted after the record fails the build.

Three consequences of that shape:

- **It fires after the request was sent**, in a `finally` around the provider
  call. An observer cannot see a request that did not go out, and cannot change
  one that did — which is why this is `emit` and not a waterfall. A subscriber
  that could rewrite this would make the record a lie.
- **A round can emit more than one.** A chain that falls back emits one record
  per rung it actually called, told apart by `attempt` and `answered`. A rung
  the capability pre-flight skipped never made a request and emits nothing.
- **The toolless final report is `phase: "final_report"`.** It shares a round
  number with the last tool-calling round, and without the field the two are
  distinguishable only by noticing that one carries no tool schemas.

Core emits and stores nothing. Retention, redaction, format and location are
opinions and belong to a subscriber — a table, an `event_journal`, or a JSONL
sidecar are all subscriber choices rather than core commitments. See
[#535](https://github.com/quintonmiller/tailored-ai/issues/535).

#### `agent.pre_tool_use` and `agent.post_tool_use`

Tool-level dispatch: policy on any tool, without the policy knowing the tool or
the tool knowing the policy.

```ts
bus.onWaterfall("agent.pre_tool_use", (p, next) => {
  if (p.tool !== "exec") return next(p);
  const cmd = String(p.args.command ?? "");
  if (cmd.includes("--force")) {
    // Not a refusal — a correction.
    return next({ ...p, args: { ...p.args, command: cmd.replace("--force", "") } });
  }
  return next(p);
});
```

`pre_tool_use` is a **waterfall**, because refusing is the weaker of the two
useful answers. A subscriber may set `deny` (the text goes back to the model in
place of the tool's output) or replace `args` — the difference between a guard
that says no and one that says "not like that". The tool name itself is
deliberately not replaceable: swapping it would leave the model's own record of
what it called wrong.

Two placement decisions inside `executeToolCall`, both easy to get wrong:

- **Before the approval gate.** A rewrite has to reach the human who approves
  it, or they approve one call and a different one runs. Asserted directly.
- **Before validation.** So whatever actually executes is what got validated,
  original or rewritten. A subscriber is not more trusted than the model.

What must stay authoritative *after* a human says yes does not belong here.
Those ceilings live inside the tools — `exec`'s allowlist, the path boundary,
the sandbox — where nothing can reorder them.

`post_tool_use` is a broadcast: the call has happened and there is nothing left
to change. Only calls that actually ran reach it — a refusal from any gate
returns earlier — which is what lets a subscriber count executions rather than
intentions. `args` is what the tool was given, so a rewrite is visible there
rather than the original.

The first consumer is `builtin:tool-called-trigger`, which runs workflows whose
`tool_called` trigger names the tool. That trigger had been declared, validated
and advertised in the UI since long before anything dispatched it
([#561](https://github.com/quintonmiller/tailored-ai/issues/561)) — it could not
be fixed until this seam existed.

Both carry **`toolUseId`**, the provider's own id for the call, and **`cwd`**.
The id is what makes the tool events joinable: without it a subscriber sees a
tool name and cannot tell one `exec` in a turn from the next, so it can count
calls but never follow one. The approval events below carry the same id, which
is what lets "did the call I approved do what it said" be asked at all.

#### `approval.requested` and `approval.settled`

The approval gate on the bus. `requested` fires before the approver is asked, so
the pair brackets the wait and an outstanding approval is observable rather than
only its outcome.

`settled` fires for **every** call that needed approval, and its `outcome` has
three values, not two:

| outcome | |
|---|---|
| `approved` / `rejected` | somebody answered, or the clock did |
| `unattended` | the call needed a person on a path that has none — cron, a room wake, the task watcher |

That third value is the point. A record covering only the approvals somebody
answered would be silent about exactly the calls nobody saw, and whether those
run is a config flag (`permissions.noHandlerAction`) whose effect was previously
visible only as a one-time warning in a log rather than per call. This is the
audit half of [#545](https://github.com/quintonmiller/tailored-ai/issues/545).

`timedOut` is carried separately from `outcome` for a related reason:
with `timeoutAction: auto_approve`, a call nobody looked at comes back as
`approved` and reads exactly like a considered yes. `{ outcome: "approved",
timedOut: true }` is the case an auditor most wants to be able to find.

## Plugin HTTP Routes

Plugins mount HTTP endpoints on the TAI server through a framework-agnostic seam — core never imports Hono, the dependency direction stays server → core.

- **Core side** (`packages/core/src/http/registry.ts`): the runtime owns one `HttpRouteRegistry` of route descriptors `{ method, path, handler, auth?, absolute? }`. A handler is `(req: TaiHttpRequest) => Promise<TaiHttpResponse>` with simple request (method, params, query, headers, `json()`/`text()`) and response (status, headers, `json`/`body`) shapes — not a re-creation of Express. The registry survives `reload()` because Hono can't unmount routes once added; handlers read live runtime state per request.
- **Plugin side**: a plugin registers via `ctx.http.register(descriptor)` or `ctx.http.mount(prefix, descriptors)`. Both return a disposer — call it from the plugin's own disposer so routes don't collide when the runtime re-loads the plugin on reload.
- **Namespace**: plugin routes mount under `/api/ext/<plugin-id>/…` so they can never shadow a core route. The loader bakes the plugin's module id in as the default prefix; `mount("admin", …)` nests under `/api/ext/<plugin-id>/admin/…`.
- **Auth**: `auth: "token"` (default) puts the route behind the server's `server.authToken` bearer check like every other `/api/*` route. `auth: "none"` exempts it — for a webhook/callback called by a service (not a browser) that authenticates with its own secret. The exemption is matched against the concrete request path in the server's auth middleware.
- **Absolute escape hatch**: `absolute: true` opts a descriptor out of the namespace and mounts it at the verbatim `path` (which must start with `/`). Reserved for first-party packages preserving a legacy path the UI or an external service already calls — a deliberate, reviewed exception, not a default. The trusted-actions package uses it to keep `/api/trusted-actions/*` working (see [docs/trusted-actions.md](./trusted-actions.md)).
- **Server side** (`packages/server/src/http-routes.ts`): after building the Hono app and the auth middleware, `mountPluginHttpRoutes(app, runtime)` iterates the registry and adapts each descriptor onto Hono, before the SPA static fallback. Routes register at startup (the runtime-context plugin pass runs before `createServer`).

## Plugin Slash Commands

Plugins register chat commands through the same shape as the HTTP seam above — core owns transport-neutral descriptors, each channel adapts them, and core never imports discord.js from the registry.

- **Core side** (`packages/core/src/commands/registry.ts`): a module-level `SlashCommandRegistry` of descriptors `{ name, description, options?, ephemeral?, handler }`. A handler takes a `SlashCommandInvocation` (`command`, resolved `options`, `user`, `channelId`, `guildId`) and returns `{ content, ephemeral? }`. Options are `string | integer | number | boolean`, optionally with fixed `choices` or an `autocomplete` callback. Nothing here is Discord-shaped, so a Slack or Telegram channel can serve the same descriptors.
- **Plugin side**: `ctx.commands.register(descriptor)` returns a disposer — call it from the plugin's disposer so a disabled plugin stops advertising its commands. The Discord client re-syncs from the registry on every config reload.
- **No namespace, so collisions are refused**: HTTP routes hide plugin paths under `/api/ext/<id>/`, but chat platforms give you a flat command namespace with no separator to hide a prefix behind. `register` therefore throws on a name in `RESERVED_COMMAND_NAMES` (the built-ins) or one another plugin already took. Refusing is the honest failure — the alternative is a plugin silently shadowing `/room` or `/memory` for a whole guild. Names must match `/^[a-z0-9_-]{1,32}$/`, the narrowest constraint across the platforms we target.
- **Discord side** (`packages/core/src/channels/discord-plugin-commands.ts`): `buildPluginCommands()` adapts descriptors onto `SlashCommandBuilder` for the sync; `handlePluginCommand` / `handlePluginAutocomplete` dispatch interactions and return `true` when they owned one. The reply is **deferred before the handler runs** — handlers do arbitrary work (shelling out to a service script, for instance) and Discord kills an interaction that goes three seconds without a response. A handler that throws is caught and reported into the interaction rather than left hanging as "the application did not respond".

- **A duplicate name is dropped, never sent**: Discord rejects the whole bulk overwrite when a payload names one command twice, and the overwrite is all-or-nothing — so a rejected payload leaves the guild frozen on whatever last registered successfully. Every command, `/pause` included; on a first run, no commands at all. `dedupeCommandNames` therefore drops the later of any colliding pair and warns naming both. Push order is precedence order — **built-in, then plugin, then config** — so the built-in always survives. The registry's refusal above stops a plugin reaching this; config commands are not checked anywhere else, and `Deploy`, `deploy` and `deploy!` all normalize to the same name.
- **A rejection Discord will repeat is not retried**: `registeredCommandsHash` is recorded on a 4xx as well as on success, so a bad payload is attempted once per change rather than once per `ClientReady` and once per config reload, forever. A 5xx or a dropped connection still retries.

A worked example, including the awkward case of a command whose side effect kills the process serving it, is in [docs/multi-instance.md](./multi-instance.md#switching-from-discord).

## Admin Tool

`packages/core/src/tools/admin.ts` lets the agent read/modify its own configuration at runtime:

- Reads the raw YAML file for updates (not the merged config) so defaults don't pollute the user's file
- Writes trigger `runtime.reload()` for immediate effect
- Available in all tool closures alongside delegate and task_status (meta tools)

## Writing config

Every runtime write to `config.yaml` goes through `packages/core/src/config-write.ts`:

| Function | Use |
|---|---|
| `updateRawConfig(host, mutate)` | Patch the parsed document. The document is parsed strictly first — a patch computed on top of a parse failure would write the patch over an empty doc and drop the rest of the file. |
| `writeRawConfigText(host, text)` | Replace the whole file (the raw editor). Parses before writing. |

Both validate the result as the config it *would become* (`normalizeRawConfig`, so migrations and defaults are applied exactly as at load) and throw `ConfigWriteRejected` — leaving the file untouched — if the write would introduce config that parses but is never read. Non-blocking findings come back as `warnings` for the caller to surface.

Two rules worth knowing before adding a check:

- **Refuse on the delta, not the total.** A deployment accumulates findings unrelated to the next write (a tool whose credential env var isn't exported in this shell). Judging a write on the total makes the config permanently unwritable for reasons that have nothing to do with the change. Findings are compared against a pre-write snapshot by message identity.
- **Only "parses but is never read" refuses.** `findInertConfig` decides: an unrecognized key, or a value that is not the type its field is declared as. Neither is transient, and the author is right there. Everything else `validateConfig` reports — a tool not currently enabled, a provider a plugin registers later — warns.

This exists because the same gap kept producing the same bug: an agent wrote itself `name:` and `temp:` instead of `temperature:`, every layer accepted it, and it ran at the default temperature for a day. `validateConfig` had detected exactly that since #252; it just ran at startup, into a log, after the write.

Checks needing the live tool registry (`unknownToolRefs`) stay in the admin tool — the shared writer deliberately knows nothing about runtime state. Out of scope by design: `packages/cli/src/setup.ts` (out-of-process, no runtime) and `google-tools`' `persistFolderId` (holds only a `configPath`).

## Validating config shape

`packages/core/src/config-schema.ts` holds zod schemas for the parts of `config.yaml` core owns. `validateConfig` was always a *semantic* checker (this tool needs an api key, that agent references a tool nobody enabled) and stays one; the schema is the layer in front of it that asks whether a value is the type the interface says it is.

`AgentConfig` is a TypeScript interface, so nothing survives to runtime to compare against. What that allowed:

```yaml
cron:
  jobs:
    - name: nightly-sweep
      enabled: "false"     # quoted — `job.enabled !== false` is true for a string
```

The job stayed scheduled after an agent was asked to disable it and reported "Done". The reported finding now names the inversion outright: *"A non-empty string is truthy, so this currently reads as `true`. Write `false` without them."*

Three rules for anything added here:

- **The interface stays; the schema is checked against it.** `Identical<z.infer<typeof Schema>, TheInterface>` fails the build if either side gains, loses, or retypes a field. Inferring the type from the schema instead would delete every doc comment on `AgentDefinition`, which is the only place the *why* of a field is written down.
- **Derive key lists, never retype them.** `KNOWN_AGENT_KEYS` (config.ts) and the manifest field list (`resources/agent.ts`) both read `AGENT_DEFINITION_KEYS`, which is `Object.keys(AgentDefinitionSchema.shape)`. As three hand-maintained copies, they drifted: `fileBoundary` never reached `toolContextExtras` (three agents ran with a declared filesystem confinement that did nothing) and thirteen agents set `injectMemory: true` and never got one.
- **Closed records get full checks; open bags get `enabled` only.** `AgentDefinition` and `CronJobConfig` are core's. `tools.*`, `channels.*` and `mcp.servers.*` hold plugin config whose shape core must never know, so the only field judged there is the one they all share — and `enabled: "false"` enables the thing it claims to disable in every one of them.

Severity differs by caller, deliberately. `validateConfig` and the write gate report; `parseAgentData` throws, because a manifest with a mistyped field cannot be turned into a definition — so it keeps the older, laxer reading of `key:` with no value (absent, not an error), where a rejection would cost the whole agent.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins


## Context slots — contributing a prompt block

Adding a block of context should not require understanding the prompt layout. `systemPrompt.order` / `.custom` can express any layout but demands you know the whole one; a **slot** is the other half of that seam — the author says what they have and how it behaves, and core decides placement, ordering, budget and cache position.

The contributor answers exactly one question: **does this change between turns?**

```ts
registerContextSlot({
  id: "on-call",
  refresh: "turn",        // "reload" → system prompt, part of the cacheable prefix
                          // "turn"   → behind the history, deliberately outside it
  budgetTokens: 200,      // core truncates and says that it truncated
  agents: ["*"],          // same shape as a tool allowlist
  title: "On call",
  render(ctx) { return whoIsOnCall(); },   // null renders nothing this turn
});
```

and from config, with no code:

```yaml
prompt:
  slots:
    - id: house-rules
      refresh: reload
      file: ~/house-rules.md      # re-read each turn, so an edit needs no restart
    - id: standup
      refresh: turn
      title: Standup
      budgetTokens: 150
      content: "Standup is at 09:30."
```

Nobody types a tier name, names a built-in layer, or thinks about cache breakpoints.

### What core owns

| Concern | Decided by |
|---|---|
| Which group | derived from `refresh` |
| Where in the request | core — slots render into the `slots_standing` and `slots_state` layers |
| Ordering among slots | core (registration order; config slots after registered ones) |
| Staying inside budget | core truncates at `budgetTokens` and **says** it truncated |
| A slot that throws or returns nothing | skipped, warned once, turn continues |

That last row matters: `buildChatLiveState` already degrades section-by-section in a `try/catch`, and that behaviour belongs to the framework rather than being re-implemented — and re-forgotten — by every contributor.

### One hard constraint

The per-turn group renders as **one contiguous block**. `applyHistoryCacheBreakpoint` in the Anthropic provider targets `messages.length - 2` and so assumes exactly one volatile trailing message; several separately-placed slots would move that breakpoint into the volatile region and buy a cache *write* every turn that nothing ever reads.

### Adding is not rewriting

There is deliberately **no** `refresh` value that appends to the conversation record. A slot is a view: rendered fresh, replacing last turn's copy. Every duplication bug in `docs/context-assembly-design.md` came from a view being written into the append-only history, so the additive path — the one a contributor reaches for without reading any of this — cannot do it. A plugin that wants to change how history itself is composed replaces a strategy instead (#183, #185).
