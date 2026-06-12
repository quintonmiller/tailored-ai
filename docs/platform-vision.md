# Platform vision — TAI as an event bus and extension surface

Status: draft / discussion. The doc captures a direction, not a committed
roadmap. Comments + counter-proposals welcome.

## Summary

TAI today bundles two roles: it's an **agent runtime** (loop, providers,
tools, channels) and it's a **workflow opinion** (the task-watcher
hardcodes "assignee=coder dispatches the coder agent on a fresh
worktree, runs gates, transitions to in_review, …"). The first role is
the genuinely hard work and worth shipping in core. The second is one
opinion among many — Linear-style assign + comment, trunk-based push +
post-hoc review, hand-rolled approval ceremonies, no PR concept at all.

The proposal: keep the runtime, peel the opinion out into composable
**plugins** that subscribe to a typed **event bus**. Core emits "this
happened"; plugins decide what to do (or not). The current behavior
ships as a set of default plugins — same UX out of the box, but every
piece is now replaceable, layered-on, or turned off.

This doc:

1. Explains why the current shape limits adopters.
2. Sketches the event bus + plugin model.
3. Catalogs the events that need to exist.
4. Shows how today's core behaviors decompose.
5. Proposes a migration path that doesn't break anyone.

## Motivation

Two recent loops surfaced the problem concretely.

**The autonomous coder→reviewer→PR loop**: most failures were not the
agent's judgment — they were the agent forgetting plumbing steps.
"Pass `project_id` on the tasks call." "Run `gh auth setup-git` before
push." "Slugify the blocked_reason label." Each of these is a
mechanism the runtime could handle deterministically, but it lives in
the agent's prompt because there's no surface to hand it to.

**The "make TAI less opinionated" critique**: even after factoring the
above into "programmatic vs agent," the proposed programmatic answers
assumed GitHub, assumed PR, assumed pnpm gates, assumed a specific
status flow (`reviewer approve → in_review + assignee:owner`). That's
better than baking it into the agent, but it's still one workflow. A
user on GitLab + Python + trunk-based has to either fork or fight.

The common thread: TAI keeps having to choose between "agent prompt
remembers it" (fragile) and "core hardcodes it" (opinionated). The
third option — emit an event, let a plugin handle it — is what's
missing.

## Model

```
                       ┌──────────────────────────────────┐
events emitted by core │   AgentRuntime.events (pub/sub)  │ ← plugins subscribe
                       └──────────────────────────────────┘
```

Three pieces, all small:

### 1. Typed event bus on the runtime

`AgentRuntime.events` exposes a pub/sub surface with typed event maps.
Built on `EventEmitter` or similar; nothing exotic. Each event carries
a payload describing what changed and any context a subscriber needs
(the full task, the worktree, the project id, etc. — not just an
opaque id).

```ts
runtime.events.on("task.transitioned", async (e) => {
  // e: { task, from: "backlog", to: "in_progress", project_id, ... }
});

runtime.events.on("agent.completed", async (e) => {
  // e: { taskId, agentName, duration_ms, toolCalls, exitReason, ... }
});
```

The bus is async-aware (handlers can be async; failures are isolated
per-subscriber). Subscribers can `off()` cleanly; reload semantics
mirror the existing channel registry.

### 2. Plugin subscription API

The existing `register(ctx)` plugin contract (PR-A/B/C) already gives
plugins access to a `PluginContext`. Add `ctx.events` exposing the
runtime bus:

```ts
export default function register(ctx: PluginContext) {
  ctx.events.on("task.transitioned", myHandler);
  ctx.tools.register(myTool);
  ctx.channels.register(myChannel);
  // unchanged surfaces also available
}
```

Plugins can subscribe to as many events as they want. Multiple plugins
can subscribe to the same event without coordinating. There's no
"the" handler for any event — the framework doesn't enforce a single
subscriber.

### 3. Extension contracts where the abstraction matters

For domain concepts that today are GitHub-flavored, define an
interface and let plugins ship implementations. Examples (initial set,
not exhaustive):

- **`RepoBackend`** — `pushBranch`, `openProposal`, `closeProposal`,
  `getProposalState`. Default impl wraps `gh`. GitLab, Gitea,
  Bitbucket, hosted Forgejo, etc. become plugins.
- **`Notifier`** — `notify(channel, message)`. Discord today; Slack,
  Telegram, email, SMS, web push, terminal stdout, no-op all become
  swappable.
- **`ApprovalSurface`** — `requestApproval(opts)`, `awaitDecision(id)`.
  PWA today; CLI prompt, web form, email reply, "always approve",
  Linear comment ack all become swappable.
- **`SandboxRunner`** — already partially there (host/docker/podman);
  formalize so worktree + container providers are a single contract.

Each contract is small and focused. None presumes more than the name
suggests.

## How current behaviors decompose

This is the load-bearing part of the proposal. Today TAI's
"workflow opinion" lives mostly in `TaskWatcher`. Walk through what it
does, and where each piece moves.

| Current behavior | New shape |
|---|---|
| `tasks.notify("created", id, projectId)` SQL/backend lookup → calls processEvent | Becomes `events.emit("task.created", task)`. The lookup logic stays in core (it's mechanism, not policy). |
| Assignee-based agent routing (`if (assignee === "coder") dispatch coder`) | Default plugin `@tai/assignee-routing` subscribes to `task.transitioned`. Users can swap for a label-based, queue-based, or round-robin router. |
| Worktree creation before dispatch | Default plugin `@tai/git-worktree` subscribes to `agent.dispatched`. Users on hg, Pijul, or no-VCS workflows ship a different plugin. |
| Stall detection + retry | `@tai/stall-guard` subscribes to `agent.timed_out`. Users can tune thresholds or disable entirely. |
| Coding-agent project_id guard | `@tai/project-guard` subscribes to `agent.dispatched` and refuses without a project. Optional safety net. |
| Discord DM on terminal status | `@tai/discord-notifier` subscribes to `task.transitioned` where status ∈ terminal set. Slack users ship `@tai/slack-notifier` instead. |
| Coder-leaves-branch-info comment | `@tai/branch-info-comment` subscribes to `worktree.commit`. Optional accounting. |
| Reviewer approve → push + open PR | `@tai/github-pr-on-approve` subscribes to `task.transitioned` where the to-state matches. Uses `RepoBackend`. Users can ship `@tai/gitlab-mr-on-approve`, `@tai/trunk-push-on-approve`, etc. |
| Worktree cleanup on done | `@tai/worktree-cleanup` subscribes to `task.transitioned` where to=done. Users who want to keep worktrees disable it. |

None of these decompositions changes user-visible behavior on day one.
The default plugin set ships installed and enabled; the system behaves
exactly as today.

The difference is that every piece is now: replaceable, layerable,
disable-able. A user can write a six-line plugin that does something
unusual, and TAI accommodates it without forking.

## Event catalog

A reasonable starting set. Names are illustrative; bikeshed later.

**Task lifecycle**
- `task.created`
- `task.updated` — generic update, payload includes before/after diff
- `task.transitioned` — specifically the status change, with from/to
- `task.commented`
- `task.deleted`
- `task.assigned` — convenience event for assignee changes

**Agent lifecycle**
- `agent.dispatched` — about to run an agent loop
- `agent.completed` — loop returned normally
- `agent.errored` — loop threw
- `agent.timed_out` — loop hit budget/round cap
- `agent.tool_call` — fine-grained, for observability plugins

**Worktree / sandbox**
- `worktree.created`
- `worktree.commit` — a new commit appeared on a per-task branch
- `worktree.removed`
- `sandbox.exec.failed` — observability for diagnosing flakes

**Notifications / owner delivery** (shipped — #205; the default `builtin:owner-notifier` plugin subscribes and DMs the owner, replacing the inline `sendDM` calls)
- `task.needs_human` — a task errored/blocked and needs the user; quiet-hours-suppressed
- `digest.ready` — a periodic digest (e.g. the morning digest) is ready to deliver
- `question.asked` — the `ask_user` tool asked the user a question (autopilot variant carries `taskId` and is quiet-hours-suppressed)
- `form.completed` — a `channel_message` workflow step's implicit "DM the owner" fallback

**Forge / repo** (emitted by RepoBackend implementations)
- `repo.proposal.opened`
- `repo.proposal.reviewed`
- `repo.proposal.merged`
- `repo.proposal.closed`
- `repo.check.completed`

**Approval**
- `approval.requested`
- `approval.granted`
- `approval.rejected`

**System**
- `runtime.reloaded`
- `plugin.loaded`
- `plugin.errored`
- `config.changed`

Open question: do we also need lower-level events like
`task.lookup_failed`, or is that observability via logs? Probably
logs.

## Plugin author's view

The intent is that writing a TAI plugin should feel like writing a
small Express middleware or Vite plugin. A new user with an unusual
workflow should be able to get going inside an afternoon.

Anatomy of a hypothetical "auto-merge on green CI" plugin:

```ts
// @username/tai-auto-merge

export default function register(ctx: PluginContext) {
  ctx.events.on("repo.check.completed", async (e) => {
    if (e.conclusion !== "success") return;
    const proposal = await ctx.repos.getProposalState(e.proposalId);
    if (proposal.state !== "open") return;
    if (!proposal.approvedBy.includes(ctx.config.requireApproverLogin)) return;
    await ctx.repos.mergeProposal(e.proposalId);
  });
}
```

That's the entire plugin. No core changes, no fork, no PR upstream
needed.

Plugins compose. A user who wants the default behavior plus auto-merge
installs both. A user who wants auto-merge but not push-on-approve
disables one and installs the other. A user who wants a totally
custom flow writes their own and disables the defaults.

## Migration

Done in slices, each independently shippable, none breaks behavior.

**Slice 1 — Event bus stub.** Add `AgentRuntime.events`, the typed map,
the subscription API on `PluginContext`. No emissions yet. ~200 LOC.

**Slice 2 — Lifecycle events from the task path.** Emit `task.created`,
`task.updated`, `task.transitioned`, `task.commented` from the
existing `tasks` tool / task backend layer. Keep the watcher's
behavior unchanged; it still reads from the backend. ~50 LOC.

**Slice 3 — Default plugins, behavior-equivalent.** Extract one
watcher responsibility at a time into a `@tai/...` plugin. Run both
old and new in parallel behind a feature flag; verify equivalence;
remove the old. Suggested order:
1. Discord notifier (lowest risk, most user-visible)
2. Worktree cleanup
3. Stall guard
4. Assignee routing + agent dispatch (the big one)

The four shipped default plugins (`agent-notifier`, `scope-creep-flagger`,
`stall-guard`, `coder-project-guard`) load through the ordinary
config-driven `loadPlugins` path as `builtin:*` entries in `config.plugins`
(#142) — not hardcoded `new …()` constructions. The `builtin:` prefix
resolves to a subpath export of `@tailored-ai/core` (`./plugins/*`); a
load-time migration (`migrateDefaultPlugins`) seeds any missing default so a
fresh install behaves as before. Users disable a default durably with
`{ module: "builtin:…", enabled: false }` (deletion alone is re-added by the
migration) and pass per-plugin settings through the entry's `config` bag,
which reaches the plugin as `ctx.config`. Event-driven plugins receive the
live runtime on `ctx.runtime` and load after the runtime is constructed;
registry-shaped plugins (tools/channels/providers) still load before it.

**Slice 4 — Backend abstractions.** Land the `RepoBackend` interface,
ship `@tai/github-repo` as the default. Migrate the
push-and-PR-on-approve flow to a plugin that uses it.

**Slice 5 — Documentation + examples.** "Anatomy of a plugin," "Replace
the default routing," "Build a custom approval surface." Without docs
the leverage doesn't reach external authors.

At every slice, the default install behaves as today. The watcher
class doesn't disappear; it becomes a thin shim that emits events and
optionally hosts the default plugin set (or, eventually, an empty
class kept around for back-compat).

## Non-goals

- **Replacing the agent runtime.** The loop, the providers, the tools
  protocol — none of that changes. The bus is layered on top.
- **A monorepo of every possible plugin.** The default set should be
  small (5–10 plugins). The expectation is that an ecosystem grows
  around the contract; TAI doesn't have to ship every variation.
- **Removing all opinion.** Some opinions are load-bearing for new-user
  experience (the default plugin set IS an opinionated workflow). The
  point is that opinions become *changeable*, not *gone*.
- **A general-purpose workflow engine.** TAI already has one
  (workflow YAML, step executors). The event bus complements it; it
  doesn't replace it. A complex workflow can subscribe to events and
  invoke the workflow engine.

## Open questions

- **Event ordering / fan-out semantics.** If three subscribers handle
  `task.transitioned` and one of them transitions the task again,
  do we re-emit? Today's watcher has a gate for this; the bus needs
  the same kind of discipline.
- **Async vs sync subscribers.** Probably all async. But: do we wait
  for all subscribers before considering an event "done," or
  fire-and-forget? Fire-and-forget is simpler; "wait" matters for
  causality (don't dispatch an agent before the worktree exists).
  Likely we need both, declared per subscriber.
- **Cross-plugin coordination.** If `@tai/git-worktree` creates a
  worktree and `@tai/agent-dispatch` needs to know about it, they
  communicate via events — but the second has to wait for the first.
  Event-ordering question above.
- **Versioning of the event payload schema.** Payloads will evolve.
  Plugins compiled against old payloads should not silently miscompare
  fields. Probably each event carries a schema version + we provide
  helpers.
- **Persistent vs ephemeral events.** Most events are ephemeral
  (handle-or-miss). Some — approval requests in particular — need
  durability across restarts. Probably out of scope for the first
  cut; revisit when ApprovalSurface lands.

## Prior art

- **VS Code extension API**: contributes activation events; extensions
  subscribe and contribute commands, providers, etc. Similar
  publish/subscribe + extension-contract shape.
- **Probot** (GitHub bots): pure event-handler model. A bot is a
  function from `GitHubEvent → action`. We're closer to this than to a
  Kubernetes-operator-style model.
- **n8n / Zapier**: event-trigger nodes plus action nodes wired by
  config. The workflow-YAML side of TAI already looks like this; the
  event bus would let workflows subscribe to internal events the
  same way they subscribe to webhooks today.
- **Linux signals / eBPF**: kernel emits events; userland decides what
  to do. Closest mental model for the abstraction level we want.

## Closing

The shift here is from "TAI is an opinionated autonomous-agent
product" to "TAI is a platform for building autonomous-agent
systems." The first is fine but ceiling-limited to what we can
foresee; the second invites contributors to build the things we
didn't think of.

Concretely: file Slice 1 as the first issue, build it, ship the
event bus stub. The rest follows incrementally; nothing has to
happen all at once.

Counter-proposals on shape, naming, scope, or sequence very welcome.
