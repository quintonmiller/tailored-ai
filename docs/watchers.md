# Watchers

A watcher is a cheap check with no model call. Is there anything new on this
page? Has this price moved? Has mail from this sender arrived? It runs on an
interval, compares what it finds with what it saw last time, and reports one
line when something changed. Something else decides what the change does,
usually waking the agent that owns the watch with the line attached.

There are two parts:

- A **watcher kind** is the code for one kind of check: `page`, `price`,
  `mail`. Any plugin can bring one.
- A **watch** is one use of a kind, with its own config (which page, which
  price, which sender) and its own interval.

**Core ships no kinds and runs no watches.** It keeps the registry, the
contract below, and the checks a runner needs before it trusts a watch or a
result. Scheduling watches, keeping each one's snapshot, counting failures and
deciding what a change does belong to a runner plugin. Until one is loaded, a
registered kind is listed and nothing calls it.

## The contract

```ts
interface WatcherKind<C, S> {
  kind: string;          // "price": lowercase, what a watch names
  description: string;   // one line on what it checks
  schema: JsonSchema;    // a watch's config
  defaultEvery: string;  // "1h": when a watch names no interval
  minEvery: string;      // "15m": the shortest a watch may ask for
  check(config: C, previous: S | undefined, ctx: { now; signal; fetch? }):
    { snapshot: S; value?: string | number; change?: string } | Promise<...>;
}
```

- **`schema`** describes a watch's config, in the subset of JSON Schema world
  state checks: types, enums, required and nested fields, bounds and patterns.
  A keyword outside that subset is named in a warning when the kind registers,
  because it would otherwise look enforced and enforce nothing.
- **`defaultEvery` and `minEvery`** are lengths of time in the words `tend`
  and schedules use: `"30m"`, `"2 hours"`, `"1 day"`. A watch asking for less
  than `minEvery` is raised to it. The floor protects the site or account
  being checked as much as your machine.
- **`check`** runs once. `previous` is the snapshot the last successful check
  returned, and `undefined` on a watch's first check.

What a check returns:

| Field | Holds |
|---|---|
| `snapshot` | what the next check compares against: JSON, at most 4 KB once serialized. Keep a hash, a few ids or the values you compare, never the page |
| `value` | the reading now, to show beside the watch: a price, a count, a title |
| `change` | one plain line when something changed, the way a person reads it in a notification: "The price fell from €212 to €182." Absent otherwise |

And the rules a kind is written to:

- **The first check sets a baseline.** With no `previous` there is nothing to
  compare with, so return a snapshot and no `change`. A watch created today
  must not report everything already on the page as new.
- **Throw when the check can't be done**: the page is down, the account
  refused, the answer wasn't what you expected. The runner counts the failure
  and keeps the previous snapshot. A throw is never a change.
- **Honour `ctx.signal`.** The runner aborts a check that runs too long.
- **Use `ctx.fetch` when it is there**, so the runner's limits (timeouts,
  which hosts may be reached) hold for your check. Fall back to the global
  `fetch` only when it isn't.
- **Use `ctx.now`** rather than `new Date()`, so your check agrees with the
  runner's clock and with tests.

## Registering a kind

```ts
import type { Plugin, WatcherKind } from "@tailored-ai/core";

const price: WatcherKind<{ url: string }, { price: number }> = {
  kind: "price",
  description: "Whether the price a page reports has moved.",
  schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
  defaultEvery: "1h",
  minEvery: "15m",
  async check({ url }, previous, { fetch: get = fetch, signal }) {
    const res = await get(url, { signal });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const now = (await res.json()).price as number;
    const snapshot = { price: now };
    if (!previous || previous.price === now) return { snapshot, value: now };
    return { snapshot, value: now, change: `The price moved from ${previous.price} to ${now}.` };
  },
};

export default ((ctx) => {
  ctx.watcherKinds.register(price);
}) satisfies Plugin;
```

`register` refuses, at load, a kind no runner could use: a name that isn't
lowercase, no `check`, an interval that isn't a length of time, or a
`defaultEvery` under its own `minEvery`. A plugin that throws partway through
loading has what it registered taken back, so nothing half-loaded stays.

Like every registration through `ctx`, a kind comes out when the plugin is
unloaded, and a reload replaces it with the new load's. A runner looking a kind
up after a reload gets the new one.

## Writing a runner

A runner finds kinds through the same view, `ctx.watcherKinds.get(name)` and
`ctx.watcherKinds.list()`, with no runtime import of core. Before it trusts a
watch or a result it calls the helpers core exports:

| Helper | Does |
|---|---|
| `validateWatchConfig(kind, config)` | every way a watch's config fails the kind's schema, as sentences an agent can act on. Empty when it passes. A watch with no settings passes `{}` |
| `watchInterval(kind, every?)` | the interval in milliseconds: `every` when given, else `defaultEvery`, never under `minEvery`. Sets `raisedFrom` when it raised one, so the runner can say so. A string back is a correction |
| `watcherResult(raw, previous)` | what a check returned, made safe to keep: throws a `WatcherError` (count it as a failure) for a missing snapshot, one that isn't JSON or one over 4 KB; folds `change` and `value` to one line, cut with an ellipsis past their caps; drops a `change` when there was no `previous`, which holds the baseline rule for a kind that forgets it |

What a runner decides for itself: when to run each watch, how long a check may
take, how many failures in a row stop a watch, and what a change does. A kind
is promised `undefined` as `previous` on a first check, so hand it that even if
your store keeps "no snapshot yet" as `null`. A snapshot is never `null`, so
the two can't be confused.

## How this differs from workflow triggers

The pollers under `triggers/` (RSS, finance, weather) each own a timer and
start a workflow, and a deployment declares them in config. A watcher kind is
only the check: it has no timer and no idea what a change will do. That is
what lets an agent own a watch, and lets one runner apply the same limits to
every kind.
