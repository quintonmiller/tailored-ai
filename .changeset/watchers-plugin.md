---
"@tailored-ai/core": patch
---

Agents can keep watches: cheap checks, with no model call, that wake them when
a page or a price changes. Turn it on with
`{ module: builtin:watchers, enabled: true }` in `plugins:`; it ships off, and
nothing changes for a deployment that leaves it off.

Turned on, every agent without a `tools:` list gets a `watch` tool (an agent
with a list needs `watch` in it) to add, list, pause, resume and remove its
watches. Two kinds come with it: `page`, whether a page's readable text
changed, or only the part around a phrase; and `price`, whether the price
nearest a phrase moved by at least a percent (2 by default). Settings are
plain words, never selectors. Adding one takes a first look at once, which is
the baseline later checks compare with, and saves nothing when the page can't
be read.

Each watch is a `watch` record in its owner's private scope, which a person can
pause, resume, re-check or edit on the State page. A change wakes the owner in
the watch's own session through the same brakes as every unasked-for turn: the
pause switch, and the owner's hourly wake ceiling, shared with subscriptions,
tends and upkeep. A wake turned away is tried again every five minutes for a
day. Three failed checks in a row stop a watch, and its owner is told once.

Checks reach the network on `web_fetch`'s terms, under `security.egress`, with
every redirect checked too, at most two at a time, ten seconds apart per host,
and 2 MB per page. Each check writes its watch once, so a `state.changed`
subscription on watch records hears every check, not only changes. The runner
also runs kinds other plugins bring through `ctx.watcherKinds`. See
`docs/watchers.md`.

`web_fetch`'s HTML-to-text, timeout and user agent are exported from its module
for the plugin to share; `web_fetch` itself is unchanged.
