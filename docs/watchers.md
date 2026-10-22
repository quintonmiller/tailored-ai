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

The built-in watchers plugin is such a runner, with two kinds of its own,
`page` and `price`. It's off by default: [turn it on](#turning-it-on) to let
agents keep watches.

## The watchers plugin

`builtin:watchers` gives agents a `watch` tool, keeps each watch as a `watch`
record in world state, and runs every watch when it comes due. When a check
finds a change, the agent that owns the watch is woken with the change in one
line. Nothing calls a model until then.

### Turning it on

Set its entry in `config.yaml` to enabled:

```yaml
plugins:
  - module: builtin:watchers
    enabled: true
```

The plugin takes no settings of its own. An agent gets the `watch` tool the
usual way: every agent without a `tools:` list has it, and an agent with a list
needs `watch` in it.

```yaml
agents:
  trip-planner:
    tools: [web_fetch, watch]
```

Checks reach the network on the same terms as `web_fetch`, under
`security.egress`. An address on your own network is refused unless you allow
it, for example with `allowHosts: ["homeassistant.local"]`. While a
browser-mediator session limits which hosts agents may reach, watches keep to
the same list.

### What an agent does with it

| Action | Does |
|---|---|
| `add` | starts watching: a `kind`, its settings in `config`, and optionally a `label`, how often (`every`), a `note` on what to do when it changes, and the id of the `commitment` it's for |
| `list` | the agent's watches: what each reads now, its last change, and when it's next checked |
| `pause`, `resume` | stops checking one, or starts again. Resuming a broken watch clears its failures and checks it within a minute |
| `remove` | archives it: no more checks, and a person can bring it back on the State page |

An agent names a watch by its id or its label. A small model's slips are
forgiven rather than refused: settings sent beside `config` instead of inside
it are moved in, `"5%"` reads as 5, and `every: "every 2 hours"` reads as two
hours. Adding the same watch twice gives back the one it already has.

`add` takes a first look before anything is saved. That look is the baseline
later checks are compared with, and it tells the agent at once when the
settings don't work: a page that won't load, a host the egress policy keeps
out, a phrase that isn't on the page. Nothing is saved then, and the reply says
why:

```
watch add kind=price config={"url": "https://hotels.example/lisbon", "near": "per night"}
      label="Lisbon hotel price" note="Tell the travel room if it drops under €190."

Watching "Lisbon hotel price" as lisbon-hotel-price-8c41: price on hotels.example/lisbon, every 2h.
It reads €212 now.
You'll be woken when it changes from this.
```

### The two kinds

| Kind | Settings | Reports | Every |
|---|---|---|---|
| `page` | `url`, and optionally `contains`: a phrase, such as `tickets` or `opening hours` | when the page's readable text changes: `The page changed: 2 new lines, 1 line gone. First new: "Suite with river view".` With `contains`, only the part around the phrase counts: `The part around "tickets" changed: now "Tickets Sold out", was "Tickets 4 left".`, and it says when the phrase appears or goes | 1h by default, 15m at the least |
| `price` | `url`, and optionally `near`: words next to the price, such as `per night` or `total`; and `threshold`, how far it must move in percent (default 2) | when the price moves by at least the threshold: `The price fell from €212 to €182 (down 14%).` | 2h by default, 30m at the least |

Both read a page the way `web_fetch` does: scripts and styles dropped, one
block per line. Neither takes a CSS selector or a pattern. A page with a clock
or a visitor counter on it changes on every visit, so point a `page` watch at
the part you care about with `contains`.

`price` finds the price nearest the first place `near` appears, before or
after it, so `€182 per night` and `Per night: €182` both read 182. Without
`near` it takes the first price on the page. It reads `€182`, `$1,234.50`,
`1.234,50 €`, `US$ 199` and `182 EUR`. A move under the threshold isn't
reported, but it isn't forgotten: the next move is measured from the price
last reported, so a slow drift adds up to a change. A page with no price where
one was expected, a sold-out page say, is a failed check, not a change.

### When a watch is checked

The plugin looks for due watches every 30 seconds: active watches whose
`checkAt` has passed. The schedule is the records themselves, so a restart or
a reload picks up where the last one left off.

- **Two checks at a time**, across the whole instance, and never the same
  watch twice at once, a reload in the middle of a check included.
- **One host at a time**: two requests to the same host are at least 10
  seconds apart, whichever watches made them.
- **Limits per check**: a request waits 15 seconds for an answer, as
  `web_fetch` does, and a check is given up after 45. An answer over 2 MB is
  refused. Every redirect is checked against the egress policy before it is
  followed.
- **One write per check**, carrying everything the check found.

### When the owner is woken

A change is written to the watch (`lastValue`, `lastChange`) and the owner is
woken through `runtime.wakeAgent`, in the watch's own session, `watch:<id>`.
The turn's tools see `{ kind: "watch", ref: "<id>" }` as `ToolContext.wake`.
The prompt is short: the watch's label, the change, what it reads now, the
owner's note, and that nobody reads the session, so anything a person should
hear has to be sent.

```
Your watch "Lisbon hotel price" saw a change. Nobody has asked you anything.

The price fell from €212 to €180 (down 15%).
It reads €180 now.
When you set it up, you asked: Tell the travel room if it drops under €190.
(watch lisbon-hotel-price-8c41: price on hotels.example/lisbon, every 2h)

Act on it if it needs anything. If it doesn't, say so in one line and stop.
Nobody is reading this session. If something here needs to reach a person, send it; a reply here goes nowhere on its own.
```

The wake stops for what every turn nobody asked for stops for: the pause
switch, an online agent switched off or paused on its own, and the owner's
hourly wake ceiling (`rooms.maxWakesPerHour`), which it shares with
subscriptions, tends and upkeep. A wake turned away is owed: the watch keeps a
`tellAt`, and the owner is told every five minutes until a turn runs, with the
latest change. After a day the runner stops trying, and the change stays on
the record.

What wakes nobody:

- **The first look**, which sets the baseline. A person who changes a watch's
  settings on the State page gets a new baseline too, rather than a wake that
  reports the new page as a change to the old one.
- **A check that finds nothing new.**
- **A failed check.** It is counted, and the last good snapshot is kept, so the
  next change is still measured from it. Three failures in a row mark the
  watch `broken`, and its owner is told once, with the last error. A broken
  watch isn't checked again until it's resumed.

A watch whose owner is no longer an agent is paused, saying so in
`lastError`, rather than fetched for nobody.

### The `watch` record

One per watch, in its owner's private scope, `agent:<owner>`, so no other
agent sees it. Agents can't write it through `state`: the owner changes its
own with the `watch` tool, and the runner writes each check, both as the
plugin with the owner named in `source.onBehalfOf`.

| Field | Holds |
|---|---|
| `owner`, `kind`, `config` | whose it is, which kind, and the kind's settings |
| `label`, `every`, `note` | what it watches in a few words, how often, and what to do when it changes |
| `status` | `active`, `paused`, or `broken` after three failures in a row |
| `checkAt`, `checkedAt` | when it is next checked, and when it last was |
| `lastValue`, `lastChange` | what it read last, and the last change: `{ at, text }` |
| `failures`, `lastError` | failed checks in a row, and why the last one failed |
| `tellAt` | while a wake is owed, when it is tried next |
| `snapshot` | what the next check compares against, with the settings it was taken under. The runner's |
| `commitment` | the commitment it serves, when the agent named one. Kept for a later step to act on |

A person edits any of it on the State page, and the runner reads what they
left on its next look:

- `status: paused` stops it, and `active` starts it again.
- Setting `checkAt` to now checks it on the next look. It has to be an ISO
  time; anything else is refused, since it would never come due.
- A record a person makes there with no `checkAt` is checked at once.

An agent keeps at most 25 watches, archived ones aside.

Every check moves `checkAt`, and every write raises `state.changed`, so a
[subscription](./world-state.md#waking-agents-on-a-change) with `when: { type: watch }`
hears each check, not only each change. Its line names the fields that moved,
and a change is the one where `lastChange` did, but `when` matches top-level
fields only and can't tell the two apart. Until it can, act on changes from
the owner's wake: the owner can pass the news on.

## The contract

```ts
interface WatcherKind<C, S> {
  kind: string;          // "price": lowercase, what a watch names
  description: string;   // one line on what it checks, 160 characters at most
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
- **`defaultEvery` and `minEvery`** are lengths of time, as `tend` reads them:
  `"30m"`, `"2 hours"`, `"1 day"`. A leading "every", the way the `schedule`
  tool writes its intervals (`"every 30 minutes"`), reads the same here and in
  a watch's own interval. A watch asking for less than `minEvery` is raised to
  it. The floor protects the site or account being checked as much as your
  machine.
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
lowercase, no description or one longer than a line of 160 characters, no
schema, no `check`, an interval that isn't a length of time, or a
`defaultEvery` under its own `minEvery`. A plugin that throws partway through
loading has what it registered taken back, so nothing half-loaded stays.

Like every registration through `ctx`, a kind comes out when its plugin is
unloaded. When that happens depends on how the plugin was loaded:

- A plugin loaded with the runtime (the `builtin:*` set) is loaded again on
  every reload, so its kinds are replaced with the new load's, and turning it
  off removes them.
- A plugin loaded before the runtime (google-tools, or any plugin installed
  with `tai plugin`) loads once per process. Its kinds stay as first
  registered until a restart, whatever the reload changed.

See [runtime plugins across a reload](./architecture.md#runtime-plugins-across-a-reload).

## Writing a runner

A runner reaches everything it needs through the same view, and imports
nothing from core at run time:

| On `ctx.watcherKinds` | Does |
|---|---|
| `get(name)`, `list()` | the kind a watch names, and every kind registered now |
| `validate(kind, config)` | every way a watch's config fails the kind's schema, as sentences an agent can act on. Empty when it passes. A watch with no settings passes `{}` |
| `interval(kind, every?)` | the interval in milliseconds: `every` when given, else `defaultEvery`, never under `minEvery`. Sets `raisedFrom` when it raised one, so the runner can say so. A string back is a correction |
| `result(raw, previous)` | what a check returned, made safe to keep: throws a `WatcherError` (count it as a failure) for a missing snapshot, one that isn't JSON, one that is `null` once serialized (NaN, Infinity, an invalid date) or one over 4 KB; folds `change` and `value` to one line, cut with an ellipsis past their caps; drops a `change` when there was no `previous`, which holds the baseline rule for a kind that forgets it |

Why the context and not core's exports: a plugin under `<TAI_HOME>/plugins`
resolves its own install of core. That copy can be older than the host's, and
a named import of something it lacks fails before `register(ctx)` runs, so the
runner silently contributes nothing. It is also a separate module, with its
own empty registry and its own `WatcherError` class. So catch a refused result
by `err.name === "WatcherError"`, not with `instanceof`. Core exports the same
functions (`validateWatchConfig`, `watchInterval`, `watcherResult`) for code
inside core and for tests.

What a runner decides for itself: when to run each watch, how long a check may
take, how many failures in a row stop a watch, and what a change does. A kind
is promised `undefined` as `previous` on a first check, so hand it that even if
your store keeps "no snapshot yet" as `null`. A kept snapshot is never `null`,
because `result` refuses one that serializes to it, so the two can't be
confused.

## How this differs from workflow triggers

The pollers under `triggers/` (RSS, finance, weather) each own a timer and
start a workflow, and a deployment declares them in config. A watcher kind is
only the check: it has no timer and no idea what a change will do. That is
what lets an agent own a watch, and lets one runner apply the same limits to
every kind.
