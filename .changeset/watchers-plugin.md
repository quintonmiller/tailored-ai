---
"@tailored-ai/core": patch
---

Agents can keep watches: cheap checks, with no model call, that wake them when
a page or a price changes. Turn it on with
`{ module: builtin:watchers, enabled: true }` in `plugins:`; it ships off, and
nothing changes for a deployment that leaves it off.

Turned on, every agent without a `tools:` list gets a `watch` tool (an agent
with a list needs `watch` in it) to add, list, pause, resume and remove its
watches. It can add a second tool, `state`, which is offered once any
world-state type exists: on a deployment where nothing else declared one (no
avatar, no `state.types`, no directory), the `watch` type brings it in, and
agents can read their own watches through it. Leave `state` out of an agent's
`tools:` if it shouldn't have it.

Two kinds come with it: `page`, whether a page's readable text changed, or
only the part around a phrase; and `price`, whether the price nearest a phrase
moved by at least a percent (2 by default). Settings are plain words, never
selectors. Adding one takes a first look at once, which is the baseline later
checks compare with, and saves nothing when the page can't be read.

Each watch is a `watch` record in its owner's private scope, which a person can
pause, resume, re-check or edit on the State page. A change wakes the owner in
the watch's own session through the same brakes as every unasked-for turn: the
pause switch, and the owner's hourly wake ceiling, shared with subscriptions,
tends and upkeep. A wake turned away is tried again every five minutes for a
day, and pausing the watch drops it. An owner is woken about one watch at a
time. Three failed checks in a row stop a watch, and its owner is told, owed
the same way as a change. A watch a person edits into something it can't run
(settings its kind refuses, an owner that isn't the agent whose scope it's
kept in) is paused, saying why.

Checks reach the network on `web_fetch`'s terms, under `security.egress`, with
every redirect checked too and a kind's credentials dropped on a redirect to
another origin, at most two scheduled checks at a time, ten seconds apart per
host, and 2 MB per page. A check is written to its watch only when it found
something (a change, a new reading, a failure), so a quiet watch adds nothing
to world state's history; the next check is kept in memory instead, and a
restart checks each quiet watch once straight away. A `state.changed`
subscription on watch records hears those writes, not routine checks. The
runner also runs kinds other plugins bring through `ctx.watcherKinds`. See
`docs/watchers.md`.

`web_fetch`'s HTML-to-text, timeout and user agent are exported from its module
for the plugin to share; `web_fetch` itself is unchanged.
