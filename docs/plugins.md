# Writing plugins

Plugins extend the TAI runtime without forking. A plugin is a function that
receives a `PluginContext` and registers tools, channels, providers, event
handlers, or any combination. The runtime calls it once per process at
startup; everything you register lives until reload.

This guide is the practical companion to [platform-vision.md](./platform-vision.md),
which explains the architectural direction. Start there if you want the why;
start here if you want the how.

## Minimum viable plugin

```ts
import type { Plugin } from "@tailored-ai/core";

const plugin: Plugin = (ctx) => {
  ctx.events.on("task.created", (e) => {
    console.log(`new task: ${e.taskId}`);
  });
};

export default plugin;
```

That is the complete shape. Package it, point TAI at it, and the handler
fires every time a task is created.

The `import type { Plugin }` is erased at compile time, so a built plugin
has zero runtime dependency on `@tailored-ai/core`. You can publish it
without your users needing to match your core version.

## The PluginContext

`ctx` exposes everything a plugin can extend. Today's surfaces:

| Surface | What you register | Example |
|---|---|---|
| `ctx.tools` | Tool factories — agent-callable tools | `ctx.tools.register("my_lookup", () => [myTool])` |
| `ctx.channels` | Channel factories — inbound/outbound message surfaces | Slack, Discord, IRC, webhook |
| `ctx.providers` | LLM provider factories | A custom inference backend |
| `ctx.embeddings` | Embedding provider factories | A custom embedder |
| `ctx.memoryBackends` | Memory storage factories | Postgres, Redis, S3 |
| `ctx.taskBackends` | Task backend factories | A custom issue tracker |
| `ctx.uiProviders` | UI provider factories | A custom dashboard mount |
| `ctx.events` | Runtime event subscriptions | Task lifecycle, runtime reload |

`register()` calls and `events.on()` calls compose freely. A single plugin
can register a tool, subscribe to three events, and mount a channel —
nothing stops you from shipping a bundle.

## Subscribing to events

`ctx.events` is a typed pub/sub bus. Subscribe with `on(name, handler)`;
you get back a `Subscription` that disposes the handler when called.

```ts
const sub = ctx.events.on("task.transitioned", (e) => {
  console.log(`${e.taskId}: ${e.from} → ${e.to}`);
});

// Later, if you ever need to detach:
sub.dispose();
```

Most plugins never call `dispose()` — they register once and stay until
the runtime reloads, at which point the bus clears automatically and your
plugin re-registers on the next load.

Handlers may be async. The bus does not await them; multiple subscribers
run concurrently. A thrown error in one handler does not affect the
others — the bus catches it and logs to `console.error`.

## Event catalog (today)

These are the events the runtime emits as of Slice 2. The catalog grows
slice by slice — see [platform-vision.md § Event catalog](./platform-vision.md#event-catalog)
for what is coming next.

### `task.created`

A task was created in any backend.

```ts
{ taskId: string; projectId?: string }
```

### `task.updated`

A task was updated. `changes` lists which fields changed (e.g.
`["title", "tags"]`). Status changes are also reported separately as
`task.transitioned`, so subscribers interested only in state moves don't
have to filter the full update stream.

```ts
{ taskId: string; projectId?: string; changes: string[] }
```

Possible fields in `changes`: `title`, `description`, `status`, `author`,
`assignee`, `rank`, `blocked_reason`, `project_id`, `tags`.

### `task.transitioned`

A task's status changed. Fires alongside `task.updated`.

```ts
{
  taskId: string;
  projectId?: string;
  from: string;
  to: string;
  assignee: string | null;
}
```

Status strings are backend-native (e.g. `"backlog"`, `"in_progress"`,
`"in_review"`, `"done"` for the SQLite backend; GitHub backends use their
own). Use a status-aware helper (the `TaskBackend.statuses` map) if you
need normalized values.

### `task.commented`

A comment was added to a task. Fires either from the `comment` action or
from the status-change comment posted on `update`.

```ts
{ taskId: string; projectId?: string; author?: string }
```

### `runtime.reloaded`

The runtime finished a config reload. Emitted *before* the bus clears, so
plugins from the just-ending generation see the event and can do cleanup
(e.g. tearing down a long-lived connection).

```ts
{ generation: number }
```

## Worked example: a task notifier

A plugin that DMs the task author whenever one of their tasks transitions
to `blocked`.

```ts
import type { Plugin } from "@tailored-ai/core";

const blockedNotifier: Plugin = (ctx) => {
  ctx.events.on("task.transitioned", async (e) => {
    if (e.to !== "blocked") return;
    // Look the task up to get the author. The bus payload intentionally
    // stays small; resolve details via your own backend handle.
    await notifyAuthor(e.taskId, `task ${e.taskId} is blocked`);
  });
};

export default blockedNotifier;

async function notifyAuthor(taskId: string, message: string) {
  // …your delivery mechanism…
}
```

Notice what this plugin is *not* doing:

- It doesn't import any internal TAI module beyond a `type`.
- It doesn't ask the runtime to expose a "notifier registry" — it owns the
  delivery side itself.
- It doesn't coordinate with other notifiers. If you install three of
  them, all three subscribe; the runtime doesn't pick one.

That's the design intent. A plugin author has a free hand to compose
behavior from primitives.

## Worked example: a structured audit log

Subscribe to every task event and write a JSONL trail. Useful for
compliance audits, downstream pipelines, or just debugging.

```ts
import { appendFile } from "node:fs/promises";
import type { Plugin } from "@tailored-ai/core";

const auditLog: Plugin = (ctx) => {
  const log = (event: string, payload: unknown) =>
    appendFile("/var/log/tai-audit.jsonl", `${JSON.stringify({ event, payload, at: new Date().toISOString() })}\n`);

  ctx.events.on("task.created", (p) => log("task.created", p));
  ctx.events.on("task.updated", (p) => log("task.updated", p));
  ctx.events.on("task.transitioned", (p) => log("task.transitioned", p));
  ctx.events.on("task.commented", (p) => log("task.commented", p));
};

export default auditLog;
```

## Installing a plugin

Plugins are declared in `config.yaml`:

```yaml
plugins:
  - file:./my-local-plugin/dist/index.js
  - npm:@username/tai-some-plugin
  - tai-registry:tai-foo-bar
```

Supported source URIs: `file:`, `https:`, `git:`, `npm:`, `tai-registry:`.
The CLI's `tai plugin install <uri>` command writes to the same list.

The runtime imports the URI, calls `plugin.default(ctx)` once, and tracks
the resulting registrations against the plugin's id. A reload re-imports;
a disable removes the registrations and clears the plugin's event
subscriptions via `bus.clear()`.

## Testing a plugin

Plugins are plain functions, which means they test like plain functions.
Build a `TypedEventBus`, pass it as part of a stub `PluginContext`, emit
events, assert side effects.

```ts
import { TypedEventBus, type PluginContext } from "@tailored-ai/core";
import { test, expect, vi } from "vitest";

test("logs every task.created", () => {
  const events = new TypedEventBus();
  const ctx = stubContext({ events });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  myPlugin(ctx);
  events.emit("task.created", { taskId: "t-1" });

  expect(log).toHaveBeenCalledWith("new task: t-1");
});

function stubContext(over: Partial<PluginContext> = {}): PluginContext {
  return {
    tools: { register: vi.fn() },
    channels: { register: vi.fn() },
    providers: { register: vi.fn() },
    embeddings: { register: vi.fn() },
    memoryBackends: { register: vi.fn() },
    taskBackends: { register: vi.fn() },
    uiProviders: { register: vi.fn() },
    events: new TypedEventBus(),
    ...over,
  };
}
```

You don't need to spin up a runtime to test a handler. The bus is its own
testable unit.

## What's coming

The platform vision is being landed in slices. Each unlocks new
subscribable events and new contracts:

- **Slice 3** extracts the existing task-watcher behaviors (Discord
  notifier, worktree cleanup, stall guard, assignee routing) into default
  plugins. After this, the same plugin shape you write to extend the
  runtime is the shape TAI ships its own behaviors in. Forking a default
  is just disabling it and shipping your own.
- **Slice 4** lands `RepoBackend`, `Notifier`, and `ApprovalSurface` as
  formal contracts. `@tai/github-repo` becomes a plugin; GitLab, Gitea,
  Bitbucket, hosted Forgejo become equal-weight alternatives.

Until those land, the watcher continues to handle Discord delivery,
worktree management, and routing — your plugin runs alongside it. The
extracted plugins are additive; you can use them without rewriting your
existing config.

If you have an unusual workflow and want to know whether a plugin can
handle it today, open an issue describing the shape — the event catalog
is still being designed and feedback steers it.
