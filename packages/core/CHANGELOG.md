# @tailored-ai/core

## 0.1.11

### Patch Changes

- 9018bc8: Drive another coding agent over a real session, not a subprocess call.

  `claude_code` shells out to the `claude` binary with a prompt string. That is
  one-shot by construction: no session to continue, nothing streaming back while
  it works, no way to answer a permission prompt, no way to know why it stopped.
  Every one of those is something the Agent Client Protocol defines and a
  subprocess call cannot carry.

  The new `coding_agent` tool speaks ACP. It opens a session, sends the prompt,
  reads the streamed message chunks, answers permission requests according to
  policy, and reports the protocol's stop reason.

  In core rather than in a plugin for the reason `mcp/` is: a protocol-level
  capability, the `openai_compatible` of agent-driving. What keeps that honest is
  that **core knows the protocol and never a vendor** — no built-in agent list, no
  default command, and no agent's name in `DEFAULT_CONFIG`. `tools.coding_agent.agents`
  is the only thing that decides what runs, exactly as `mcp.servers` is.
  `@agentclientprotocol/sdk` is an optional dependency, dynamically imported, with
  only structural types crossing the boundary so core compiles without it.

  **Permission requests default to `deny`.** An agent asks precisely when it is
  about to write a file or run a command, and an unattended path saying yes on the
  owner's behalf is the failure this codebase keeps producing — a subagent is a
  way to get it at one remove. The refusal is reported in the tool result along
  with the key that changes it, so a first run says what to do rather than
  returning a mysteriously short answer. The answer is chosen by option _kind_
  rather than position, and prefers one-shot over standing in both directions: a
  standing grant is a policy decision and nothing here is entitled to make one.

  The session runs inside the calling turn's `workingDirectoryBoundary` when it
  has one, so a subagent is not a hole through a containment the parent turn is
  subject to.

  **A policy is not a sandbox, and the docs say so.** Verified against both real
  adapters: told to write a file under `permissions: deny`, Claude Code asked, was
  refused and wrote nothing; Codex never asked and wrote it, having auto-approved
  internally ("risk: low"). The handshake is cooperative by design — ACP lets an
  agent ask, it does not oblige it to — so `deny` is a preference expressed to a
  cooperating agent rather than containment. Running the agent under the sandbox
  seam is the durable answer and is tracked separately.

  `claude_code` is untouched. Superseding it is a separate decision.

- 9dc9836: Add `agent.defaults` — deployment-wide fallbacks for every per-agent field.

  A setting whose right value is the same for every agent had to be written on
  every agent, and the ones added later silently kept core's default. The omission
  is invisible: the agent resolves fine and takes a value nobody chose.
  `roomSessionScope` is the worked example — in a 32-agent deployment 27 set it to
  `shared` and 5 said nothing, and one of those five was the agent whose whole
  value is remembering a subsystem. A direct message to it opened a session
  holding none of what it had learned, and it answered by reading back an
  unrelated block of injected state.

  Precedence is `agents.<name>.<field>` → `agent.defaults.<field>` → the legacy
  deployment-wide field where one exists → core's default, so a deployment can
  migrate onto the new block without editing every agent first. Applies to agents
  from `config.yaml` and from the agent registry alike.

  Identity fields (`tools`, `skills`, `instructions`, `model`, `provider`,
  `models`, `description`, `contextDir`, `online`) are rejected with a validation
  warning that names the reason, rather than silently ignored.

- e21c40e: Benchmark: a scenario can hand the agent an `answer` tool that says whether it
  is right, with a bounded number of attempts (3 by default).

  Every other grader in the package scores a run after it is over, so what gets
  measured is the agent's _first_ answer. Converging — try, be told no, do
  something different — is a separate capability and the one most real work
  consists of, since tests, CI, validators and people all work that way.

  It is also the only instrument that can see what a model does after being told
  it fabricated. The state-loss scenarios show it inventing a value with complete
  confidence in 18 runs out of 18, and nothing in a transcript separates that from
  knowing. Handing back `false` splits three continuations that currently look
  identical: go and look, concede, or invent a second value. `guesses` records the
  whole sequence, because the count is a score and the sequence is the finding.

  `acceptsUnknown` lets a scenario treat "I don't know" as correct where the fact
  is genuinely unrecoverable, which is what makes this fit the hardest rows rather
  than trivialising them: the measurement becomes how many fabrications precede
  the concession.

  An oracle leaks information, so a scenario may only use one where the answer
  space is large — a witness code, a clock time — or where the expected answer is
  a concession. Three attempts against a binary is brute force, not a test.

  Measured over 12 runs. When the model reaches the tool it concedes: four
  submissions, all "unknown", all on the first attempt, zero invented values — the
  opposite of the hypothesis these rows were written to test. Asked the same
  question without an oracle it states a specific time with total confidence, so
  the difference is not what it knows but whether the turn offers a shape in which
  not knowing is sayable.

  The rows still score 33%, because the other eight runs never reached the tool.
  They spent the round budget re-reading an empty `core_memory` until the
  repeated-call detector ended the turn (#528), and three then emitted the
  `answer` call as raw markup in the reply rather than making it (#529) — markup
  containing an invented time, so the fabrication was real and never got to the
  tool that would have rejected it.

- 0651034: A tool call can be followed, and an approval leaves a record.

  Two gaps from comparing TAI's hook surface to Claude Code's (#573). Both are
  additive — no behaviour changes, only things that were happening invisibly
  become visible.

  **`toolUseId` and `cwd` on the tool events.** `agent.pre_tool_use` and
  `agent.post_tool_use` carried a tool name and nothing tying them together, so
  two `exec` calls in one turn were indistinguishable to a subscriber and the most
  natural question there is — did the call I approved do what it said it would? —
  could not be asked. Both now carry the provider's own call id, and the approval
  events carry the same one. `cwd` comes along at the same site, because a hook
  otherwise has to guess where the call runs.

  **The approval path emits.** `requestApprovalWithTimeout` used to run start to
  finish without the bus hearing anything, so a deployment could not log its own
  approvals, notice an agent hitting the same one repeatedly, or see that it was
  blocked on one nobody had answered. Two broadcasts now bracket it:
  `approval.requested` before the approver is asked, and `approval.settled` after.

  `settled` fires for every call that needed approval, and its `outcome` has three
  values rather than two. `unattended` means the call needed a person on a path
  that has none — cron, a room wake, the task watcher — and whether it then ran is
  `permissions.noHandlerAction`, whose effect was previously visible only as a
  one-time warning in a log rather than per call. A record covering only the
  approvals somebody answered would have been silent about exactly the calls
  nobody saw, which is the audit half of #545.

  `timedOut` is carried separately from the outcome for the same reason: with
  `timeoutAction: auto_approve`, a call nobody looked at returns `approved` and
  reads exactly like a considered yes. Recovering that from the reason string
  would be parsing our own prose, so `requestApprovalWithTimeout` now returns the
  fact alongside the response.

- 5c6f252: A hook script that ignores its input can no longer take the runtime down.

  Writing to a child's stdin when the child has already exited raises `EPIPE`,
  and an `EPIPE` on a stream with no `error` listener is an **uncaught
  exception** — it does not reject the surrounding promise, it kills the process.
  So a hook program that exits without reading its payload, which is a completely
  ordinary hook, could fault the agent that ran it (#606).

  This was not theoretical. It shows up as an intermittent failure of the core
  test suite — roughly one run in two on a loaded machine, `Vitest caught 1
unhandled error`, always from `claude-hooks.ts` — which is the mild version of
  the same race. In a deployment it kills the agent instead.

  `closeChildStdin` in `shell.ts` now owns the operation. It attaches an error
  listener before writing, stays silent on `EPIPE` and `ERR_STREAM_DESTROYED`
  (the expected shapes of "the child is already gone"), logs anything else once,
  and never throws.

  **The child's exit code survives.** A hook that runs, ignores stdin and exits 2
  has refused the tool call; losing that verdict to a plumbing error on the input
  pipe would be a worse bug than the crash. The `close` handler resolves exactly
  as before.

  Applied at all four sites that close a child's stdin, not just the one observed
  failing — `plugins/claude-hooks.ts`, `sandboxes/host.ts`,
  `sandboxes/container.ts` and `tools/exec.ts`. The other three pass no payload so
  their window is far narrower, but the operation is identical and none of them
  had a listener either.

- 0b62d07: A hook can be a program.

  `builtin:claude-hooks` registers the `command` handler on the seam the previous
  change opened: run a program, hand it the event as JSON on stdin, read its
  answer off stdout and its exit code. Exit 2 refuses with stderr as the reason;
  `permissionDecision: "deny"` refuses with a written one; `updatedInput` rewrites
  the call; anything else is advisory and `denyIf` can still match it.

  **What this is for, stated honestly, because the obvious pitch is wrong.** It is
  not portability. Claude Code's tools are `Bash`, `Read`, `Write`, `Edit`; TAI's
  are `exec`, `read`, `write`, `edit`. Matchers are exact, so `"matcher": "Bash"` —
  the commonest example in the wild — matches nothing here, and a borrowed script
  would run and gate nothing, which is worse than failing. TAI deliberately does
  _not_ rename `exec` to `Bash` on the way out: manufacturing that compatibility
  would send the script's own logic after the wrong thing.

  What it delivers is that a hook can be written in any language. Their JSON shape
  is used because it is documented and already implemented by several others, and
  there is no reason to invent a third one.

  **Seeded disabled.** Every other hook can only reach a tool the deployment
  already registered and enabled — a real boundary, and this removes it by handing
  config the ability to run arbitrary programs with the agent's privileges. That
  should be a decision somebody made, not a default they inherited. The
  environment is scrubbed of `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`,
  `OPENAI_*`, `ANTHROPIC_*` and `OTEL_*` — not a boundary, since the hook runs as
  the agent, but hygiene against a credential riding along into a subprocess.

  One deliberate divergence from their contract: a `command` whose binary does not
  exist **refuses** on a refusable event, where Claude Code treats a broken hook
  as advisory. An unregistered _tool_ is skipped because the deployment may have
  disabled that plugin elsewhere and an unrelated call should not pay for it; a
  `command` is named right there in the hook, so its absence is unambiguous and
  the check this call was supposed to get did not happen.

  Also completes `updatedInput`'s counterpart in core: an `EventHookResult` may
  now return `args`, and a rewrite is carried forward so later hooks in the chain
  review the call as it now stands rather than as first asked.

- 38b808b: Messages and tool results can carry media, not only text.

  `Message.content` is now `string | MessageContent | null` and `ToolResult.output`
  is `string | ToolOutput`. A plain string still means exactly what it did before,
  so every text-only call site and all 398 tool-result construction sites are
  unchanged; only code that _reads_ content had to say what it does about media.

  The non-string arm is an object rather than a bare `ContentPart[]`, which looks
  fussy and is the whole reason this was safe to land. Widening to
  `string | ContentPart[] | null` first, as an experiment, produced exactly one
  compile error across `packages/core` — not because the change was safe, but
  because `string` and `Array` share `.length`, `.slice`, `.indexOf` and
  `.includes`. `estimateTokens` would have kept returning a number, just the wrong
  one: a count of parts instead of a count of characters. The compaction
  transcript would have serialized `[object Object]` into a summarizer prompt.
  Wrapping the arm in an object turned both into compile errors, twenty-five in
  core, each one a real decision about what that site does when handed a picture.

  `messageText()` and `toolOutputText()` give the text projection. They are
  functions over the one source of truth rather than a second stored field, so
  they cannot drift out of sync the way a cached projection would, and a caller
  that only wants text now says so at the call site.

  Media itself is stored by reference, never inline. A new `MediaStore` seam keeps
  bytes out of conversation history — `capToolOutput` head/tail-slices its input
  and would cut a base64 payload into something undecodable, and every vendor API
  separates the reference from the payload for the same reason. The bundled disk
  store addresses blobs by the sha256 of their bytes, which dedupes re-captures
  and, more importantly, keeps the loop's stuck-model detector working: it
  compares consecutive tool results verbatim, so a per-capture unique id would
  have quietly disabled the guard. Third-party stores register through the same
  registry the disk one uses.

  Persistence needed no migration. The `messages.content` column stays a single
  `TEXT` field; plain strings are stored verbatim, only media-carrying content is
  JSON-encoded, and decoding validates every part before trusting it — so a live
  database keeps working and a legacy message whose text merely looks like JSON is
  not misread as structured content.

  `estimateTokens` charges a flat per-image cost instead of the ~15 tokens an
  image's text placeholder would have cost. A deliberate over-estimate:
  over-counting evicts early, under-counting overflows the request, and only one
  of those is recoverable.

  Providers flatten media to a visible placeholder for now. A tool message's
  content must be a string — vLLM rejects an `image_url` part on `role: "tool"`
  even for a vision model — and resolving a stored reference needs the store,
  which is async. The point is that the model is told an image was there. It is
  never silently dropped and never JSON-stringified into the prompt.

- 662b23a: A plugin can change what a turn puts in front of the model.

  `agent.context_slots` is the first waterfall core declares, and the first thing
  dispatched on the agent loop's bus. A subscriber receives the slot list a turn
  is about to render and returns the list it should render instead — dropping,
  adding, reordering or capping — alongside the turn's agent, session, project and
  user message.

  ```ts
  bus.onWaterfall("agent.context_slots", async (payload, next) =>
    next({
      ...payload,
      slots: payload.slots.filter((s) => s.id !== "expensive"),
    })
  );
  ```

  Two deliberate properties.

  **The list arrives before anything renders.** A subscriber can stop a slot
  running, not merely discard what it produced — which matters for a slot that is
  expensive or that reads something the subscriber already knows is unavailable.
  The tests assert this by watching whether `render` was called, not only whether
  its text arrived.

  **An empty chain returns what it was handed**, so a turn with a bus and no
  subscribers assembles a byte-identical prompt to one with no bus at all. That is
  asserted directly rather than assumed, and it is what makes the seam safe to
  land ahead of any consumer.

  `renderContextSlots` is the first consumer because it is already a pure function
  over a slot list, so a subscriber needs to know nothing about how the system
  prompt is composed — the property #417 is after. Until now the waterfall
  dispatch mode had no core consumer at all, because the loop had nothing to
  dispatch on.

- f13cec6: Irreversible tool calls are refused when the request fits more than one target.

  Tools declare what a call does — `Tool.effect` is `read` | `write` |
  `irreversible`, a constant or a function of the arguments, so `exec` classifies
  per command and `git status` costs nothing. Undeclared is `read`, so nothing
  changes until a tool opts in.

  Before running an irreversible call the loop asks the model to enumerate what
  the request could be referring to. Two or more candidates and the call is not
  run; the agent gets a tool result naming them, which it can act on in the same
  turn rather than a stopped turn. Skipped when a human just approved the call —
  they saw it — and switched off with `permissions.checkDerivability: false`.

  Measured on the local 27B model, n=12 per arm, a request to delete "the old
  backup bucket" with two equally-old buckets in the conversation:

  |                  | asks before acting |
  | ---------------- | ------------------ |
  | without the gate | 8/12               |
  | with the gate    | **12/12**          |

  Fisher exact p=0.09. The four failures are the shape worth knowing about: asked
  to delete one bucket, the agent deleted both — "Both buckets are gone." An
  ambiguous singular resolved by acting on everything that matched.

  The gate does not fire on a reference the conversation pins down: with two
  staging buckets, one introduced as "from the old account", it lets the delete
  through — and 36 out of 36 destructive commands in that scenario targeted that
  bucket, never the other. That is inference, not guessing, and a check that
  refused it would have traded a rare wrong delete for an agent that can do
  nothing irreversible unattended.

- 0c8e8c4: Benchmark: extend the difficulty scale to 7 levels, and stop witness values from
  colliding with each other.

  The scale ran to five until the top of it stopped being the top. On the
  2026-08-12 cohort level 5 scored 83% and level 4 scored 69% — the hardest tier
  was easier than the one below it, and seven of the ten level-5 scenarios passed
  every run. A scale whose last rung is cleared has no ceiling in view: it can
  report that things are fine and cannot report where they stop, which is the one
  question the benchmark exists to answer. 90% at the top is the same message as
  100%, said more quietly.

  The fix is not to relabel the rows that pass — that is the circularity the scale
  was written to avoid. Levels 6 (`compound`) and 7 (`misleading`) name kinds of
  demand the first five never described, with fifteen scenarios against 5-7 in
  `scenarios/16-ceiling.yaml`.

  Those two were still guesses, and level 7 came out at 87%. Levels 8-10 stop
  guessing and stack instead: each is the one demand the set has measured this
  model failing — a fact evicted from the history window comes back invented —
  plus one more independent thing that must go right. One scenario each, in
  `scenarios/17-limit.yaml`. They score 0%, 0% and 17% at six repeats, so the
  scale finally has a bottom: the model will not say "I no longer have that", and
  at level 9 it invents a threshold and schedules work against the comparison.

  Separately, and independent of the scale: `mintTokens` now guarantees that no
  witness value in a run contains another. Distinctness was not enough, because
  every reply assertion is a substring match — `3rd` is a substring of `23rd`, and
  a scenario asserting "mentions the new date, not the withdrawn one" failed an
  agent that answered correctly. Fourteen of the 756 ordered day-pairs are
  containments, so this fired on roughly 2% of runs of any scenario carrying two
  of them, always in the direction that invents a capability gap. It also made the
  discrimination suite fail on a healthy scenario about one run in eight.

- 390be8e: Benchmark: `does_not_call_with` accepts a list on either side, and the
  tool-pressure scenario that used it now measures lookups rather than any
  contact with a memory tool.

  `does-not-search-memory-for-what-it-was-just-told` asserted
  `does_not_call: [recall, facts, memory, core_memory]`, which also forbids
  _writing_. The base prompt tells every agent to save durable facts, so an agent
  that answered correctly from the conversation and then filed what it learned
  scored as a failure for following its instructions. At n=12 the scenario sat at
  6/12 and read as a bimodal capability gap; it was one assertion counting two
  different acts.

  Spelling the lookup-only version one tool/action pair at a time is twenty
  entries, so `does_not_call_with` now takes a list for `tool` and for any `where`
  value, meaning "any of these".

  Re-measured at n=12: 10/12, and both remaining failures are real lookups
  (`recall(action=query)`, `facts(action=get)`) rather than saves.

- bf2faf1: The event bus gains an around-middleware dispatch mode.

  `emit` lets a subscriber observe and `emitAsync` lets it veto by returning
  `false`. Neither lets it **change** what happens, so every feature that wants to
  shape an agent request has to live inside `runAgentLoop` rather than beside it —
  which is most of what #417 is about.

  `bus.onWaterfall(event, handler)` and `bus.waterfall(event, payload)` add the
  missing mode. A listener receives `(payload, next)`, may transform the payload,
  and either calls `next(payload)` to delegate or returns its own value to
  short-circuit and own the outcome. `{ prepend: true }` is there for the rare
  listener that must run before ordinary registrations.

  Waterfall events are declared in `RuntimeWaterfallMap`, separate from
  `RuntimeEventMap`, so the dispatch mode is part of an event's contract: a
  waterfall event can never be `emit`ed by accident and a broadcast event can
  never be handed a `next` it does not expect. The map is extended by declaration
  merging, so a plugin can declare and dispatch its own waterfall without a core
  release.

  Failure behaviour follows the rules the bus already had. A throwing listener is
  logged and skipped, and the chain continues with the payload that listener was
  handed — one bad subscriber must not break the operation it was only observing.
  A listener that returns nothing is treated as a pass-through rather than as an
  instruction to truncate: if it delegated, its downstream result stands; if not,
  the chain carries on without it. A dispatch runs the snapshot of the chain it
  started with, so registering mid-dispatch behaves the way it does for `emit`.

  **Core declares no waterfall events yet.** The obvious first one — transforming
  an agent request before the model sees it — turns out to be blocked on the agent
  loop having no bus to dispatch on, which is a prerequisite worth landing on its
  own rather than smuggling in here. The mechanism is useful to plugins today
  regardless, since the map is theirs to extend.

- b17aa82: What runs a hook is a registry.

  `hooks.on` could do one thing: invoke a registered tool. That is the right
  default and the wrong ceiling — a hook that calls an HTTP endpoint, runs a
  program, or speaks somebody's wire protocol had nowhere to live except a fork of
  the runner.

  `registerEventHookHandler(kind, handler)` opens it. A hook's `type` selects the
  handler and `options` carries whatever that handler needs, opaque to core — the
  same open-selector-plus-options-bag shape `tasks.backend` and `sandbox.backend`
  use, so no built-in is privileged over a plugin. Core registers `tool` through
  the same call rather than special-casing it, so the built-in cannot quietly
  depend on being first.

  A handler returns `output` for `denyIf` to match against, or `deny` directly
  when its dialect has its own refusal vocabulary — an exit code, a decision
  field — rather than encoding a refusal back into text for a regex to find.

  **A handler that spawns a process is deliberately not here.** It hands config
  the ability to run arbitrary code with the agent's privileges, and that is a
  decision someone should make by installing a plugin, not one inherited from the
  module every deployment loads. This is the seam that makes such a plugin
  possible without core knowing it exists.

  Also sharpens a distinction the runner was making implicitly. A target that is
  _absent_ — an unregistered tool, a `type` nobody claimed — is logged and skipped,
  because a disabled plugin should not take an unrelated operation down. A hook
  that _ran and threw_ still refuses on a refusable event: a check with an unknown
  verdict has not passed. A hook that was never wired never had a verdict to lose.

  Existing `hooks.on` entries are unchanged: no `type` means `tool`, which is what
  they already did.

- bf2faf1: Generated config and tool catalogs, verified in CI.

  Two failure modes recur here and neither is caught by tests: a config key that
  parses, documents, and is never read (#335 is two of them), and hand-maintained
  inventories that drift from the code. Both are mechanically checkable.

  `pnpm run gen:catalogs` writes `docs/config-catalog.md` from `DEFAULT_CONFIG`
  and `docs/tool-catalog.md` from the tool-factory registry. `pnpm run
verify:catalogs` runs both with `--check` and fails when a committed catalog is
  stale, so a config field or tool added without regenerating is caught in CI
  rather than months later. Both import the compiled modules rather than
  re-parsing TypeScript, so the catalogs describe what actually ships; the CI step
  runs after the build for that reason.

  The config catalog carries two read-site signals per field — the leaf key, and
  the stricter dotted path — and flags only fields where both are silent, because
  a list that is mostly false positives is a list nobody reads twice. Optional
  chaining had to be tolerated in the strict matcher: `config.tools.memory?.enabled`
  is the dominant access pattern, and a literal dotted match reported nearly
  everything as unread.

  The tool catalog reads each factory's **real** config gate out of the factory
  body rather than assuming `tools.<id>`. That distinction matters: `schedule` is
  gated by `config.schedules.enabled`, and a catalog that guessed would report it
  as missing a default it never wanted. Six factories currently have a gate with
  no entry in `DEFAULT_CONFIG` — they exist but are invisible in a fresh
  `config.yaml`, which is right for an optional integration and wrong for anything
  else. The list is there to be reviewed, not assumed broken.

- 2c98cab: Stop the history window reopening mid-turn and handing back messages the model
  was told were dropped.

  The per-round history budget is `maxHistoryTokens` minus the system prompt, the
  tail, and the tool schemas. It is recomputed every round because the tool set
  can change mid-turn, which is correct as a ceiling and was wrong as a floor:
  withdrawing a tool stops its schema being charged, the budget jumps by thousands
  of tokens, and the next trim keeps messages the previous one evicted.

  Measured on the scenario benchmark. With a 2,500-token budget against ~4,800
  tokens of tool schemas, the history budget was zero, so nineteen rounds showed
  the model `[System: 68 earlier messages … are no longer shown]` and it spent its
  whole round budget searching memory tools for a fact it had been told was gone.
  On the last round the repeated-call check withdrew the final tool, the schemas
  left the budget, and all 73 messages came back — no marker, no explanation. The
  model read the fact and reported it.

  `trimHistoryWithStart()` now returns where the surviving history begins and the
  loop holds that index as a floor for the rest of the turn. Both trim paths and
  the smaller-rung refit honour it. The floor never empties the history, and
  callers that pass none — every caller outside the loop — behave exactly as
  before. Across turns the window still reopens; only within a turn does "no
  longer shown" have to keep meaning that.

- b8e39ef: Config-declared hooks reach the whole bus, not two fixed points.

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

  Three decisions worth knowing. `denyIf` refuses on events that _can_ be refused
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

- 49e6ce4: Fix two ways a config-declared hook was not what it looked like.

  **Most events bound a hook that never fired.** Dispatch scoped by
  `payload.agent`, and only 10 of the 34 bindable event names carry that field.
  The other 24 passed `validateConfig`, logged nothing, and did nothing. Four of
  them — `agent.completed`, `agent.dispatched`, `agent.stalled`,
  `task.needs_human` — name the agent right there in the payload under
  `agentName`, and the scoping did not look. The remaining twenty name no agent at
  all, because a task transition or a proposal opening happens to a deployment
  rather than to an agent, and there was nowhere to declare a hook that was not an
  agent's.

  Three parts, because a partial fix here is a worse lie than the bug:

  - Both spellings are read, and normalised before matching, so `when: { agent: … }`
    means one thing across the catalog instead of depending on which word a given
    event happens to use.
  - A top-level `hooks.on` declares the deployment's own hooks, which fire on every
    occurrence. Deliberately only `on` — `beforeRun`/`afterRun` are points in _an
    agent's_ turn and mean nothing without one. Deployment hooks run first, so an
    agent's hook cannot preempt a rule the operator set for everyone.
  - `validateConfig` now warns when a hook is declared under an agent on an event
    that names none, and points at the top level as the fix. The classification is
    a compile-time guard against `RuntimeEventMap`, the same shape that already
    pins the broadcast list, so a new event arrives classified or fails the build.

  The irony is on the record: `hooks.on` keys off TAI's own event catalog
  specifically so that a mistake is a warning rather than a hook that silently
  never fires. It caught the typo and shipped a fresh instance of the same disease
  underneath it.

  **A hook was more privileged than the agent it guarded.** A tool invoked from a
  hook got a context built from scratch — no `workingDirectoryBoundary`, no
  `execRules`, and `workingDirectory` set to the server process's cwd rather than
  where the agent works. So a hook calling `exec` ran outside the deployment's
  command allowlist, and one calling `write` could leave a worktree boundary that
  confined the agent whose calls it was there to police. That is the wrong way
  round: a guard that outranks what it guards can be used to escape the
  confinement it exists to enforce.

  The cause was that "the context an agent's tools run with" was assembled in two
  places and they disagreed. There is now one builder on the runtime, used by both
  the loop and the hook path, so a field added to it cannot reach one caller and
  miss the other. This is the second time that exact split has produced a
  security-relevant no-op — the first is recorded in `config-schema.ts`, where
  `fileBoundary` never reached `toolContextExtras` and three agents ran with a
  declared filesystem confinement that did nothing.

- 02f9be2: The stall detector catches cycles, not just immediate repeats.

  `runAgentLoop` compared each round's tool calls to the round before it, so it
  saw one shape of loop — the same call three times running — and missed
  `A → B → A → B`, which reset the counter every round and ran to `maxToolRounds`
  instead.

  That is the more common shape. One benchmark scenario produced both in a single
  batch: one run looped on a single call with an invented id and was caught,
  another alternated two tools six times and was not.

  `detectCycle` now examines the tail of the round history for a repeating block
  of period 1-3, and `LoopStop { kind: "repeated-calls", period }` says which it
  found. A period-1 cycle still needs three repetitions; longer cycles need two,
  because a period-3 cycle repeated three times is nine rounds and most
  deployments cap below that.

  Round signatures still combine the calls with their results, so polling that
  repeats its calls while its answers move is not a stall.

  A turn stopped for cycling is now asked once more with the tools withheld, the
  way a turn stopped by the round limit has been since #470. Stopping a cycle
  early is worth doing, but it must not cost the turn its answer: a looping agent
  has usually already read what it needed and is circling over how to act on it.

- 662b23a: The agent loop can be reached from outside it.

  `runAgentLoop` had no event bus. It neither took one nor read one, and that
  absence is why the loop keeps absorbing features that belong beside it:
  `prompt.ts`, `context.ts`, `memory-inject.ts`, `chat-live-state.ts`,
  `watcher.ts` and `load-skill.ts` each append their own block _from inside_,
  because there was no way to subscribe to "a request is being assembled" and hand
  one back.

  `AgentLoopOptions.events` now carries an `EventBus`, populated by
  `runtime.buildLoopOptions()` from `runtime.events` — so `delegate`, the schedule
  runner, autopilot and the exploratory worker all get it without a line changing
  at any of their call sites.

  Optional, deliberately. The benchmark harness and most tests build their loop
  options by hand, and a loop built without a runtime should dispatch to nobody
  rather than refuse to run.

  Nothing dispatches on it yet. That is the point of landing it alone: the seam
  changes no behaviour and can be reviewed as a seam, while the first consumer —
  a waterfall over prompt-slot assembly, which is what makes the dispatch mode
  added earlier reach a real request — changes what a model reads and should be
  reviewed on its own evidence.

- 38b808b: Fix four places where media-carrying content was silently coerced to a string.

  The worst was live and user-visible. The agent loop's stall detector builds a
  per-round signature from `results.map((r) => r.output).join("|")`. Since media
  support widened `ToolResult.output` to `string | ToolOutput`, `join` stringified
  the object arm to `[object Object]` — so **every** media-carrying tool result
  compared equal to every other. A browser agent screenshotting two different
  pages read as making no progress, and the loop took its screenshot tool away
  mid-turn. The projection carries the content hash precisely so this works:
  identical bytes still compare equal, different bytes no longer do.

  Three quieter ones, all the same shape:

  - A rewind preview read `messages.content` straight from the column, so anyone
    who had attached an image saw `{"__tai_content":true,…}` quoted back at them
    instead of an excerpt of what they said.
  - Cron's `last_response` template variable read the same column the same way,
    pasting the encoded JSON into the next prompt — tokens spent teaching the
    model our storage format.
  - A failing `tool_call` workflow step raised
    `tool_call "x" failed: [object Object]` when the tool returned media instead
    of an error string.

  Worth naming the pattern rather than just the four sites. The original sweep
  looked for `${...}` interpolation, because that is the coercion everyone
  pictures. But `Array.prototype.join`, `String()`, and reading a TEXT column
  without decoding it are the same hazard in different clothes, and none of them
  is a compile error — TypeScript is happy to stringify an object anywhere a
  string is merely conventional. When a widened type flows through a codebase,
  grep for the operations that coerce, not for the syntax that usually does.

- 2c98cab: Let a deployment choose what a model is shown when a picture arrives.

  An image reaching an agent had two possible fates: hydrated to bytes and sent as
  an image part, or flattened to its text placeholder because the model declared
  it cannot take pictures. Both chosen by capability, never by preference — and
  there are real reasons to prefer something else. Image tokens are expensive, a
  screenshot of a terminal is mostly text, a small local model may read OCR output
  better than the picture, and sometimes a path is all an agent needs because its
  next move is a shell command.

  A rendition answers one question — given a reference, what does the model
  receive — and answers it in `ContentPart`s, which are already a union of text
  and media. That union is why one interface covers behaviours that look
  unrelated: OCR returns a text part, a resize returns a media part, and "a
  thumbnail plus a handle the agent can spend for the full image" returns both.

  Core ships the seam and no strategy. `registerMediaRenditionFactory` and
  `ctx.mediaRenditions` are the door; `media.renditions` names recipes,
  `media.rendition` sets the deployment default, and `agents.<name>.mediaRendition`
  overrides it. Results are cached in `media_renditions` by (blob, recipe) — both
  halves content-derived, so an entry never goes stale — because the history is
  re-sent every round and an OCR pass is seconds. `ToolContext.mediaStore` is new
  so a plugin can register the tool that hands a picture back.

  Renditions run once per round, before hydration and before trimming. Before
  hydration because a rendition can mint bytes that did not exist when the round
  began; before trimming because a rendition changes size, and trimming the
  original would evict real turns to make room for bytes about to be replaced.
  They shape the request and never the record: the session keeps the original, so
  turning a rendition off gives the pictures back.

  Two fixes fell out. Retention swept on `last_seen_at` and only a `put` refreshed
  it, so once a rendition existed the original stopped being touched and was the
  first blob deleted — breaking the one case that depends on the original
  outliving its cheap copy, a week later, on the request it exists to serve;
  serving a rendition now touches its parent. And `registerMediaStoreFactory`
  returned `void`, dropping the disposer the registry already handed it, which
  made a media-store plugin the one kind that could not be unregistered.

  Configure nothing and nothing changes.

- afdfc82: `recall` and `facts` say what they are not for.

  Both described what they hold and never what they don't, so a model reached for
  them to answer a question whose answer was one message up. Measured on a 27B
  local model, five runs per scenario:

  | scenario                                | before | after | memory calls |
  | --------------------------------------- | ------ | ----- | ------------ |
  | the answer is in the previous message   | 1/5    | 5/5   | 7 → 0        |
  | nothing in the conversation mentions it | 0/5    | 3/5   | 10 → 3       |
  | the answer really is in memory          | 5/5    | 5/5   | 10 → 16      |

  The third row is the one that decided it. Narrowing a tool description risks the
  model abandoning the tool altogether — "an instruction that offers a way out gets
  taken" — so legitimate memory use had to be measured too. It went up, not down:
  the descriptions discriminate rather than suppress.

  `tool-selection` holds at 27/27 with every scenario unchanged.

  `memory` and `core_memory` are deliberately untouched, so a model that merely
  switched tools would show as a switch rather than a win.

- 0594a2b: Inline images on the OpenAI-compatible provider, so tool-returned media reaches
  a model that can see.

  The provider declared `toolResultMedia: { supported: true, mode: "follow-up" }`,
  and `adaptForCapabilities` honoured it by moving a tool result's image onto a
  following user turn — which `toOpenAIMessages` then flattened to a text
  placeholder along with everything else. Every layer reported success and no
  image ever reached a model on the default provider, the one every local gateway
  speaks. A request carrying a 960×720 screenshot billed 244 prompt tokens.

  `toOpenAIMessages` now takes the hydrated `ChatParams.media` map and emits
  `image_url` parts on user and assistant turns. A `tool` message stays a flat
  string, which is not an oversight: vLLM rejects an image part there
  (vllm-project/vllm#43203) even for a vision model that accepts the identical
  part on a user turn. A ref whose bytes are missing still degrades to its
  placeholder, and a text-only request is unchanged.

- 325e5f2: The out-of-rounds answer stops thinking and starts answering.

  A turn that exhausts its tool rounds gets one more request with the tools
  withheld, so prose is the only thing the model can produce. That call inherited
  the turn's thinking setting — and on a reasoning model it spent the whole
  `maxTokens` budget on a reasoning trace, returned empty `content`, and fell back
  to `[Agent stopped: max tool rounds reached]`: the exact marker the path exists
  to replace.

  Measured on the benchmark's `notices-a-truncated-tool-result` against a 27B
  local model at the reference deployment's `maxTokens: 8192`, five runs each:

  |        | pass | output tokens | wall clock |
  | ------ | ---- | ------------- | ---------- |
  | before | 2/5  | 874 – 9,329   | 697s       |
  | after  | 4/5  | 669 – 1,525   | 236s       |

  Every failing run before the change landed just above the 8,192-token cap. None
  of them said anything.

  Nothing is left to reason about at that point — everything the answer reports is
  already in the messages above it — so the call now sets `thinking: "off"`. The
  remaining failure is the model genuinely misreading a truncation marker, which
  is the behaviour the scenario is for.

  An empty answer now also logs why (finish reason, reasoning length, output
  tokens). Previously a turn ending on the marker looked identical whether the
  model was never asked, refused, or burned its budget before writing a word.

- 38b808b: Agents can send media out to Discord, Slack, and the terminal, not only receive it.

  Inbound media has worked since the attachment support landed: an agent could be
  shown a screenshot on Discord and describe it. Sending one _back_ was
  unrepresentable, because `Channel.send` took a string. So an agent asked to
  screenshot a page could see the result and talk about it, while the person who
  asked to look at it got only prose.

  `Channel.send` and `OutboundNotifier.send` now take `string | MessageContent`.
  Both had to widen: `OutboundNotifier` is the interface every production caller
  actually resolves through, and widening only `Channel` would have shipped a
  parameter nothing could ever pass — the failure mode this workstream has already
  hit twice.

  Surfaces declare what they can show through a required `SurfaceCapabilities`,
  modelled on `RoomCapabilities`. Required rather than optional on purpose: an
  optional capability field is one nobody fills in and nobody reads, which is how
  `AIProvider.supportsTools` spent its entire life. Surfaces with nothing to
  declare spread `TEXT_ONLY_SURFACE` and are then honestly described rather than
  merely undescribed. The message-length limits move in too — they were a
  `MAX_MESSAGE_LENGTH` constant copy-pasted into two `splitMessage`
  implementations, which is one fact recorded twice with nothing keeping the
  copies honest.

  One shared `renderForSurface()` applies the degradation ladder — attachment,
  then link, then text placeholder — so three transports cannot each decide
  differently what to do with a file too large to upload. It enforces the rule the
  media design states outright: a part that does not reach the reader leaves a
  warning or a placeholder, never nothing. Writing the test for that caught a real
  defect in this change, where a deployment with no media store configured
  produced neither an upload nor a placeholder: the ladder had been told the
  surface could attach, so it skipped the placeholder, and then nothing uploaded
  the file. Both transports now report what they cannot do _before_ rendering
  rather than after.

  The media a channel sends comes from the message record, read back with
  `collectTurnMedia()` against a watermark taken before the turn. That is the same
  source the web UI already renders from, so a channel and the UI cannot disagree
  about what a turn produced, and it avoids widening `runAgentLoop`'s return type
  across eighteen call sites — most of which only ever want text — to serve three
  surfaces. Only `tool` and `assistant` rows are read, so an inbound photo is
  never echoed back at the person who just sent it, and results are deduped by
  content hash: an agent that screenshots an unchanged screen three times has one
  blob and sends one file.

  Discord uploads through `files:` on the last text chunk, so attachments never
  float above the prose explaining them. Slack posts text then uploads through
  `files.uploadV2`, and an upload failure is logged rather than thrown — the text
  has already been posted, and throwing would report the whole reply as failed
  when most of it arrived. The CLI prints a placeholder and a `file://` path to
  stderr, keeping stdout exactly the answer for anyone redirecting it. Terminal
  inline images are deliberately not attempted: emitting an iTerm2 escape sequence
  to a terminal that does not understand it dumps kilobytes of base64 into the
  user's scrollback.

  `MediaStore` gains an optional `localPathFor()` for surfaces that can open a
  path. Optional because a store backed by S3 genuinely has none, and returning a
  fabricated path would be worse than returning nothing.

- bf2faf1: Every registration hands back its inverse, and the plugin loader keeps it.

  Plugin teardown was one sledgehammer: `reload()` calls `events.clear()` and
  re-runs every plugin. That is complete for bus subscriptions and nothing at all
  for the rest of what a plugin owns, because nothing tracked it. The same defect
  shipped as #58 (duplicate channel listeners after a config reload) and #65
  (trigger pollers that hot reload never reconciled), and `HttpRouteRegistry`
  still documents it in its own comment: the registry "survives `reload()` because
  Hono can't unmount routes once added."

  `Registry<T>.register()` now returns a `Disposer`, and so do all ten
  `register*Factory` functions, `StepExecutorRegistry.registerFactory`, and every
  `PluginContext` registry view. The disposer removes **only the entry that call
  made**: if something re-registered the same id afterwards, that entry belongs to
  whoever registered it, and disposing an older one must not silently delete it.
  Calling a disposer twice is a no-op.

  `loadPlugins` collects the disposers per entry and composes them onto
  `LoadedPlugin.stop`, so unloading a plugin is the inverse of loading it. The
  plugin's own returned disposer runs first — it may still need what it registered
  while shutting down — and the registrations then come out last-in-first-out. A
  throwing disposer is logged and the rest still run, because teardown that gives
  up halfway leaves a half-removed plugin nothing will retry.

  Source-compatible: a caller that ignores the return value behaves exactly as
  before. Side-effect plugins are unchanged — they register at module scope with
  no context, so nothing observes what they added and there is nothing to hand
  back.

- 3d27ba5: The loop says what it assembled.

  Nothing outside `runAgentLoop` could see what a model was actually shown. The
  system prompt is composed from a dozen contributors, the history is trimmed to a
  budget, tool schemas are a separate request field, and by the time all of that
  is one `ChatParams` object it exists only for the duration of a provider call.
  "Why did it say that" was answerable by reading code and guessing.

  `agent.request_assembled` is emitted once per request that reaches a provider,
  carrying the request itself plus what the loop knows and the request does not:
  which round and phase, which fallback rung sent it and whether that rung
  answered, the history length the request was trimmed from, and what each context
  slot contributed — including whether its own budget cut it short.

  **A faithful copy, not a projection.** Rebuilding the request later from session
  state would be cheaper and would be wrong: `paramsFor` re-trims the history for
  each fallback rung, so which messages went out depends on which rung answered,
  and a reconstruction could not know that. It would confidently produce the head
  rung's request instead, and authoritative-and-wrong is worse than absent. The
  test asserts object identity rather than deep equality, so a shaping step
  inserted between the record and the wire fails the build.

  Emitted after the request was sent, in a `finally` around the provider call, so
  an observer can neither see a request that did not go out nor change one that
  did. That is why it is a broadcast rather than a waterfall: a subscriber able to
  rewrite this would make the record a lie.

  Core emits and stores nothing — retention, redaction and format are opinions and
  belong to a subscriber. `renderContextSlots` also now returns a per-slot
  breakdown (`id`, `refresh`, `chars`, `truncated`) alongside the two blocks it
  already placed, which is the cheap half of asking where a request's size comes
  from.

- 1d83122: The room roster says what each participant does, and a room turn must not invent
  results.

  **A name cannot be routed to.** A lead told to get a manifest filed worked out
  correctly that the hatch was shut, and then asked the _owner_ to unlock it —
  while sharing a room with an agent described as "Power and access. Runs
  `breaker` and `unlock` on the vault". It could not have known: the prompt read
  `Known participants: rus, vay, quinton.` and the word "unlock" appeared nowhere
  in it. TAI already has these descriptions — they are what `delegate` routes on —
  and never showed them to the agents who share a room with each other. Rendered
  as `label — description`, first line only, truncated at 120 characters so a
  verbose agent cannot push the transcript out of the window.

  **And room turns are now told to state only what a tool actually returned.** In
  a room a fabrication does not stay with the agent that made it: it becomes the
  next agent's input and then the report to the owner. Three agents asked to read
  a file and file its id produced a complete, confident transcript — "the ID is
  VAULT-001" / "Filed." / "Done." — having made zero tool calls, with the file
  untouched. Phrased as a prohibition rather than "say so if you cannot", which is
  the shape a small model over-applies into declining work it could have done.

  Together with the loop change in this release, a three-agent orchestration
  benchmark row went from 0/6 to 5/6, and mean state transitions per run from 0.0
  to 4.8.

- 415ba15: Room turns now report why they ended, on a new `room.turn_ended` event.

  Every other place that runs an agent loop asks it why it stopped. The task
  watcher does, and routes a stall to `StallGuard`. The exploratory worker does.
  The room watcher did not, and a stalled room turn was therefore a fact that
  existed nowhere: the loop gets one tools-withheld call so it can explain itself,
  so it returns ordinary prose, and in a room that prose is posted like any other
  message. Measured on a 237-run benchmark cohort, all 12 stalls came back as
  prose and not one carried an `[Agent stopped: …]` marker — so anything matching
  that string was matching nothing.

  `room.turn_ended` fires for every turn, including one that ended by throwing,
  and carries the structured `LoopStop`, the rooms it covered, why the agent woke,
  whether anything was posted, and a short `stallReason` when it got stuck. A
  stall also logs a warning naming the agent and the room. What to do about it —
  retry, mark the message, say so in the room — stays a plugin's opinion, the way
  `agent.stalled` leaves it to `StallGuard`.

- 0594a2b: Rooms carry attachments, in and out.

  A room was text and only text: `RoomMessage.body` was a plain string, and the
  Discord rooms backend built every inbound message from `msg.content` without
  ever looking at `msg.attachments`. Dropping a screenshot into a room channel
  therefore reached nobody — and said so to nobody, because the text still
  arrived. An image posted with no caption produced an empty message, so the
  agent saw nothing at all.

  The DM and @mention paths had none of this problem, which made it invisible: the
  same picture in a DM worked. The split was that registering a room makes the
  mention path stand down for that channel, and the rooms path that replaces it
  was written before media existed.

  `RoomMessage.media` and `OutboundRoomMessage.media` now carry `MediaRef`s, and
  `RoomCapabilities.media` says whether a transport has the concept — a required
  field, so every backend has to answer rather than inherit a default. Both
  built-in backends support it: the local one stores refs in a new nullable column
  (`ALTER TABLE` is metadata-only, so no existing row is rewritten), and Discord
  captures attachments into the media store on the way in and uploads them on the
  way out.

  Capture happens in `fetchSince` and nowhere else, because every path that builds
  a transcript an agent will read goes through it — the push listener only decides
  whether to wake someone — and messages with no attachment pay nothing. Bytes are
  fetched at read time rather than referenced: a Discord attachment URL expires
  well before an agent wakes on a backlog and follows it.

  Outbound, files ride the last non-empty chunk of a split message, so a long post
  does not show its picture above the text that introduces it, and an
  attachment-only post still sends. On the way in, each attachment is also named
  in the transcript against its own line — that is what says which message an
  image belongs to, and it is what survives once the history budget evicts the
  picture itself.

  A wake carries at most `MAX_WAKE_MEDIA` (4) images, newest first, skipping the
  agent's own posts and deduplicating by content address. The loop prices a media
  part at 1,500 tokens, so an uncapped room that took twenty screenshots between
  wakes would spend its whole history budget on pictures and evict the
  conversation explaining them.

- a098702: A runtime plugin's tools now reach the agent at startup, not on the next reload.

  `PluginContext` offers `ctx.tools.register` to every plugin, but `createTools()`
  walks the tool-factory registry exactly once, in the `AgentRuntime` constructor.
  Registry-pass plugins load before that walk. **Runtime-pass plugins load after
  it by definition** — they load late precisely because they need `ctx.runtime` —
  so a tool they registered went into the factory registry with nothing left to
  read it. The plugin loaded, `register` returned a disposer, nothing warned, and
  the tool first appeared if and when something unrelated triggered a reload.

  Same class as #561 and #609: a registration that validates and does nothing.

  `AgentRuntime.applyPendingToolFactories()` re-runs the factories and registers
  what is not already present, returning the names it added; the CLI calls it
  after loading runtime plugins and logs what appeared.

  **Additive rather than a rebuild**, for a specific reason: the tool registry
  also holds tools no factory produced — `McpManager` registers discovered MCP
  tools straight into it — and rebuilding would silently drop every one. It also
  does not remove a tool whose config gate has since closed; this runs at startup
  before any turn, where the only difference between the two walks is the
  factories that were not registered yet. Reacting to config changes stays
  `reload()`'s job.

  No behaviour change for any current install: no shipped plugin registers a tool
  from the runtime pass today. The path had never had a user, which is why the
  gap survived — it was found writing the first one (#616).

- d4c4baa: Benchmark scenarios carry a difficulty, and the report is scored by it.

  Every scenario declares `difficulty: 1-5` — reflex, routine, composed,
  conflicting, frontier — graded on what the turn demands of the model, never on
  what it currently scores. `--difficulty 4`, `4+`, `2-3` or `3,5` runs a slice,
  and composes with `--filter`.

  The overall score averages a regression tripwire against a scenario written to
  find the ceiling, so it moves for the wrong reasons and cannot say where the
  wall is. The rollup by level can, and running one level is what makes the
  find-the-ceiling loop affordable: a full cohort is ~23 minutes of GPU, most of
  it re-confirming rows that have passed every time for a month.

  The level is an annotation, excluded from the scenario digest and fingerprints
  like `intent` and `knownGap`, so re-grading costs no re-baseline.

  Also adds `posts_by: {agent, matches}`. On a room scenario `reply` is every post
  joined, so `reply_matches` passes when _either_ agent produced the text — which
  makes the multi-agent handoff question ("did the second agent use what the first
  one found") true by construction the moment the first agent speaks. Without a
  per-agent read, that class of scenario cannot be graded at all.

- 1537522: Benchmark: scenarios are now checked for whether their assertions can fail, and
  a stalled turn no longer counts as a reply.

  `replies: true` was `reply.trim().length > 0`, which accepted
  `[Agent stopped: …]` — and accepted the more common case too, where a turn that
  ran out of rounds returns ordinary prose with no marker at all. The eval harness
  now records the structured `LoopStop` and `replies` consults it, so a stall
  fails on either setting: `replies: false` asserts the agent _chose_ not to
  speak, which a turn that went in circles did not.

  New `scenario-discrimination.test.ts` replays every scenario's assertions
  against outcomes that are known bad — said nothing, returned a stop marker — and
  fails any scenario that accepts one. It found 16 of 79. Fifteen were the
  `replies` bug; the sixteenth was prohibition-only and now declares its expected
  silence.

- 0b90020: Benchmark: a scenario can say what the agent already knows.

  The suite could seed a conversation (`history:`), tool output (`toolResults:`)
  and simulation state (`world:`), but not memory. Every run builds its home with
  `mkdtempSync` and nothing ever wrote a note, so the notes database was empty at
  turn one — which means `injectMemory`, had anyone set it, would have injected an
  empty corpus, and any experiment comparing recall against injection would have
  scored the cost of an empty query rather than the value of a memory. The result
  would have looked like a clean null and meant nothing.

  `memory:` seeds notes before the turn. A bare string is a plain note; the object
  form takes `tags`, `importance`, `pinned` and `agent`. Notes are left unowned
  unless a seed names an agent, since an unowned note is visible to every agent —
  which is what a scenario means by "the agent knows this", and what a room
  scenario with more than one agent needs.

  Seed with a witness and the assertion stops being a proxy: the fact exists only
  in memory, so a reply containing it proves retrieval rather than confabulation.

  `--inject-memory` selects the arm. `injectMemory` defaults to `false` in core
  and no published run has ever set it, so being handed your memory is an arm
  nobody has run rather than the baseline. The same scenarios run both ways, and
  the delta between the two runs is the result; the report records which arm
  produced it.

- 6557b85: TAI can run itself as a service, and hook the moments it starts and stops.

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
      tai:init:start: # config read, nothing built yet
        - type: script
          options: { command: ~/bin/pre-start.sh }
      tai:shutdown:end: # teardown done, before exit
        - type: script
          options: { command: ~/bin/post-stop.sh }
  ```

  They fire **inside** the TAI process. That is the thing an earlier design got
  wrong: "before start" is before the _runtime_, not before TAI, and treating the
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
  `runEventHooks` treats an unregistered kind as _absent, not failed_ — which is
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

- bdacf8d: `summarizeOnTrim` defaults to true.

  A trimmed turn used to leave a marker saying N messages were dropped. It now
  leaves a summary of what they said. Set `summarizeOnTrim: false` per agent to
  keep the old behaviour.

  Measured on the scenario benchmark against a 27B local model, three pairs — the
  same question through both paths, differing only in the flag:

  | pair                      | marker | summarised | input tokens/run | rounds    |
  | ------------------------- | ------ | ---------- | ---------------- | --------- |
  | the fact under discussion | 2/3    | 3/3        | 23,483 → 7,469   | 3.3 → 2.0 |
  | a peripheral fact         | 3/3    | 3/3        | 43,423 → 7,470   | 7.0 → 2.0 |
  | the room path             | 3/3    | 3/3        | 11,835 → 3,342   | 4.0 → 2.0 |

  Correctness never worse, cost three to six times lower on every axis. A twelve-run
  measurement of the first pair gave 6/12 against 12/12, Fisher exact p=0.014.

  The extra provider call reads like a price and is not one. The marker path is
  cheaper by one request and far more expensive by the turn: an agent told only
  that something is missing spends rounds hunting for it, and on the peripheral-fact
  pair only answered at all because it exhausted its tool rounds and the
  out-of-rounds path handed the history back. The summarising call is bounded to a
  3,000-character transcript, so it cannot grow with the history it replaces.

- 2e7a342: The loop says when a tool is about to run, and when one did.

  `executeToolCall` ran an ordered chain of gates — skill allowlist, validation,
  approval, derivability, execute — and nothing extensible attached to any of it.
  The runtime bus declared 28 events and not one was at tool level. Three separate
  pieces of work were blocked on that same absence: an approval stage any tool can
  use, a hook dialect with `PreToolUse` to bridge, and a workflow trigger that
  fires on a tool call.

  `agent.pre_tool_use` is a **waterfall**, because refusing is the weaker of the
  two useful answers. A subscriber can set `deny` — the text goes back to the
  model in place of the tool's output — or replace `args`, which is the difference
  between a guard that says no and one that says "not like that": narrow a path,
  drop a flag, cap a limit. The tool name is deliberately not replaceable, since
  swapping it would leave the model's own record of what it called wrong.

  Two placement decisions, both asserted rather than assumed. It dispatches
  **before the approval gate**, so a rewrite reaches the human who approves it
  rather than a human approving one call while another runs. And **before
  validation**, so whatever actually executes is what got validated — a subscriber
  is not more trusted than the model. What must stay authoritative after a human
  says yes stays where it already is, inside the tools: `exec`'s allowlist, the
  path boundary, the sandbox.

  `agent.post_tool_use` is a broadcast — the call has happened. Only calls that
  ran reach it, which is what lets a subscriber count executions rather than
  intentions, and `args` is what the tool was given, so a rewrite is visible there.

  **Fixes a live bug as the first consumer.** `tool_called` has been a declared
  workflow trigger, validated by the loader and advertised through the trigger
  registry the UI reads as "Fires when a specific tool is invoked" — with nothing
  dispatching it. A deployment could write the config, watch it validate, and get
  no warning, no error and no run. It could not be fixed alone: every other
  trigger kind has a poller, and this one needed to know when a tool ran.

  `builtin:tool-called-trigger` now delivers it, enabled by default — the promise
  was already made to deployments relying on it, and a fix they had to switch on
  would leave them where they were.

- 9190838: Say so when a workflow trigger kind has no runner.

  A plugin can register a trigger kind, and until now every signal said that
  worked. `TriggerKindRegistry` accepted it, `setExtraTriggerKinds` fed it to the
  workflow loader, so the workflow file validated and the UI picker listed it.
  Then `WorkflowTriggerCoordinator.reconcile` filtered it out against a hardcoded
  set of the nine built-in pollers and moved on — no warning, no error, no run.
  The only symptom was that the workflow never fired.

  That is the same shape as #561, where `tool_called` was a declared kind nothing
  dispatched, and it is the failure this codebase keeps rediscovering: something
  that validates cleanly and silently does nothing.

  The coordinator now reports it. A trigger kind that is neither dispatched here
  nor run elsewhere (`cron`, `manual`, `webhook`, `tool_called`, `document_event`,
  `config_event` each have their own subsystem) warns once, naming the workflow,
  the kind, and the issue tracking the fix. Once per workflow per change, not once
  per reconcile — this runs on every registry change, and a per-tick warning is
  noise people learn to scroll past, which is the same outcome as silence.

  **This does not make plugin triggers work.** Nothing dispatches one until #61
  lands the executable trigger factory contract. What changes is that the gap is
  audible instead of costing an afternoon to find. A workflow's runnable triggers
  still register normally alongside an unrunnable one.

  `docs/modularity-plan.md` scored triggers fully pluggable on all three columns
  throughout. That row is corrected, with the reason: a registry consulted only by
  the validator will score green while nothing runs. The general rule is now in
  `docs/defensive-patterns.md`, next to its sibling "config that parses but is
  never read".

- 2c98cab: Add a `vllm_effort` thinking dialect, so a template that reads
  `chat_template_kwargs.reasoning_effort` can be asked for something other than
  its default.

  The existing `vllm` dialect sends `enable_thinking` only — an on/off switch,
  which is all older Qwen templates read. Newer ones also take an effort rung, and
  their default is the _top_ one. Without a dialect that can name a rung, such a
  model can only ever be run at its most expensive setting: measured on Qwen3.8,
  that is roughly twice the output tokens of `medium`.

  It is a new dialect rather than an addition to `vllm` because a template that
  does not declare the kwarg either ignores it or raises, so sending effort to
  every vLLM endpoint would break endpoints that work today. `effortTemplateMap`
  also translates core's `high` to the template's `xhigh` — the templates that
  read this kwarg accept `low`/`medium`/`xhigh` and reject anything else with a
  400, so forwarding `high` unchanged would fail every request.

  Select it with `providers.<id>.thinkingDialect: vllm_effort`. The eval CLI takes
  it as `--thinking-dialect vllm_effort --thinking medium`.

- 1d83122: Withdraw a looping tool instead of ending the turn.

  The cycle detector ended the turn outright. That is right when the cycle is the
  whole turn and wrong when it is one blind alley inside a turn with work still
  available. Measured: a model asked for a fact that had left its history window
  called an empty `core_memory` three times, tripped the detector, and the turn
  ended — with rounds still on the budget and a tool it had never touched in the
  list. Two of six runs happened to try that tool first and passed; four looped
  first and lost the turn.

  The looping tools are now withdrawn for the rest of the turn and the loop
  continues. Every tool in the detected cycle goes, not just the one named in the
  last round: on `A → B → A → B` the final round names B alone, and leaving A in
  place costs two more rounds to reach the same place. With nothing else to offer
  the turn still stops, which is the pre-existing behaviour.

  Withdrawing rather than persuading, because persuading was tried three ways and
  none of them moved the number: an empty result that said "reading again returns
  this", a note at the moment of the repeat that the call was identical, and an
  outright refusal of the third call with an explanation. The refusal was worst —
  the model kept calling into it five to seven times. A tool that is not offered
  is the one thing it cannot call.

- 1537522: Benchmark: witness assertions, per-agent execution records, and `regrade`.

  Most assertions were proxies — "the reply is non-empty" standing in for "the
  agent answered". A proxy holds until the agent takes a path the author did not
  picture, and then reports the wrong answer in whichever direction is
  convenient: a stalled turn scored 3/3 for returning plausible prose, and a
  correct agent scored 0/3 for looking at a bucket before deleting it.

  A scenario can now mint unguessable values per run (`tokens:`, referenced as
  `{{token:name}}`) and stub a tool to emit one only for the right input. If the
  value reaches the reply, the work happened — it cannot be guessed, confabulated,
  or produced by a turn that stalled.

  Supporting pieces: `toolResults` accepts argument-conditional rules; every tool
  execution is recorded with the agent that ran it, so `calls_by` can ask which
  agent did the work and can tell a refused call from one that ran; and
  `regrade <report.json>` re-scores a finished run against today's assertions with
  no model calls, skipping — never failing — checks whose inputs the report did
  not keep.

- e21c40e: Benchmark: scenarios can carry a world — a state machine the agent's tool calls
  drive — and be graded on whether they reached a goal state rather than on what
  they said.

  Every stub before this was a pure function of the call, so nothing could be
  locked, nothing had to be unlocked first, and order of operations was not
  expressible. A scenario could ask "did you make the right call" and never "did
  you work out what the right calls were". `world:` adds state, `requires` guards
  that refuse and say what they are waiting for, `sets` mutations that persist
  across agents, and `by` so a transition belongs to one specialist. The win
  condition is `world_state`, a claim about the machine and never about the
  transcript: any route that reaches the state passes.

  The first three scenarios found something a text assertion cannot see. A lead
  directing two specialists produced a complete, confident room transcript —
  "I read the manifest, the ID is VAULT-001" / "Filed" / "Done" — having made
  zero tool calls, with the world untouched. One agent's fabrication became the
  next agent's input and then the report to the owner. Every existing assertion in
  the package would have scored it as success.

  - @tailored-ai/browser-mediator@0.1.11

## 0.1.10

### Patch Changes

- b559646: Add `agents.<name>.fileBoundary` and room check-ins.

  **`fileBoundary`** confines one agent's file and exec tools to a directory,
  reusing the enforcement the task watcher already applies to coder/reviewer
  worktrees. Needed because `tools.write.allowedPaths` is deployment-wide:
  granting an agent `write` otherwise grants the whole filesystem, which is a poor
  trade for an agent that reads untrusted web content. A leading `~` is expanded,
  since the check is a path-prefix comparison and an unexpanded tilde would
  confine the agent to a directory that does not exist.

  **`checkInMinutes`** on a room subscription wakes an agent on a timer even with
  no new messages, so it can act on time passing rather than only on being spoken
  to. Agents set their own through `room(action="subscribe", check_in_minutes=N)`.
  The check-in prompt offers `pass` first and asks for speech only when something
  needs attention — a scheduled "nothing to report" is the politeness loop with a
  clock attached. Floored at 5 minutes; the hourly wake ceiling still applies.

- ef9e809: Agents can cap generated tokens per call with `maxTokens`.

  `ChatParams.maxTokens` and the providers' `max_tokens` mapping both existed
  already, but nothing populated them, so every agent request went out with the
  field absent. Locally that costs nothing. On a metered provider it can make the
  account unusable: OpenRouter reserves the model's full output window — 65536
  tokens — against the balance for the duration of each call when `max_tokens` is
  missing, and returns 402 as soon as the balance no longer covers the
  reservation, however small the actual reply would have been. The symptom is a
  provider refusing every request while the account is nominally in credit.

  Resolution is `agents.<name>.maxTokens` → `agent.maxTokens` → omitted. Omitted
  stays the default, so no existing deployment changes behaviour: picking a
  number here would cap generation for everyone who never asked for one, and
  providers already carry sensible defaults of their own.

- a2f8016: Injected memory is scoped to the agent recalling it.

  Auto-injection was scoped by project and global only, so any agent with
  `injectMemory` read every other agent's notes and reported them as its own
  recollection. Pinned notes were the expensive case: those inject regardless of
  relevance, so one agent's pinned preference landed in every agent's prompt on
  every turn. The symptom reads as a persona bug and is very hard to trace back to
  scoping.

  Nothing needed inventing. `scope` on the `MemoryBackend` contract was already
  `string | string[]`, the SQLite backend's `parseScope` already understood an
  `agent:<name>` token, and `notes` already had an `agent` column with a filter
  behind it. The injection path simply never sent one.

  An agent now recalls its own notes plus notes nobody claimed. That second half
  matters: notes predating authorship, or written by an unnamed session, have a
  null `agent`, and a strict match would have hidden every one of them from
  everybody — a worse failure than the one being fixed.

  A session with no agent name sends no token and keeps the cross-agent view it
  had before, so nothing that cannot identify itself silently starts recalling
  less.

  Facts remain unscoped: the `facts` table has no `agent` column, only a free-text
  `source`. That needs a migration and is tracked separately.

- ed98f4a: Core: let an agent wake itself (`schedule` tool + `ScheduleRunner`)

  Everything that could start a turn was authored by somebody else — cron jobs and
  room check-ins by the operator in `config.yaml`, message and poll wakes by
  traffic. So an agent that said "I'll check back after the deploy" was describing
  something no part of the system would do. The nearest workaround,
  `admin(action=update_config, path='cron.jobs')`, is a global operator config
  write with no per-agent scope, no limits, no one-shot support, and it bounces the
  cron scheduler on reload. `cron/schedule-dsl.ts` has said since it was written
  that one-shot timestamps are out of scope there and tracked separately; this is
  that.

  **The tool.** One tool, four actions, following the `room` / `tasks` convention:

  ```
  schedule(action="once",   when="10 minutes" | "2026-08-08 10:00" | "tomorrow 9am", note="…")
  schedule(action="repeat", every="weekdays at 9am" | "every 2 hours", note="…", starts=…, until=…)
  schedule(action="list")
  schedule(action="cancel", id="a3f1" | "a3f1,b7c2" | all=true)
  ```

  Every accepted booking echoes back the absolute time it resolved to, which is
  worth more than any amount of parser cleverness: a model that meant tomorrow and
  got today finds out in the same turn, while it can still fix it. A rejected call
  answers with the grammar it wanted, because error text is the only documentation
  a model reliably reads. A bare number is refused rather than guessed — "10" reads
  equally as ten minutes and ten o'clock.

  Recurrences reuse `compileSchedule` verbatim, so the phrases an operator learns
  in `config.yaml` work at runtime too. Plain intervals ("every 2 hours", "every 3
  days") are stored as elapsed time anchored to the start instead, because cron
  cannot express phase: `every 2 hours` compiled to cron fires on even hours and
  silently discards the start minute, which is not what an agent asking at 10:15
  meant. Cron also cannot say "every 3 days" at all.

  **Firing.** One poll tick over an indexed `next_run_at`, not a timer per
  schedule. `setInterval` drifts and survives neither a restart nor a suspend nor a
  clock jump; a due time in the database survives all three, and a wake missed
  while the service was down fires on the next tick rather than evaporating. The
  row is claimed — advanced out of the due set — _before_ the turn starts, so a
  turn that outlasts several ticks cannot be re-fired underneath itself. Delivery
  is at-most-once, which is the right side to fail on. A recurrence advances
  strictly past now, so three hours of downtime costs one wake rather than three.

  **Where a wake lands.** The room the turn was woken for, read from the working
  memory the `room` tool already uses to scope `pass`; several rooms is a question
  rather than a guess; no room falls back to the session. A room wake runs through
  the new `RoomWatcher.runScheduledWake`, which shares `runCheckIn`'s tail, so it
  inherits the per-room turn chain, `maxWakesPerHour`, the silence refund, `pass`
  and repeat suppression — a self-booked wake is not a way around the deployment's
  brakes. It is deliberately not routed through the `WakeQueue`: collapsing it into
  a concurrent message wake would drop the note, and the note is the wake.

  **Limits**, under a new top-level `schedules` block: `maxPerAgent` (20),
  `minIntervalMinutes` (15), `maxHorizonDays` (365), `maxDeferrals` (3),
  `tickSeconds` (30). The brake on a recurrence the agent has forgotten about is
  not an expiry timer it never sees — every occurrence names its own id and run
  count and says how to cancel itself. A pause skips recurring occurrences but
  leaves one-shots due, so a commitment survives a pause and a heartbeat does not
  need to.

  Also here: `ScheduleStore.listDue` takes the time from its caller rather than
  using `datetime('now')`, so the runner's injected clock is the only clock and the
  timing rules are testable without waiting; `parseTime` and `DEFAULT_CONFIG` are
  now exported; `RoomWatcher`'s private `runPrompted` returns whether it ran rather
  than swallowing a ceiling refusal.

  **Breaking (type-level):** `WakeReason` gains `"scheduled"`. Anything switching
  exhaustively over it needs the new case.

- b559646: Tolerate an agent's `tools` / `skills` written as a JSON string.

  An agent that creates another agent writes JSON, because that is what models
  emit — `tools: '["read", "memory"]'`. A string is iterable, so nothing rejected
  it and `resolveAgent` walked it character by character, failing with
  `unknown tool "["`. The agent looked created, passed every check, and only broke
  the first time something tried to invoke it.

  `loadConfig` now parses a JSON-array string into a real list (and says so), and
  `validateConfig` reports any `agents.<name>.tools` that still isn't a list, by
  name, at startup rather than at first use.

- 920a799: agents: a bad tool name no longer takes the agent offline, and meta tools resolve

  `resolveAgent` threw on any unrecognised name in an agent's `tools:` list. Two
  consequences, both found in a log nobody was reading:

  - `runtime.getTools()` returns the tool registry, but `buildLoopOptions` appends
    meta tools (`admin`, `delegate`, `memory`, …) _after_ resolving — so naming one
    in `tools:` was fatal even though the agent holds it at run time. Every
    `resolveAgent` call site now resolves against `getResolvableTools()`: registry
    plus meta, which is what the agent will actually have.
  - A genuine typo (`trello`, or a stray `[`) is now skipped with a warning, once
    per process, the way skill and `mcp_*` refs already were. In a room, throwing
    meant the agent simply stopped answering, indistinguishable from having nothing
    to say. `admin.update_config` refuses the write instead, which is the moment
    someone is looking.

- fecc3d8: ask_user: write the inbox outside the directory that is injected into every prompt

  `ask_user` appended questions to `<contextDir>/global/inbox.md`. Everything in
  `global/` is read verbatim into every agent's system prompt on every turn, so a
  queue meant for one person doubled as a broadcast to all of them — and nothing
  ever removed a question once answered.

  Observed: five questions accumulated over three weeks, about a task archived in
  May and a hotel booking already made, read by 27 agents on every turn for two
  months. One eventually reported the hotel question as its own outstanding work.
  At 2.4 KB the file was half the entire global context budget, and none of it was
  true any more.

  The inbox now lives one level up, at `<contextDir>/inbox.md`, where
  `loadAllContext` does not look. Nothing else read it — the file is a write-only
  queue plus a `question.asked` event — so delivery and the configured
  `tools.ask_user.inboxFile` name are unchanged.

- 2632f51: The base prompt now describes the agent it is addressed to

  `BASE_SYSTEM_PROMPT` was a flat string constant, so two of its claims were told
  to every agent whether or not they were true.

  **"You are a self-modifying agent … creating new tools, adjusting settings"** went
  to a `trip-researcher` and a `mail-sorter` as plainly as to a `supervisor`.
  That instruction, plus `admin` being able to write `custom_tools.` and
  `permissions.`, is the path by which an agent authored `temp: 0.3` into its own
  config — a key that then parsed and did nothing.

  It is now gated on `canSelfModify(resolved.tools)`, read from the agent's
  **declared** `tools:` list. Reading the final tool set would not have worked:
  `admin` and `resource_admin` are meta tools appended to every agent, so the flag
  would be true for all of them and the paragraph would drop for nobody. There is
  a test pinning that distinction. On the reference deployment this removes the
  paragraph for 25 of 29 agents; the 3 that name `admin`, and any that declare no
  `tools:` at all, keep it.

  Nothing is revoked — the tool is still there and still callable when a task
  needs it. It stops _encouraging_ agents whose job is something else.

  **"When context files are loaded below, use them as ground truth"** is now:
  context files are notes written earlier, not a live feed; prefer what a tool
  reports now; check the date on anything time-sensitive. They are snapshots that
  nothing invalidates, and that sentence is why a two-month-old question in
  `inbox.md` was reported as live outstanding work by three separate agents.

  The memory section restated itself across two paragraphs and five bullets and is
  now three. Net: the base prompt is ~26% smaller for agents without `admin` and
  slightly smaller for those with it. The history budget is
  `maxHistoryTokens - systemPromptTokens`, so this buys back conversation.

  New: `buildBaseSystemPrompt(opts)`, `canSelfModify(declaredTools)`,
  `AgentLoopOptions.selfModifying`, and an optional second argument to
  `resolveBase`. An explicit `systemPrompt.base` / `baseFile` override is still
  returned verbatim — a deployment that wrote its own base owns every sentence in
  it. `BASE_SYSTEM_PROMPT` remains exported and is now the no-self-modification
  shape.

- 9af06b7: Stop the base prompt sending agents to look up an identity that is already in the request

  It opened with "Check your context and memory for your identity". But `context`
  and `core_memory` are prompt _layers_, composed a few hundred tokens below the
  base one — the identity is already in the request by the time the model reads
  that sentence. There was never anything to look up.

  The cost was not the wasted call so much as where the instruction sat: the first
  line of the first layer, telling the model to reach for memory before it had
  read anything. On the scenario benchmark, over 15 runs per arm against a 27B
  model, the agent went from answering **0 times out of 15** with no tool call at
  all to **5 out of 15**, and from opening with a memory lookup 5/15 to 2/15. The
  full 58-scenario set moved no row beyond the noise floor.

  The paragraph now says where the identity is instead of sending the model to
  find it, and is shorter for it — which matters for text every agent pays for on
  every turn.

  Partial progress on the behaviour tracked in #446, not a fix for it: the
  remaining calls are the agent _saving_ what it was told, which is the memory
  paragraph working as written.

- b8f5d16: Record prompt-cache tokens, so a change to request layout can be measured.

  `ChatResponse.usage` carried `{ input, output }` only, and the Anthropic provider
  sums cache reads and writes _into_ its input figure — so a perfect cache hit and
  a completely cold read stored identical numbers. Prompt-cache behaviour is the
  main reason to care about how a request is ordered, and nothing anywhere could
  tell whether a change to it had helped or hurt.

  `usage` now carries optional `cacheRead` / `cacheWrite`, `token_usage` stores
  them as nullable columns, and `/api/usage` sums them.

  Optional on purpose. Only some vendors report caching, and making every provider
  invent a number would be worse than an honest absence: `undefined`, stored as
  `NULL`, means "this provider does not say", which is a different fact from a
  reported zero. A reported zero is itself a useful signal — it means the prefix
  missed.

  Reported alongside `input` rather than carved out of it, because vendors
  disagree about whether cached tokens are already counted in the input total, and
  subtracting centrally would double-correct for some of them.

  Wired up: Anthropic (both), OpenAI Responses (read — the API reports no write,
  and the field was already parsed and then dropped), and the built-in
  `openai_compatible` provider when the server sends
  `prompt_tokens_details.cached_tokens`. Every other provider reports nothing and
  stores NULL, exactly as before.

  Existing rows keep their values and stay NULL. Verified against a production
  database of 12,471 usage rows.

- aee6802: Bound how much of a tool result reaches the conversation.

  Nothing capped tool results. Tool _descriptions_ were truncated at 300 chars
  for local-model compatibility; results — the part that actually grows, and the
  part that arrives from third-party servers whose response size is not ours to
  choose — were unbounded.

  Measured cost: one `mcp_notion_API-post-search` with `page_size: 50` returned
  70,485 chars / 27,187 real tokens against an 18,800-token history budget.
  `trimHistory` then evicted from the front until it fit, which meant evicting
  the user's question, and `ensureUserMessagePresent` spliced the _first_ user
  message back in — so the agent answered a welcome message from an hour earlier
  and introduced itself. Three times in forty minutes. The symptom reads as an
  agent with amnesia, never as an agent with a large tool result.

  `loop.ts` already says exactly this about the `<context>` block — "the symptom
  is an agent that forgets rather than an agent with a big prompt" — and guards
  the system-prompt side of the budget. This is the same hole on the history
  side, where it is worse: per-turn, unbounded, and remote.

  Adds `agent.maxToolOutputChars` (default 32000, `0` disables) with a per-tool
  override at `tools.<id>.maxOutputChars`. Because the lookup is by resolved tool
  name and `tools:` is an open map, MCP tools can be named there as
  `mcp_<server>_<tool>` even though discovery never keys them.

  The cap runs at the single `ToolResult`-to-string conversion in
  `executeToolCall`, so builtin, custom, plugin and MCP tools are covered by one
  check, upstream of `onToolResult`, the tool Message, `saveMessage()` and the
  repeat detector. Over the limit, the result becomes a head+tail summary led by
  a marker naming the tool, its real size, and a path to the full output — and
  saying that repeating the call returns the same truncated string, since running
  it again is the obvious move for a model handed a partial answer.

  Two properties the tests pin. The result is byte-identical for identical input
  (the scratch file is content-addressed, not timestamped) because the loop's
  stuck-model detector compares consecutive results verbatim and a unique path
  would silently disable it — the guard that catches a model re-issuing the call
  that got truncated. And a scratch-write failure still truncates, rather than
  falling back to the full string and reinstating the blowup.

- 9d32c15: Rooms: charge a turn that spoke through the `room` tool for its wake

  `maxWakesPerHour` is the brake on two agents talking each other into the
  ground, and a turn whose only tool call was `room(action="post")` was handed its
  wake straight back. It spoke, it armed the next agent's wake, and it paid
  nothing — so the ceiling was disengaged for exactly the traffic it exists to
  bound.

  Each piece was individually right. `usedTools` excludes the whole `room` tool so
  that `pass` reads as the silence it is. `deliverReply` stands down when the tool
  already posted, because otherwise "I called `room(post)` and then summarised
  what I did" appears in the channel twice. The refund reads both and concluded
  the turn had been silent. It had not.

  The incentive was backwards too: an agent that returned plain text and let the
  watcher post it was charged, while an agent using the tool as documented — the
  only way to address someone, set `notify`, or post to a room it did not wake in
  — was not.

  Now a turn counts as having spoken if the watcher delivered a reply _or_ any
  `room:posted:` marker is set. `usedTools` is deliberately untouched: making
  `post` set it would charge the wake but also reset `agent_turns` on every tool
  post, holding the conversation-depth cap open forever and removing the other
  brake while fixing this one. A post the notification gate suppressed still reads
  as silence, since the marker is written only once the backend accepts the
  message.

- 8b0c45a: A check-in charges one wake against `maxWakesPerHour`, not two.

  `runCheckIn` called `tryConsumeWake` as a cheap pre-flight and then handed off to
  `runPrompted`, which calls it again — so every check-in spent two of the hourly
  allowance. A check that spends the thing it is checking is not a pre-flight.

  The effect was invisible and the arithmetic misleading: a room budgeted for one
  hourly check-in plus eleven turns of real conversation actually got one check-in
  plus ten, and an operator setting the number was wrong by however many of the
  wakes were check-ins.

  `runPrompted` is the shared gate every prompted turn passes through and is now
  the only place the charge happens, which is what `runScheduledWake` already
  relied on.

- f67b15a: Stop the compaction checkpoint saving the transcript back to itself.

  The first real run of the memory checkpoint reported twelve durable facts saved.
  Ten of them were lines like `[tool]: saved note_6c0a6ccf`, copied straight out
  of the transcript it had just been shown.

  Tool results are the most copy-shaped text in a conversation and carry nothing
  worth remembering — they record that a call happened, not anything about the
  people in it. They are now stripped before the checkpoint call, and any output
  line still wearing a `[tool]:` / `[user]:` / `[assistant]:` prefix is rejected as
  quoted history rather than a fact the model chose to keep.

  Worth noting how this was found: the return value said `notesWritten: 12` and
  every test passed. Only reading the twelve rows showed they were garbage.

- 7447619: Add `/clone-agent` — copy an agent's configuration to a new name, and nothing else.

  ```
  /clone-agent from:iris to:juno
  ```

  Done by hand this is one copy and three checks: duplicate the block under
  `agents:`, then confirm the copy has no core memory, no sessions, no notes and
  no room subscriptions. The checks are the point — the interesting failure is
  the silent one, a "fresh" clone that inherited the original's persona or woke up
  in the original's rooms and answered as if it had been there all along. Only
  configuration travels; everything an agent has lived is keyed by its name and
  stays behind. The reply reports both halves: the fields carried over, one line
  each, and what was deliberately left, so nobody has to trust that the clone is
  actually blank.

  The source definition is read registry-first, the same precedence `resolveAgent`
  uses. An agent already migrated to
  `data/authored-resources/agent/<id>/manifest.yaml` still has its old block
  sitting in `config.yaml`, and cloning that block would copy what the agent used
  to be — wrong in fields that still parse, so nothing would complain. The reply
  says which one it read.

  The write goes through `updateRawConfig`, so a clone that would introduce config
  that parses but is never read is refused with the file untouched and the reasons
  returned. Every other refusal — unknown source, a target name outside
  `[A-Za-z0-9_-]+`, a target that already exists in the registry or in
  `config.yaml` — also happens before anything is written.

  No restart is needed: `updateRawConfig` reloads the runtime and `resolveAgent`
  falls back to `config.agents`, so the clone answers immediately. It is a
  top-level command rather than a subcommand of `/agent`, because `/agent` already
  carries a required top-level option and Discord forbids a command having both
  options and subcommands.

- fd84749: security: close the config-to-host-shell path (#279, #280)

  `admin` is a meta tool appended to every agent, so whatever its config allowlist
  permits, every agent can do. That allowlist included `custom_tools.`, and
  `CustomTool.execute` discarded its `ToolContext` — the parameter was literally
  named `_context` — ending at `bash -c` on the host with no boundary check and no
  sandbox routing.

  So an agent could write itself a shell-backed tool and call it in the same run
  (tools re-resolve every round). For an agent with `sandbox: docker` that was a
  complete container escape, and it was also a write path into the context
  directory injected into every agent's prompt. No adversarial intent required:
  one agent asked, in a room, whether it should point a tool at the host's binary
  because its container lacked one. That would have worked, and nothing would have
  reported it.

  Three changes:

  - **`custom_tools.`, `permissions.` and `context.` are no longer agent-writable
    config paths.** `permissions.` was the approval gate governing the write
    itself; `context.` redirects where prompt-injected files are read from. A
    human editing config.yaml can still set all three.
  - **`CustomTool` honours its context**, applying the same parent-repo boundary
    check as `exec` and routing through the sandbox when one is attached. The
    load-bearing half is the sandbox: a sandboxed agent's custom-tool commands now
    run inside the container.
  - **`create_tool` no longer adds the new tool to the calling agent's `tools:`
    list.** Creating a tool and being allowed to run it are separate decisions;
    self-granting collapsed them, so an agent without `exec` could obtain shell it
    was never granted. The tool is still created, and the result says plainly that
    the grant is a human's to make.

- b559646: collections: add an agent-writable `collections` tool and open the `type` to a free,
  normalized label (was a hard-coded enum). An agent can now `add`/`list`/`stats`/`remove`
  collection items (restaurants, books, board games, …) and surface them on the Board with
  a config-only `list`/`collections` widget — no new endpoint or renderer. `getCollectionStats`
  now returns a generic `{ byType, total }` shape, and a guarded migration rebuilds older
  DBs that still carry the legacy `CHECK(type IN …)` constraint, preserving rows.
- d9e294f: Use the summariser prompt that actually measured best.

  The default shipped in the previous change was the worst of four variants when
  run against the 1,432-message history it was written for. Scored on named
  specifics and quoted phrasing:

  | prompt                                                | chars   | names | quoted |
  | ----------------------------------------------------- | ------- | ----- | ------ |
  | "…the people, the specifics, and where things stand"  | 1574    | 32    | 3      |
  | "…key facts, decisions, and pending tasks"            | 1428    | 38    | 3      |
  | "in detail." alone                                    | 1420    | 20    | 0      |
  | **the shipped default, enumerating what to preserve** | **707** | **1** | 1      |

  Enumerating what to keep appears to read as a checklist to satisfy briefly
  rather than an invitation to write — the third time a more prescriptive version
  of this prompt lost to a plainer one. The new default names a few neutral
  categories, which beat naming none, and avoids the work-flavoured nouns that
  made a companion's history read like a standup report.

- b1ec29a: config: stop agent settings from parsing, persisting, and doing nothing

  Three fixes for the same disease — config that looks installed and is never read.

  - **`validateConfig` now checks keys inside an agent block**, with a "did you
    mean" for near misses. Only top-level keys were checked (#252), on the grounds
    that nested bags are open — but an agent block is a typed record, not a bag.
    Four agents in one deployment carried their entire persona under
    `system_prompt:` instead of `instructions:`. It parsed, it round-tripped into
    their manifests, and it reached nothing: they ran with an empty instructions
    layer for weeks, and the only symptom was vague answers.
  - **`parseAgentData` no longer drops fields it forgot to list.** It copied an
    allowlist while its own docstring promised that unknown fields pass through.
    `fileBoundary`, `roomSessionScope`, `injectMemory`, `budgetWarnings`,
    `thinking` and the memory-injection budgets were all discarded between the
    manifest and the loop. Concretely: three agents holding `write` and `edit` ran
    with a declared filesystem boundary that did nothing, and thirteen agents that
    set `injectMemory: true` never received an injected memory. Known fields now
    pass through; unknown ones warn.
  - **The `<context>` layer warns when it gets large.** It is the only uncapped
    part of the system prompt, and nothing truncates it — it comes out of the
    history budget instead, so the symptom is an agent that forgets rather than an
    agent with a big prompt. Warned once per agent per process rather than
    truncated: cutting a context file mid-sentence is a silent loss, and which
    file to drop is not a judgement this code can make.

- fd19549: Config values are checked against the type their field is declared as, at load and at every runtime write.

  `AgentConfig` is a TypeScript interface, so it is erased at runtime and there was
  nothing left to compare a parsed value against. `validateConfig` is a _semantic_
  checker — this tool needs an api key, that agent references a tool nobody
  enabled — and none of that goes away; what was missing is the layer in front of
  it. The failure mode it left open is the worst kind: the file parses, it reads
  correctly to a human, and the setting does nothing.

  ```yaml
  cron:
    jobs:
      - name: nightly-sweep
        enabled: "false" # quoted
  ```

  `scheduler.ts` asks `job.enabled !== false`, and `"false" !== false`, so the job
  stayed scheduled. An agent had been asked to disable it, wrote exactly that, and
  reported "Done". It ran four more times over the next six hours while the log
  said "Skipping disabled job" for the four jobs whose flags were real booleans.
  The finding now names the inversion: _"`enabled` must be a boolean, got the
  string "false". The quotes make it text. A non-empty string is truthy, so this
  currently reads as `true`. Write `false` without them."_

  Reported at startup alongside the existing warnings, and — through
  `findInertConfig` (renamed from `findUnknownKeys`, which stays as a deprecated
  alias) — enough to **refuse a runtime write** that would introduce one. Refusing
  is the half that matters: a startup warning is a warning nobody reads six hours
  later, while a rejected write answers the agent that got it wrong, still holding
  the pen. As before, findings are diffed against a pre-write snapshot, so a
  pre-existing one never blocks an unrelated write.

  The stronger driver was drift. `AgentDefinition`'s field list existed in three
  hand-maintained copies — the interface, `KNOWN_AGENT_KEYS`, and
  `AGENT_DEFINITION_FIELDS` — kept in step by a docstring asking you to. When they
  were not: `fileBoundary` never reached `toolContextExtras`, so three agents
  holding `write` and `edit` ran with a declared filesystem confinement that did
  nothing, and thirteen agents set `injectMemory: true` and never got a single
  injected memory. All three now derive from one zod schema, and a
  `Identical<z.infer<typeof Schema>, AgentDefinition>` assertion fails the build if
  the schema and the interface disagree by so much as an optional field. The
  interface is kept rather than inferred, because inferring it would delete every
  doc comment on it — the only place the _why_ of a field is recorded.

  Scope: `AgentDefinition` and `CronJobConfig` are checked field by field.
  `tools.*`, `channels.*` and `mcp.servers.*` are open bags holding plugin config
  that core must never know the shape of, so only `enabled` is judged there — the
  one field they all share, and one that enables what it claims to disable when
  it arrives quoted.

  Also fixes a privileged built-in that fell out of the old hand-written checks:
  `parseAgentData` rejected any `sandbox` other than `host`/`docker`/`podman`, so
  an agent naming a plugin-registered kind failed to load at all. Sandbox kinds
  come from an open registry and `createSandbox` already validates against the
  live one, with a "Known: …" message, at the point of use.

  Adds `zod` as a dependency of `@tailored-ai/core`.

- a38b5fc: Refuse a config write that would land keys nothing reads.

  There were twelve runtime paths writing `config.yaml` — three in the admin
  tool, seven HTTP routes, a plugin tool, and the setup TUI — each hand-rolling
  read → mutate → stringify → write → reload with its own idea of what to check
  first. The strongest checked a YAML round-trip and the agent's tool references.
  The weakest, `PUT /api/config`, wrote the request body to disk without parsing
  it; since `runtime.reload()` swallows its own failures, that route answered
  `200 {"ok":true}` on unparseable YAML while the process kept serving the
  previous config, and the damage only surfaced at the next restart.

  The gap they shared: none of them ran `validateConfig`. So an agent could
  create another agent with `name:` and `temp:` instead of `temperature:`, and
  every layer accepted it — the write, the round-trip, the manifest export. The
  agent ran at the default temperature for a day. `validateConfig` had detected
  exactly this since #252; it just ran at startup, into a log, after the fact.

  Adds `config-write.ts` with `updateRawConfig` and `writeRawConfigText` as the
  single door, and routes the admin tool and every server route through it. A
  write that would introduce config which parses but is never read is refused
  with the offending key named and a suggestion ("Did you mean `temperature`?"),
  and the file is left untouched.

  Two decisions that keep the gate from becoming a lockout. Writes are judged on
  the findings they _introduce_, compared against a pre-write snapshot, so a
  deployment's unrelated pre-existing warnings can't make its config permanently
  unwritable. And only unknown keys refuse — they are never transient and the
  author is right there; everything else `validateConfig` reports comes back as
  `warnings` for the caller to surface.

  Also fixes `updateRawConfig` refusing to patch a config it could not parse
  rather than overwriting it, and makes `create_agent` accept the `value`
  parameter its own schema advertises.

- 1206560: Compaction's wording, length and memory checkpoint are the deployment's call.

  The built-in summariser asked for a summary "concisely", of "key facts,
  decisions, and pending tasks", with no length cap at all. Measured against a real
  1,432-message companion history that produced **88 tokens**. The identical line
  with "in detail" produced **475** — and not by padding: six times the named
  specifics, and quoted phrasing where the short one quoted none. One word was
  discarding most of the history.

  The noun list was the second half of the problem. "Facts, decisions and pending
  tasks" is a project-status framing sitting in core, which is why five days of a
  companion's history came back formatted as `Participants:` / `Key Events:`. A
  deployment knows what its conversations are for.

  New in `compaction` config and `CompactOptions`:

  - `prompt` — what the summariser is asked for. The built-in default no longer
    says "concisely" and no longer enumerates work nouns.
  - `maxTokens` — passed through to the provider. Previously nothing was, so the
    length of every summary was accidental rather than chosen.
  - `memory: { agent }` — before anything is hidden, ask the model what must
    survive and write each line as a note scoped to that agent.

  The checkpoint is the more durable half. A summary is one block every later turn
  carries regardless of relevance; a note is retrieved when it matches the
  conversation, so the history that comes back is the history that applies. It runs
  before the originals are hidden, and a checkpoint that fails is logged while
  compaction continues — refusing to compact would leave the session growing, which
  is the problem being solved.

  `session.compacted` gains `notesWritten`.

- 0a3b591: Contribute a block of context without knowing the prompt layout.

  `systemPrompt.order` / `.custom` can express any layout but demands you
  understand the whole one — and until recently, adding one block meant
  enumerating all seven built-in layers and silently switching off the tail while
  you were at it.

  A slot is the other half of that seam. The author answers one question — does
  this change between turns? — and core decides everything else:

  ```ts
  registerContextSlot({
    id: "on-call",
    refresh: "turn", // "reload" → system prompt; "turn" → behind the history
    budgetTokens: 200,
    agents: ["*"],
    render: (ctx) => whoIsOnCall(),
  });
  ```

  or in config, with no code, via `prompt.slots` — where a `file:` slot is re-read
  each turn, so an edit lands without a restart.

  Core owns placement, ordering, budget enforcement (it truncates and says that it
  truncated), agent scoping, and failure isolation: a slot that throws is skipped,
  warned about once, and the turn continues.

  The per-turn group renders as one contiguous block, which is a requirement
  rather than a preference — the Anthropic history cache breakpoint targets
  `messages.length - 2` and assumes exactly one volatile trailing message.

  There is deliberately no `refresh` value that appends to the conversation
  record. A slot is a view, rendered fresh and replacing last turn's copy; adding
  one and rewriting history are different acts, and the second belongs to a
  composer.

  `DEFAULT_LAYER_ORDER` gains `slots_standing` and `slots_state`, and
  `DEFAULT_TAIL_LAYERS` gains `slots_state`. A deployment that pins `order`
  explicitly keeps working and simply renders no slots until it names them.

- dc312f1: context: make the oversized-context warning configurable, and stop it crying wolf

  The size warning was hardcoded at 750 tokens and quoted CLAUDE.md's "~500 tokens
  for local models" guideline. That guideline assumes a small window; a deployment
  running a 200K-token model and deliberately preferring specific, detailed context
  over letting agents guess is making a choice, not a mistake — and a warning that
  fires on a correct configuration is one people learn to ignore.

  `context.warnTokens` now sets the threshold (default 4000, 0 disables), and the
  message says what the number actually costs — context is never truncated, so it
  comes out of the history budget instead and shows up as an agent that forgets.

- 5a01ceb: Add a built-in `edit` tool for surgical, exact-match file edits. Agents previously
  had only whole-file `write`, so changing a large existing file meant regenerating
  it — impractical, and coding agents would stall on it. `edit` replaces an exact
  `old_string` with `new_string` (unique unless `replace_all`), mirroring the
  read/write tools' path resolution, sandbox boundary, allowlist, and sandbox-aware
  IO. Enabled by default (`tools.edit`), opt-out with `enabled: false`; inherits
  `tools.write.allowedPaths` when its own allowlist is unset.
- b1cdad9: Tool schemas count against the history budget.

  `historyBudget` subtracted the system prompt and the volatile tail from
  `maxHistoryTokens`, then the request went out with the tool definitions on top,
  unmeasured. They travel in their own request field rather than as a message, and
  everything that estimated size walked the message list — so nothing ever looked
  at them. The model reads every byte regardless.

  Measured on a production deployment: 42 tools serialise to about 10,857 tokens,
  roughly a 10% overshoot on a 110,000-token budget, paid on every request. A
  13-tool agent pays about 3,852.

  Nothing overflowed, because the primary model's window was well above the
  configured budget — this shows up as cost rather than as failure. It matters
  most on fallback, where each rung re-fits history against its own
  `maxContextTokens` using the same arithmetic and is handed the identical
  schemas, against a window that is usually much tighter.

  The estimate is recomputed per round rather than once per turn, because
  `getTools()` re-resolves per round and a turn can gain or lose tools mid-flight.

  Deployments running close to their budget will see slightly more history trimmed
  than before. That is the correction: the request was already this large.

- 0fb08f4: Board layout editing. `DashboardWidget` gains a `rowSpan` (height, 1–6 grid rows;
  `span` stays width 1–4), both validated by `validateDashboardWidget`. New
  `POST /api/dashboard/layout` persists a drag-reordered / resized layout: the body
  is the widgets in display order with their `span` + `rowSpan`, and the route
  rewrites `dashboard.widgets` (order = position, span/rowSpan clamped) and reloads.
  Config widgets keep their full spec; built-in/provider widgets get a minimal
  `{id, type, order, span, rowSpan}` override so the resolver merge preserves their
  core-owned title/options.
- 0fb08f4: Add a dashboard widget seam so custom dashboards slot into the bundled UI
  without forking it.

  - Core: `DashboardWidget` contract, a widget-provider registry
    (`registerDashboardWidgetProvider`), `resolveDashboardWidgets(config)`, a
    `dashboard.widgets` / `dashboard.defaults` config block, and built-in default
    widgets (system status, needs-you, recent activity) registered like a plugin.
  - Server: `GET /api/dashboard` returns the resolved widget specs.
  - UI (bundled): a `Board` page (`#/board`) + a widget renderer registry with
    built-in `status`, `tasks`, `activity`, `metric`, `list`, `markdown`,
    `links`, and `iframe` renderers. Widgets are declarative specs (data, not
    React), so config or plugins can add widgets with no UI changes.
  - Agent/author enablement: `validateDashboardWidget()` + `BUILTIN_WIDGET_TYPES`
    exports, `validateConfig` now warns on malformed `dashboard.widgets` (bad
    type/span, non-`/api/` endpoint, duplicate id), and a `dashboard-widget-author`
    example skill teaches an agent the whole authoring flow.

  See docs/dashboard-widgets.md.

- 0fb08f4: Let the `admin` tool author dashboard widgets. `dashboard.` is now in the
  `update_config` write allowlist, so an agent can add or edit a config widget with
  `admin` `update_config` path `dashboard.widgets` (the hot-reload authoring path the
  dashboard seam was built for) instead of being blocked or forced to rewrite
  `config.yaml` by hand. Other config sections stay locked down as before.
- 54ce46f: delegate: sub-agents inherit the confinement their agent declares

  `delegate` hand-built its `AgentLoopOptions` instead of going through
  `runtime.buildLoopOptions`, carrying 13 of the ~25 fields the real one sets —
  and none of the confinement ones. A delegated sub-agent inherited no sandbox,
  no `workingDirectoryBoundary`, and no agent name.

  `delegate` is a meta tool appended to every agent regardless of its `tools:`
  list, so this was reachable from anywhere: `delegate(agent="coder", …)` ran
  coder's `write`/`exec` on the host with its `sandbox: docker` silently inert.
  Same hole as the `CustomTool` one, by a different route.

  It now takes the runtime and uses the same path every other dispatch does, so a
  sub-agent gets the sandbox, boundary, attribution, cwd and shutdown signal a
  top-level turn for that agent would get.

  `buildLoopOptions` gains `includeMetaTools` (default true). `delegate` passes
  false, keeping the sub-agent's tool set exactly its own `tools:` list as
  before — a containment fix should not hand a sub-agent `admin` or a second
  `delegate` on the way past. A meta tool the agent names in its own `tools:` is
  unaffected.

  **Behaviour change worth knowing:** delegating to an agent that declares a
  sandbox now actually starts it. Where that previously ran on the host and
  "worked", it will now fail if the container cannot start — which is the point,
  but it is a failure where there was none.

- 7017c2d: delegate: know that a sub-agent failed, and hear when it finished

  Both from one incident. An executive assistant delegated a lookup, was asked for
  an update 52 minutes later, and had the answer available the whole time.

  **A stalled sub-agent was reported as a success.** `delegate` returned
  `{success: true, output: response}` no matter how the loop ended, so a sub-agent
  that ran out of tool rounds came back as a successful call whose output happened
  to be `[Agent stopped: max tool rounds reached]`. The caller could not tell
  "answered" from "gave up" and silently retried. It now branches on `onStop` —
  which exists for exactly this, and whose docblock says _"Branch on this, not on
  the returned string"_ — and returns `success: false` with the reason, the partial
  output, and what to do about it.

  **Async delegation had no completion path at all.** `startTask` was a `Map` and a
  `.then()` that mutated a record: no callback, no event, no notifier. The only way
  to learn an outcome was to ask. So the agent promised a person a follow-up it had
  no mechanism to make, and the result sat unread — **9 minutes from being evicted
  by the registry's one-hour TTL**, which is lazy and sweeps when the next task
  starts rather than on a timer.

  `delegate(async: true, notify: true)` now delivers the outcome — success or
  failure — into the delegating agent's own session, through the same
  `deliverAgentMessage` path `room(action="dm")` uses, attributed to the agent that
  did the work. `notify: false` remains the default: a clean hand-off, now an
  explicit choice rather than an accident.

  **The tool result says what will actually happen.** It used to read `Background
task started: <id>`, which reads like a promise. Without `notify` it now states
  that nobody will tell you, names the `task_status` call that collects it, warns
  against promising a follow-up you have not collected, and mentions the one-hour
  expiry. `notify` requested where there is nobody to notify — an un-named CLI or
  API session, or delegating to yourself — says so instead of accepting the flag
  and dropping it.

  `startTask` gains an optional `onFinish` callback. A notifier that throws or
  rejects is contained and logged: the task's result is the only thing recoverable
  afterwards and must not be lost with it.

- 7d273b5: Add the `tai deploy` seam so cloud providers ship as plugins.

  `tai deploy list | plan | up | down | status | help` drives a `DeployTarget`.
  TAI ships `docker` (container on this machine, via `docker/tai/`); AWS, GCP,
  Fly and anything else register the same way from a plugin package, so adding a
  provider does not mean forking TAI.

  The contract is types-only in `@tailored-ai/core` — the package plugin authors
  already depend on, and the import erases at compile time. The registry,
  discovery, and the command live in `@tailored-ai/cli`, because nothing in the
  agent runtime needs to know how the instance was deployed.

  Discovery is by _installation_, not configuration: the CLI imports packages
  under `<TAI_HOME>/plugins/` and reads a `deployTargets` named export, the same
  shape the plugin loader already uses for `meta` and `validateConfig`. It has to
  work this way — `tai deploy` is often the command that creates the instance a
  `config.yaml` would describe, so it cannot require one to exist first.

  `up` always runs `plan` first and refuses when the target reports unmet
  preconditions, rather than starting work already known to fail. A plugin that
  fails to import is reported by `tai deploy list` and skipped. See
  `docs/deploy-targets.md`.

- b559646: Fix Discord slash-command registration: guild-scoped, and no longer duplicated.

  Commands were published globally, which Discord can take up to an hour to show
  to clients — indistinguishable from "the commands don't work". When
  `channels.discord.guildId` is set (or the bot is in exactly one guild) they are
  now written to that guild instead, where they appear immediately. Global
  registration remains the fallback and logs the propagation delay.

  Also removes the clear-then-write pattern in `syncCommands`. A bulk overwrite
  already replaces the whole set, so clearing first only widened the window for a
  concurrent sync — `ClientReady` and `onReload` landing together left every
  command registered twice. Syncs are now serialized, and the guild path clears
  the global copies so the two sets cannot appear side by side.

- e6cb5fb: Discord: one duplicate command name no longer freezes every slash command in the guild

  Discord rejects the _whole_ bulk overwrite when a payload names one command
  twice, and the overwrite is all-or-nothing — so a rejected payload changed
  nothing and the guild kept whatever set last registered successfully. Every
  command was frozen, built-ins included, `/pause` included. On a first run the
  guild got no commands at all. The only symptom was one line of `console.error`;
  the bot was otherwise healthy and the stale commands still worked.

  Nothing checked config command names against each other or against the
  built-ins, and normalization erases the difference between `Deploy`, `deploy`
  and `deploy!`.

  `dedupeCommandNames` now drops the later of any colliding pair and warns naming
  both sides, so one bad config entry costs one command instead of all of them.
  Push order is precedence order — built-in, then plugin, then config — so a
  config entry can never take `/pause`'s slot. (Plugin commands moved below the
  built-ins as part of this. `SlashCommandRegistry` already refuses
  `RESERVED_COMMAND_NAMES`, so this is drift-safety rather than a live hole: if
  that hand-kept list ever falls behind the set actually built, the dedupe now
  fails toward the built-in.)

  `registeredCommandsHash` is also recorded on a 4xx. It was assigned only after
  the request resolved, so a payload Discord deterministically rejects was re-sent
  identically on every `ClientReady` and every config reload, forever. A 5xx or a
  dropped connection still retries. The log line now says the guild's commands are
  unchanged and may be stale, rather than only quoting the error.

- e66f07b: Agent-to-agent direct messages can now be observed.

  `deliverAgentMessage` emits a new `agent.messaged` runtime event once per
  exchange, after the recipient's loop returns, so one event carries the message
  and its reply together. `via` distinguishes `dm` (an agent chose to speak) from
  `delegate` (task handoff), because a subscriber that cannot tell them apart
  either drowns in delegation traffic or misses it. A delivery that throws emits
  nothing.

  Adds `builtin:dm-mirror`, disabled by default, which turns that event into a
  line in a room. It posts with no `to` so nobody is addressed, and it refuses to
  run at all when the target room has any subscriber whose `wakeOn` is not
  `"none"` — re-checked on every reload, since an agent can subscribe itself at
  runtime and turn a safe room into a feedback loop with no config edit.

  Previously a direct message left only a session row, so a pair of agents could
  talk all night with no event to subscribe to and no way to mirror, audit or
  count one without patching core.

- 0187e0c: Drop an assistant `tool_calls` that nothing answered, instead of sending it.

  `stripOrphanedToolMessages` handled one direction — a `tool` result whose parent
  was trimmed away — on the reasoning that the reverse was unreachable, since
  results are dropped from the front where their parent goes too. That holds for
  trimming alone and stops holding the moment anything else edits the window: the
  same function resets its open-call set on a user or system message, so a user
  turn landing between a call and its result drops the result and leaves the call
  unanswered.

  Every strict provider then rejects the entire request — DeepSeek "must be
  followed by tool messages", OpenAI "no tool output found for function call",
  Anthropic "`tool_use` ids were found without `tool_result` blocks" — and the
  fallback chain fails again on every rung. Seen in production as three provider
  errors and 26 retries for a single turn, absorbed by the fallback chain but paid
  for four times over.

  Unanswered calls are now removed from the message rather than the message being
  dropped, so the assistant's text survives; a message left with neither text nor
  calls is dropped, having nothing left to carry.

- b559646: Add `builtin:error-room` — forward runtime errors to a room so an agent can triage them.

  Errors that only reach the log get found by accident, days later, usually
  because something else looked wrong. This posts them into a room instead, where
  a subscribed agent can read the error, look at what it names, and say what it
  thinks is wrong.

  Three things are designed in rather than bolted on, because each would
  otherwise be worse than the problem:

  - **Reporting an error cannot cause an error.** A re-entrancy flag means
    nothing logged while reporting is itself reported. Verified against a backend
    that fails _and_ logs on every post: one attempt, no recursion.
  - **A flood cannot reach Discord.** Identical errors collapse to one entry with
    a count, batches post on an interval, and a per-hour ceiling replaces the
    overflow with a count of what was withheld. Repeats route through the
    existing NotificationGate.
  - **Credentials are redacted** before anything leaves the process — `key=value`
    secrets, bearer tokens and JWT-shaped strings.

  Config: `{ module: "builtin:error-room", config: { room, notify, levels,
batchSeconds, maxPerHour, maxPerReport, ignore } }`.

- daa6302: `exec` closes the command's stdin instead of leaving an open pipe.

  `execFile` hands the child a stdin pipe that is never written to and never
  closed, so any CLI that reads stdin when it is not a TTY blocks until the tool's
  timeout kills it. The kill discards the buffers, so what reaches the agent is
  empty stdout, empty stderr and a bare `Command failed` — which reads as "that
  binary isn't installed" rather than "it is waiting for input".

  Found with the Notion CLI: `ntn api v1/users/me` returned fine, while
  `ntn api v1/users/me | jq -r .name` hung for the full 30 seconds, and the model
  concluded — reasonably, and wrongly — that `ntn` was missing.

  `stdio` is not honoured by `execFile`, which owns the pipes in order to buffer
  them, so the stream is closed on the returned child instead.

- a970a8b: First-class reasoning support (#254). Providers now capture their reasoning
  trace into `ChatResponse.reasoning` (and a streamed `reasoning` event), and a
  provider-agnostic `thinking` level (`off`/`auto`/`low`/`medium`/`high`) on
  `ChatParams` maps to each provider's wire format — `reasoning_effort` (OpenAI),
  `thinking:{type}` (DeepSeek), `thinking` budgets (Anthropic / Bedrock
  `reasoning_config`), `chat_template_kwargs.enable_thinking` (vLLM via the
  `openai_compatible` `thinkingDialect`). Set it per provider
  (`providers.<id>.thinking`) or per agent (`agents.<name>.thinking`). Reasoning
  is persisted on the assistant message and rendered as a collapsible "Thinking"
  disclosure in the chat UI, and is stripped from every outgoing request so it
  never re-enters the model. Retires the per-plugin `thinking` hack in
  provider-deepseek (its boolean config still works).
- 57a5d48: Add a global pause switch: `/pause` and `/resume` in Discord.

  Two agents on a metered API answered each other unattended and spent real money
  in twenty minutes, and there was no way to stop it from a phone. Killing the
  process loses in-flight work, editing config calls `runtime.reload()` and
  bounces the very Discord gateway you are typing into, and `autopilot pause`
  covers one of six things that can start a run.

  **`/pause` blocks autonomous runs only.** Cron timers, webhooks, all eight
  workflow trigger pollers, autopilot, exploratory ticks, task auto-dispatch and
  stall retries, room check-ins, agent-to-agent wakes and DMs. Your own messages
  keep working on purpose: a pause that also kills your DMs is indistinguishable
  from an outage, and it removes the instruments you would use to inspect what
  went wrong. `/pause scope:all` adds human-initiated runs.

  **In-flight runs finish.** The gate refuses new runs; aborting a half-finished
  tool call turns an expensive mistake into an expensive mistake plus an
  inconsistent worktree. Child workflows started by a running parent are treated
  as continuations for the same reason.

  State lives in a new `runtime_settings` singleton table, read live on every
  check — the same shape as `autopilot_settings`, and in SQLite rather than
  config for the reload reason above. `AgentRuntime` gains
  `isAgentsPaused(kind)`, `getPauseState()` and `setAgentsPaused()`, and a real
  change emits `agents.pause_changed` on the runtime bus.

  Server, CLI and Slack are touched only to refuse politely under `scope: all`,
  plus one gate in core's own webhook `action: agent` route, which reaches the
  agent loop without passing through the workflow engine.

- 39445bb: Raise the default `agent.maxHistoryTokens` above the tool-schema floor

  It was 2,000, set before tool schemas counted against the history budget. Once
  they did, the budget became

      max(0, maxHistoryTokens - systemPrompt - tail - toolSchemas)

  and the schemas are the largest term by an order of magnitude — a 24-tool agent
  costs ~6,200 tokens before a single message, a 41-tool one ~10,900. Both are
  over 2,000, so the budget clamped to zero: an install that never tuned this
  dropped its whole conversation on every turn and looked like a model with no
  memory rather than a configuration that could not hold one.

  The default is now 20,000, which is what `tai init` had been writing all along —
  so this fixes the untuned path rather than changing the tuned one. Nothing
  changes for an existing config, which already carries an explicit value.

  20,000 rather than a share of `maxContextTokens`: deriving it would make a
  deployment that declares a 200k window spend 200k per turn, and the window says
  what a model accepts, not what an operator wants to pay.

  `validateConfig` now warns when `maxHistoryTokens` is not smaller than
  `maxContextTokens` — a request budget larger than the window it must fit in,
  which otherwise surfaces as a provider rejection on a grown session, a long way
  from the config that caused it. A small-context deployment should lower the
  budget, and is told so at load rather than at failure.

- 4c48ad8: Say when context was removed, in the two places it silently was.

  **Trimmed history.** `trimHistory` drops the oldest messages and returns the
  rest, so the model received a conversation that began mid-thought with nothing
  indicating anything preceded it. It cannot tell "this is where we began" from
  "the beginning was evicted", and answers as though the former. A one-line marker
  now leads the trimmed history: `[System: N earlier messages in this conversation
are no longer shown. It continues from here.]`

  The mechanism already existed — `summarizeOnTrim` inserts an
  `[Earlier conversation summary: …]` marker — but it has no default, so the
  silent path is the one nearly every deployment runs. The marker's cost is
  reserved _before_ trimming rather than prepended afterwards, which would push
  the request back over the budget it was just cut to fit.

  Deliberately a statement of fact with no instruction attached. "Ask if you need
  anything from earlier" is the shape of instruction that gets taken up far more
  often than intended, and an agent opening every turn by asking about its own
  trimmed history is worse than one that does not know.

  **Rooms that outran their backlog window.** When a cursor-based read comes back
  full, the watcher jumps to the newest page so the message that woke the agent is
  certainly included. Everything between the cursor and that page is skipped, and
  the cursor then advances past it — and the result was handed over under the
  heading `New messages:`, as though it were the whole story. That heading now
  becomes `Most recent messages:`, preceded by a line saying the room moved faster
  than the backlog window and messages were skipped. No count: the number is not
  knowable without another round trip, and inventing one would be worse than
  saying plainly that there is a gap.

- ba7bad5: Fixes surfaced by reviewing real autonomous-run logs:

  - **exec**: allow safe compound commands under an allowlist. Chaining (`&&`,
    `||`, `;`), pipes (`|`), and redirections now pass when every command-position
    head is allowlisted, instead of the whole command being rejected for
    containing a shell operator. Command substitution, backticks, process
    substitution, subshells, background `&`, and newlines are still rejected.
  - **memory/embeddings**: clamp each embedding input to
    `memory.embeddings.maxInputChars` (default 8000) and, on a context-overflow
    400, retry with the cap halved — so an oversized recall query no longer
    silently drops semantic search to keyword-only.
  - **retry**: `withRetry` now stops immediately when `shouldRetry` returns false
    (previously it kept re-running `fn`, only skipping the backoff delay).
  - **config**: `validateConfig` treats `task_query` as enabled whenever `tasks`
    is enabled (they register together), removing a spurious per-agent warning.
  - **read tool**: friendly errors for reading a directory (EISDIR) or a missing
    file (ENOENT) instead of the raw errno message.
  - **tasks/github**: pin `x-github-api-version: 2022-11-28` on the Octokit
    client to stop endpoint-deprecation warnings.

- 571adba: Stop shipping build tooling in the self-host image.

  `pnpm deploy --prod` drops `devDependencies` but keeps `peerDependencies`
  marked `optional`, so vitest, `md-to-pdf` and Playwright reached the runtime
  image along with `typescript`, `vite`, `rollup`, two `esbuild` binaries, two
  `lightningcss` binaries and `puppeteer-core` — about 150 MB nothing could
  import. `@tailored-ai/browser-mediator` also declared `playwright` as a hard
  runtime dependency while only ever importing it lazily, contradicting its own
  README.

  `playwright` and `md-to-pdf` are no longer peer dependencies of
  `@tailored-ai/core`, and `playwright` is now an optional peer dependency of
  `@tailored-ai/browser-mediator` rather than a dependency. Both were already
  lazily imported behind an actionable "not installed" message, so no feature
  changes: the `browser` and `md_to_pdf` tools return that message instead of
  Playwright's "Executable doesn't exist" path error.

  The image drops from 880 MB to 669 MB. MCP, PDF extraction and OCR are
  untouched.

- de1ce69: MCP observability (#249). Connected MCP servers were silent — "no log lines" was indistinguishable from "never ran", and the #248 drop-on-reload bug surfaced nothing. Now `McpManager` logs the happy path: one line per server on connect (`[mcp:github] connected (3 tools: ...)`), on tool-list change, and on teardown/restart. The CLI startup banner gains an `MCP: github (3), ...` line (only when servers are configured), and `McpManager.list()` now reports `connectedAt`. New `GET /api/mcp` route (wired via the server's `mcpStatus` option) exposes per-server id, tool names, tool count, and ISO connected-at for the UI / `tai doctor`.
- 87fc6fd: mcp: reconnect a dropped server, and name a rejected credential as one

  Nothing registered an `onclose`. When a stdio child exited or an HTTP endpoint
  stopped answering, the connection stayed in the manager's active set with an
  unchanged config signature — and reconcile skips anything whose signature
  matches, so it was **never restarted**. The server stayed dead until a config
  change or a process restart, its tools stayed registered, and every call
  returned `MCP call failed` to the agent, which cannot tell that from a bad
  request.

  A dropped connection now unregisters its tools and schedules a reconnect, with
  an escalating delay so a flapping server does not spin. The delay resets only
  after a connection has proved stable for a minute — resetting on "it connected"
  would let a connect-then-drop server retry every second forever.

  Connect failures are classified. A rejected credential is logged as
  `AUTH FAILED`, names the config key to look at, and says plainly that retrying
  will not fix it — because the fix is a person minting a new token, and Notion
  PATs expire within a year. Everything else is reported as retryable. `401`,
  `403`, `invalid_token`, `invalid api key`, `authentication failed` and
  `expired token` are recognised; `ECONNREFUSED`, `socket hang up`, timeouts and
  `500` are deliberately not.

  Backoff applies **only to self-driven retries**. An explicit `reconcile()` —
  startup, config reload — always attempts every failed server, because the human
  triggering it may have just fixed the credential, and "fix the token, reload,
  nothing happens" is worse than the hammering the backoff prevents.

  Adds `McpManager.status()` reporting per-server connected state, tool count,
  retry window and whether the last failure was an auth failure — the data an
  integration-health surface needs (#207).

- 611f94d: fix: memory scoping, manifest hashing, and task-dispatch context (#281–#284)

  Four fixes from the 2026-07-28 audit, all in the same family — something that
  looked like a guard and was not.

  - **`hashManifest` covered almost nothing.** `JSON.stringify(rest, Object.keys(rest).sort())`
    passes a _replacer array_, not a sort order, and it applies at every depth —
    so every manifest canonicalized to `{"data":{},…}`. Two skills differing in
    both instructions and `allowed-tools` hashed identically, which made the trust
    store's cached-approval check and `--frozen` ineffective for skills, prompts,
    kb and agents. Now canonicalized properly. **Expect one re-approval per
    installed resource** — stored hashes were computed under the old scheme.
  - **`memory` no longer falls back to the global context directory.** A "profile"
    write from a session with no agent directory — un-named CLI, Slack, API — went
    to `global/`, which is injected into every agent's prompt. It now goes to a
    sibling `unscoped/` directory that nothing injects, and the result says so
    rather than calling it "profile". A redirect, not a gate: hard-failing an
    omitted optional parameter turns a quiet correctness bug into a loud stall.
  - **A global-scope memory write is now logged**, naming the agent. It is still
    allowed — whether an agent may curate shared knowledge is a permissions
    question, not something to hardcode — but it changes every agent's prompt and
    used to happen silently.
  - **`task-watcher` merges `toolContextExtras` instead of replacing it.** Both
    branches discarded the object `buildLoopOptions` builds, so every task
    dispatch lost `agentName`, and non-worktree dispatches lost the agent's
    declared `fileBoundary` too.

  Adds the first unit coverage for `MemoryTool`, which had none despite having the
  widest blast radius in the prompt path.

- 8aa5720: Show all of an agent's core memory, not the first third of it.

  `/memory show` clipped each section to 900 chars and the whole reply to 1700.
  That made it useless for exactly the memories worth reading: a 2,328-char
  persona came back as a third of itself, and asking for that one section did not
  help, because the per-section clip applied either way.

  Core memory is the text that shapes every one of an agent's turns. Two thirds
  of it is worse than none, because it reads as complete.

  Replies now split across as many messages as they need, using the same
  `splitMessage` helper the chat path already used — extracted to
  `channels/split-message.ts`, since importing it from `discord.ts`, which
  imports the command modules, would have been a cycle. When a memory is large
  enough to exceed even that, the reply says how many messages were withheld
  rather than stopping silently.

  `set` and `clear` also return the full prior text now. It was clipped at 1200,
  which defeated the point of returning it — it is what you paste back to undo
  the change.

- d2b5939: Add `/memory` — read and edit what an agent remembers about itself.

  Core memory is per-agent, survives every session, and goes into the system
  prompt on every turn. Until now the only writer was the agent itself through
  the `core_memory` tool, and there was no reader outside the database. An agent
  could write itself a persona that shaped every later answer and nobody could
  see it, let alone correct it. Sessions could already be reset and rewound; core
  memory could only be changed by asking the agent nicely.

  ```
  /memory show   agent:iris [section:persona]
  /memory set    agent:iris section:persona content:…
  /memory append agent:iris section:persona content:…
  /memory clear  agent:iris section:persona
  ```

  `set` and `clear` return the text they destroyed. Core memory has no history
  table, so without that an overwrite is unrecoverable — the same reason
  `/room rewind` hides rather than deletes. Replies are ephemeral, since a
  persona is usually written in the first person and a channel is the wrong place
  to print it. `updated_by` records the person rather than the agent, because
  almost every existing row is self-authored and "who wrote this" is the first
  thing you want when a persona looks wrong.

  An unknown agent or section is refused before any write: a typo would otherwise
  create core memory nothing ever reads. Agent names autocomplete from the agent
  registry and config together, so authored-resource agents appear too.

- 7e9a130: Make `models[]` the fallback chain its docstring always claimed it was.

  `AgentDefinition.models[]` and `agent.models[]` were documented as an "ordered
  priority list of provider+model combinations, first available is used" and read
  by nothing except the `/context` window display. An operator could configure a
  local-then-cloud chain, watch it validate and round-trip through the UI, and get
  no failover at all — with no request-time failover anywhere else in core either,
  a provider outage simply failed the turn.

  The chain is now resolved (`resolveAgent` returns `models`, always non-empty) and
  walked at call time (`chatWithFallback`). Each rung gets one attempt and any
  throw advances to the next; the last rung keeps the transient retry, so a
  deployment that declares no `models[]` gets a one-entry chain and behaves exactly
  as before. Rungs whose provider cannot be built — the plugin is not installed —
  are dropped with a one-time warning rather than taking the agent down, and the
  chain is rebuilt every loop iteration so a reload takes effect mid-run.

  Precedence is most-specific-first: an agent's own `models[]`, then its
  `model`/`provider` pin, then `agent.models[]`, then the deployment default. A pin
  does _not_ opt an agent into the deployment chain, and a per-call model override
  never falls back — both exist to send one call somewhere specific, and silently
  answering from elsewhere would undo them.

  Also: `runtime.tryBuildProvider` splits provider construction from the
  degrade-to-default policy, so a chain rung can be skipped where a declared
  provider still falls back.

- b559646: Stop the agent repeating itself, and stop misreading a budget cap as a stall.

  **Repeat suppression for unsolicited messages.** New `NotificationGate` (core seam,
  `notifications.dedup` config) gates every proactive send — cron deliveries,
  owner-notifier events, and `notify_owner` fired from a background tick — against a
  `notification_log` table. A message is suppressed when it matches something already
  sent to the same recipient inside the window, either byte-for-byte, by a
  caller-supplied key (`task:<id>:blocked`, which survives rewording), or by word-set
  similarity for restatements of unchanged state. Because word-set overlap is
  length-relative, three vetoes protect real news from the similarity tier: differing
  numbers ("$312" → "$412"), differing polarity ("completed successfully" →
  "unsuccessfully"), and any message adding more than `maxNewWords` new words (an
  unchanged digest with one new line appended scores ~0.95, and that line is the point).

  Anything the user asked for is never suppressed: chat replies bypass the gate
  entirely, and a user-triggered run ("Run now", `POST /api/cron/:name/run`) delivers
  unconditionally. Fails open — if the gate is unavailable, or its database is locked or
  mid-migration, the message still goes out.

  Replayed against a real deployment's 10 days of cron output, this delivers 13 messages
  where 306 went out before.

  **beforeRun hooks now fail closed.** `executeHooks` returns `failed`, and a hook that
  throws, is missing, or returns `success: false` stops the remaining hooks instead of
  being logged and swallowed. Cron then aborts the run; chat, delegate, and task-watcher
  still run the agent, so a hook failure can never leave the user talking to a silent
  assistant. Previously a dead Gmail token made the hook error every 30 minutes while the
  prompt still said "Below are my recent emails" — so the model invented an inbox and
  DM'd it. Opt out per hook with `onError: "continue"`.

  **Structural loop-stop reporting.** `AgentLoopOptions.onStop` reports why a run ended
  (`complete` / `sleep` / `aborted` / `max-rounds` / `repeated-calls`) instead of making
  callers string-match `"[Agent stopped: ...]"`. The loop _returns_ that string on abort
  rather than throwing, so the exploratory worker's catch never ran and every
  budget-capped tick was recorded as a stall — and wrote an identical self-feedback note
  each time. Aborts are now classified as `budget` (or a no-op on shutdown), and stall
  notes dedup into one counted note with a TTL and an importance below the sweep
  keep-threshold, so self-feedback can expire instead of outliving real memory.

  **Cron `NO_ACTION` is matched anchored**, not as a substring — a response merely
  mentioning the token no longer silently suppresses a real summary.

- d3a4cf1: Stop `rooms/store.ts` being invisible to grep.

  Two composite map keys embedded a raw NUL byte as their separator instead of the `\0` escape. That is legal TypeScript and behaves identically, but it makes the file _binary_ as far as `grep`, `ripgrep`, and anything built on them is concerned — `grep -c agent packages/core/src/rooms/store.ts` silently returns nothing, and a repo-wide search skips the file without saying so.

  That is a bad property for any file and a worse one for this file: it is the room subscription and wake-budget store, so "find every caller of tryConsumeWake" quietly under-reports. It also means any security or privacy sweep that greps the tree has a blind spot it will never be told about.

  `\0` in a template literal produces the same U+0000, so the keys and everything derived from them are byte-identical.

- 36a50b7: Make the omitted middle of a truncated tool result reachable

  `capToolOutput` cuts middle-out and saves the full output, and the saved copy
  was a dead end: truncation is deterministic and `read` took only a path, so
  reading it ran through the same function, at the same limit, on the same bytes,
  and came back byte-identical. The elided middle had no route back at all short
  of `exec` with `sed`.

  `read` now takes `offset` and `limit` in characters, serves a window that fits
  the budget, and names the exact call that continues it. Characters rather than
  lines because that is the unit the cap counts in; line ranges stay `exec`'s job.

  `ToolContext.maxOutputChars` carries the resolved per-tool budget into
  `execute`, so any tool that can page may serve a prefix that fits instead of
  being cut afterwards. Advisory — the cap still runs on whatever comes back.

  The truncation marker now points at the saved file with the offset that resumes
  it. That sentence was removed a release ago for being false; it is back because
  the code that would make it true has landed.

- 4656518: Support multiple OpenAI-compatible providers under arbitrary ids. Any `providers.<id>` that sets `type: openai_compatible` (or carries a bare `baseUrl`) is now served by the built-in `OpenAIProvider` under that id — so a local vLLM gateway, DeepSeek, Groq, Together, and any other OpenAI-wire endpoint can coexist without a per-vendor plugin, and `agent.defaultProvider` can select among them. A registered factory id still wins over an inline `type`. New exports: `buildOpenAICompatibleProvider`, `isInlineOpenAICompatible`. Closes #253.
- d3e79e3: Compaction can keep a recent window instead of replacing everything.

  `compactSession` was all-or-nothing: the whole session became one summary. For a
  long-running conversation that is the wrong trade. Measured on a real
  1,632-message session, the full history summarised to **907 characters — a 534x
  reduction**. The summary was accurate about participants, events and current
  state, and it discarded the voice, the running context and every established
  preference. What makes such a session worth keeping is exactly what a synopsis
  loses.

  `compactSession(db, id, provider, model, { keepRecent: 200 })` folds away only
  what precedes the newest 200 messages. On that same session it takes the request
  from ~142,000 real tokens to ~33,000, and takes the share of the request
  occupied by the user's actual new message from 0.019% to 0.073% — which is the
  number that decides whether the model answers you or answers its own history.

  Two details that make it correct rather than merely smaller:

  - **Only the hidden part is summarised.** Sending the kept window to the
    summariser as well would put the same content in the next request twice, once
    summarised and once verbatim.
  - **Summaries sort ahead of surviving messages.** A summary row is written last
    and carries the highest id, but stands in for the _oldest_ content; ordering on
    id put a synopsis of the beginning after the turns it precedes. Ordering on the
    compaction batch restores chronology, and holds across repeated compactions
    because each batch only ever replaces content older than everything visible.

  `keepRecent` defaults to 0, so existing callers are unchanged. Undo restores the
  whole batch either way.

- 128c561: `exec` command rules can be set per agent, and support deny lists and patterns.

  The allowlist was one list on one shared `ExecTool` instance, so granting an
  agent `exec` granted it everything on that list. In a real deployment that meant
  34 commands including `rm`, `curl`, `node` and `python3` — so `exec` could not
  be handed out for one narrow purpose, and every integration that needed to shell
  out became a bespoke `custom_tools` entry instead.

  `agents.<name>.exec` now takes the same `allow` / `deny` shape as `tools.exec`:

  ```yaml
  tools:
    exec:
      allow: [git, ls, ntn]
      deny: [rm]
      mode: intersect # default; `override` lets an agent replace these
  agents:
    researcher:
      tools: [exec, web_search]
      exec:
        allow: [ntn] # this agent gets ntn and nothing else
  ```

  Both lists accept glob patterns (`*`, `?`) matched against the command name in
  every command position, so a compound command cannot smuggle a second binary
  past them. `deny` always wins over `allow`, at both levels.

  `mode` is deployment-level on purpose: an agent that could choose `override` for
  itself would make `intersect` guarantee nothing. Under `intersect` an agent can
  only narrow — and an allow list that intersects to nothing denies everything
  rather than falling back to unrestricted, which is the direction that fails open.

  `tools.exec.allowedCommands` still works and is equivalent to `allow`. Note this
  scopes the `exec` tool only; `custom_tools` run a fixed command and never
  consulted these rules.

- 30a0c14: Make an agent's `provider:` actually select a provider.

  `AgentDefinition.provider` parsed, `validateConfig` checked it against
  `config.providers`, and `findOrCreateSession` wrote it into the session row —
  but `buildLoopOptions` passed `this._provider` unconditionally, so every agent
  ran on `agent.defaultProvider` regardless of what it declared. Another config
  key that parses and reaches nothing.

  The symptom is indirect, which is why it survived: the agent's model name goes
  to the default provider's endpoint and comes back as a 404 for a model that
  does exist, just not there.

  `createProvider` now takes an optional provider id, and the runtime builds and
  caches one per declared provider, clearing the cache on reload so an edited
  key or baseUrl takes effect. A declared provider that cannot be built falls
  back to the default and says so once, naming both the agent and the provider —
  the plugin that would register it may simply not be installed, and taking the
  agent offline is a worse answer than a named fallback. Silence there is what
  made the original bug present as a bare 404.

  Also fixes model defaulting: an agent that names a provider and no model now
  gets that provider's `defaultModel` rather than the global one, which was the
  other half of sending one vendor's model name to another's endpoint.

- df2d055: Size the history to the fallback rung that gets it, not to the chain head.

  `historyBudget` was computed once, from `maxHistoryTokens`, before any
  request was made — and every rung was then tried against that same
  budget. A chain whose later rungs have smaller context windows could
  build a request the head accepts and the fallback cannot. The failure was
  not silent, but it wasted the rung, and if every remaining rung is
  smaller than the head the turn fails looking like an outage rather than a
  budget mistake.

  `ModelEntry.maxContextTokens` already existed and was only read by the
  `/context` display. It now reaches the chain: a rung declaring a window
  smaller than `maxHistoryTokens` gets its history re-trimmed to fit, with
  a log line naming what was dropped and for whom. The window covers the
  whole request, so the system prompt comes out of it too.

  Re-trimmed only when the rung is actually smaller, so the common case — a
  chain of one, or every rung roomy — reuses the assembled array and pays
  nothing.

  The re-trim is the plain one even under `summarizeOnTrim`. Summarising is
  an async model call, and spending one on the degraded path to produce a
  prettier request the rung might still reject is the wrong trade.

  `chatWithFallback`'s `params` argument now also accepts a function of the
  candidate, which is how the loop supplies a per-rung request. A plain
  object behaves exactly as before.

- 9ccec1f: Let each rung of a fallback chain carry its own reasoning effort.

  `ModelEntry` held `provider`, `model` and `maxContextTokens`. Reasoning
  effort was resolved per call (global `agent.thinking`, or a per-agent
  value) or per provider (`defaultThinking`) — never per rung. So a chain
  that heads at a small local model and falls back to a strong cloud
  reasoner had one `thinking` value to serve both: set it for the head and
  the fallback is wasted, set it for the fallback and the head is burdened.
  `defaultThinking` got close but is keyed by provider, so a cheap and an
  expensive model on the same vendor still could not differ.

  `thinking`, `temperature` and `maxTokens` are now per-rung. Absent means
  inherit whatever the call resolved, so an existing chain behaves exactly
  as it did.

  `maxTokens` is included deliberately rather than only `thinking`: it caps
  reasoning _plus_ visible output, so a rung that reasons harder generally
  needs a bigger cap than the one it falls back from.

  This became worth asking for with the Responses API work — reasoning and
  tool calls can now coexist, so "reason harder on the cloud rung" is a
  real request.

- e698f39: permissions: rules can reach an absent argument, and headless approval says so (#7, #8)

  Two gaps that made the permission system quieter than it looked.

  - **`matchesRule` returned false for any missing argument**, so a rule could only
    describe what the model _did_ pass. The dangerous call is often the one that
    passes nothing and takes a default — an unscoped write, an unfiltered query —
    and no rule could reach it. A `null` pattern now means "this argument must be
    absent". An empty string counts as absent, because models emit `scope: ""` for
    "unset" and the tools here already read it that way; a rule that disagreed with
    the tool it governs would be worse than no rule.

  - **A call needing approval with no approval handler ran anyway, silently.**
    Cron, rooms, the task watcher and webhooks all take that branch, which was an
    empty block with a comment — so `approve` became `auto` exactly where nobody
    was watching. `permissions.noHandlerAction` now selects `auto` (default,
    unchanged) or `reject`. The default stays permissive deliberately: flipping it
    would stop autonomous runs that have worked for months. What changed is that
    the permissive branch logs once per tool per process rather than passing in
    silence, and a deployment that wants its `approve` rules to mean something on
    headless paths can now say so.

  Together these are the generic seam that per-tool policy knobs were standing in
  for — every tool gets it, including plugin-authored ones.

- b8fe10c: Stop a heavily trimmed conversation answering a question the user retracted

  When trimming dropped every user message, the safety net that keeps a request valid spliced the **first** user message back in as the current turn. On a session where the user had changed their mind, the model was handed a statement that had since been retracted and answered it — confidently, with the cancelled date.

  It is reachable on any second round under history pressure: round two ends on an assistant or tool message, and the trim keeps only the last message, so no user message survives to be kept.

  The message spliced back is now the most recent one, which is the turn the model is actually answering. The case the net was written for — a task prompt followed by tool churn — has exactly one user message, so first and last are the same there and nothing about it changes.

- 0d4f4b6: Plugins can register slash commands.

  Every chat command was hardcoded in `discord.ts` — a plugin had no way to add one, so anything wanting a command had to be a core change. This adds the seam, shaped like the HTTP route seam next door: core owns a transport-neutral `SlashCommandRegistry` of descriptors, and each channel adapts them onto its own command surface. Core never imports discord.js from the registry, so the dependency direction stays channel → core and a Slack or Telegram channel can serve the same descriptors.

  ```ts
  ctx.commands.register({
    name: "instance",
    description: "Show or switch the running TAI instance",
    options: [
      {
        name: "name",
        description: "Instance",
        type: "string",
        autocomplete: suggest,
      },
    ],
    handler: async (inv) => ({ content: `switching to ${inv.options.name}` }),
  });
  ```

  Unlike HTTP routes these cannot be namespaced — chat platforms use a flat command namespace with no separator to hide a prefix behind — so `register` throws on a name that is built-in (`RESERVED_COMMAND_NAMES`) or already taken by another plugin. Refusing is the honest failure; the alternative is a plugin silently shadowing `/room` or `/memory` for everyone in the guild.

  The Discord adapter defers the reply before invoking a handler. Plugin handlers do arbitrary work, and Discord kills an interaction that goes three seconds without a response; deferring buys fifteen minutes. A handler that throws is caught and reported into the interaction rather than leaving it hanging as "the application did not respond".

- 6460c00: Stop the per-turn prompt layers from invalidating the whole prompt cache.

  Prompt caching matches an exact token prefix. `chat_live_state` and
  `recall_memory` are rebuilt on every turn and both sat inside the system
  prompt, which sits in front of the entire conversation — so each run
  re-paid for its system prompt _and_ its whole history. Measured on a busy
  48h of the reference deployment, input was 99.5% of everything billed and
  cross-run reuse was approximately zero.

  Both layers now render after the history instead, as a single labelled
  turn. The system prompt and the history become a stable prefix; only the
  tail is fresh. The model still sees both blocks, exactly once, and they
  are still charged against the same history budget they used to occupy.

  `SystemPromptOverride.tail` controls this. `tail: []` restores the old
  layout. Setting `order` yourself disables the default — an explicit order
  is a statement about placement, so nothing moves unless you also name
  `tail`. A layer omitted from `order` stays omitted; `tail` never
  reintroduces one.

  Rounding the timestamp in `chat_live_state` would not have worked: the
  block also renders relative ages ("5m ago") and a live task list, so it
  varies every turn regardless of the header.

- 0039c3a: Declaring a custom system-prompt layer is now enough to render it, and turning
  the tail off says so.

  Two defects made `systemPrompt` unsafe to use for the thing it exists for.

  A custom layer only rendered if it was also named in `order`, and `order` means
  "names not listed are omitted". So adding one block cost you enumerating all
  seven built-in layer names in the right sequence, and an enumeration with a name
  missing deleted that built-in silently. A `custom:` entry on its own — the shape
  someone reaches for first — parsed fine and did nothing.

  Worse, `order` set without `tail` switches the tail off. That behaviour is
  deliberate (an explicit order is a statement about placement) but it was
  unannounced, and the tail is where the volatile layers live. Adding a block
  therefore either moved `chat_live_state` into the system prompt — which carries
  a clock, so it changed the prompt every turn and defeated prompt caching — or,
  if `order` did not list them, dropped the clock and recalled memory out of the
  request altogether. Nothing in the config hinted at either outcome.

  Now: an unplaced custom layer is appended after the built-ins, naming it in
  `order` or `tail` still decides where it goes, and `tail` accepts a custom layer
  without `order` having to list it too. Setting `order` without `tail` warns once
  per config, naming which layers moved and what it costs.

  No behaviour change for a deployment that already sets `order` and `tail`
  explicitly, or for one that sets neither.

- 8d0f50e: Describe TAI as model-agnostic rather than local-first

  The package descriptions and the core README said "optimized for local LLMs",
  which is the positioning npm shows on the package page and which stopped being
  true a while ago: core ships an OpenAI-compatible client that talks to a local
  server or a hosted one with equal footing, and OpenAI, Anthropic, OpenRouter,
  Bedrock and DeepSeek are all first-class provider plugins. The reference
  deployment runs a hosted model by choice.

  Local support is unchanged and still first-class — it is no longer stated as
  the framework's identity. The `local-llm`, `ollama` and `vllm` keywords stay,
  because those are discovery tags for a capability TAI really has.

- 9b13c86: Let config reach sampling controls core does not model, via `providerExtra`

  The generation call sent `temperature` and `max_tokens` and nothing else.
  `ChatParams.extra` and the provider-side merge both already existed, but nothing
  on the agent's path populated them, and the `providerExtra` config key reached
  only `briefing` and `suggestions` — so a deployment had no way to set, say,
  vLLM's `repetition_penalty`.

  That is not hypothetical: one local 27B model re-sends its own previous
  message nearly verbatim (15/16, word-trigram overlap 0.90 against the agent's
  own prior reply) and neither temperature nor prompt wording fixes it — an
  explicit "do not repeat" instruction measured 20/20, worse than saying nothing.
  `repetition_penalty: 1.15` takes it to 4/16.

  `providerExtra` is now readable on `models[]` (per rung), `agents.<name>`, and
  `agent`, and lands on `ChatParams.extra`. Core neither validates nor interprets
  the keys, so provider plugins can expose their own controls without a core
  change. A more specific level replaces the bag rather than merging into it,
  because a chain mixes providers and the bag is provider-shaped.

  Also fixes a stray NUL byte in `agent/agents.ts` — a dedup-key separator written
  as the literal byte instead of a unicode escape, which made the file read as
  binary to grep and every other text tool.

- c120f51: Make `server.proxyAuth` actually authenticate, so the dashboard works remotely.

  The middleware and the login page both already existed. Nothing mounted the
  middleware, and `/api/auth/login` was never implemented, so enabling proxyAuth
  authenticated nothing while suppressing the warning that the API was open.

  The server now gates `/api/*` on proxyAuth when enabled, accepting either the
  password as a bearer or an HMAC-signed session cookie, and serves
  `/api/auth/login` and `/api/auth/logout`. The cookie is what matters: a bearer
  token cannot ride on an `EventSource` connection, so SSE (chat, the event feed)
  was unreachable to a token-authenticated dashboard. That is why the bundled UI
  could not be used with `authToken` alone.

  Auth is one gate rather than two stacked middlewares, so "which credential
  decides" is answerable by reading one function. `authToken` keeps working
  alongside proxyAuth, letting scripts hold a separate secret from browsers.

  Hardening:

  - Session cookies are HttpOnly, SameSite=Lax, and only `Secure` when the
    request actually arrived over TLS (`x-forwarded-proto`, else the request
    URL). Setting `Secure` unconditionally makes login silently fail on a
    plain-HTTP LAN, since the browser accepts the 200 and drops the cookie.
  - Failed logins are throttled per client IP, 10 per 15 minutes, keyed on
    `x-forwarded-for` so one attacker cannot lock out everyone behind a proxy.
    A correct password clears the record.
  - The session HMAC is keyed by the password, so rotating it invalidates every
    issued session.
  - `proxyAuth.enabled` with an empty password fails every request closed with a
    500 instead of falling open, and `validateConfig` warns about it.

  Also fixes the UI's 401 interceptor swallowing `/api/auth/login`'s own 401,
  which made every wrong password report "Network error" instead of the reason,
  and parses the server's JSON error rather than printing it raw.

- 7c6217a: Subscribing an agent to a room at runtime now actually starts it watching.

  The watcher armed its timers and listeners once, from whatever subscriptions existed when `start()` ran. Anything added afterwards — `/room add`, the room tool's `invite`, a config reconcile — was written to the database and then never armed. A new `deliver: poll` subscription had no poll timer, a `checkInMinutes` had no interval, and the first push subscription for a backend had no message listener.

  Nothing reported an error. The write succeeded, the subscription was really there, `/room members` listed it, and the agent simply never spoke. From the outside that reads as a model too weak to answer, which is the wrong diagnosis and leads to the wrong fix.

  `RoomStore` already emitted `room.membership_changed` on subscribe and unsubscribe — the announcer plugin has been consuming it all along. The watcher only ever emitted events and never listened to any. It now subscribes to that one and re-arms.

  Re-arms are debounced, because a config reconcile emits one event per subscription it adds or prunes and an agent can invite several peers in one turn; without coalescing, twenty subscriptions would tear down and rebuild every timer in the deployment twenty times.

  The tradeoff that leaves: `rearm()` rebuilds _all_ timers, so any poll or check-in clock in flight restarts. A subscription changing every few minutes could keep starving a long poll interval. Arming incrementally — touching only what changed — avoids that and is the better end state; this is the version that makes the documented feature work at all, and never firing is worse than firing late.

  Also fixes a contradiction: `/room add` reported "Takes effect immediately" while the `room` tool reported "Takes effect on the next reload" for the same write. The first was false and is now true; both say the same thing.

- 449e827: Say when a turn hit the output cap instead of returning an empty reply.

  `agent.maxTokens` goes out as `max_completion_tokens`, which on a
  reasoning model caps reasoning _plus_ visible output rather than output
  alone. A hard turn can spend the entire budget thinking and come back
  with an empty message and `finish_reason: "length"`, billed in full.

  The loop now recognises that case and reports it: which model answered,
  what the cap was, how many output tokens were billed, and whether
  reasoning is what consumed them — through `onStop` as
  `{ kind: "truncated", … }`, and as the turn's returned text. An empty
  assistant message is otherwise indistinguishable from a model that had
  nothing to say, and that ambiguity is how this class of bug survives.

  Checked before the nudge path, because nudging a model that ran out of
  budget spends another round arriving at the same place. A reply that was
  merely cut off mid-sentence is kept, with a warning rather than a
  replacement — the partial answer is still worth more than the notice.

  The cap itself is unchanged: it exists because OpenRouter reserves the
  routed provider's full output window against the balance when the field
  is absent and 402s at low balance. Per-rung `maxTokens` (`ModelEntry`)
  is the knob for raising it where reasoning is on.

- 58dd367: Compaction hides a conversation instead of deleting it.

  `compactSession` ran `DELETE FROM messages` and wrote a model-authored summary
  in the originals' place: no archive, no tombstone, no event. A summary that
  dropped the one fact that mattered dropped it permanently, and there was nothing
  to go back to. That shipped alongside `agent/rewind.ts`, which stamps
  `rewound_batch` and filters on read specifically so a conversation survives
  being wrong about it.

  Compaction now uses the same mechanism. Rows keep their place and gain a
  `compacted_batch` number, `getSessionMessages` skips them, and the summary row is
  stamped with `compaction_summary_for` so undoing a compaction removes the summary
  too rather than leaving one beside the conversation it summarised.

  New: `undoCompaction(db, sessionId, batch?)` restores one compaction — the most
  recent by default, so undoing twice walks back two steps — and
  `listSessionCompactions(db, sessionId)` reports what is folded away. A
  `session.compacted` event carries the session, the batch, and how many messages
  were hidden, so a subscriber can archive, notify or audit.

  Ordering is part of the contract and is tested: summarise first, hide second. A
  provider that throws now leaves the session exactly as it was, rather than
  hidden behind a summary that never arrived.

  Two nullable columns are added to `messages` by a safe migration; existing rows
  are untouched and nothing is retroactively hidden. Verified against a 262 MB
  production database.

  This is also the precondition for compacting automatically, which was not a
  responsible thing to trigger on a threshold while it was irreversible.

- bbcde3b: Add `/room rewind` — take a conversation back a few turns.

  `/room reset` was the only way to undo anything, and it throws the whole
  conversation away. That is right when a conversation is a total loss and wrong
  every other time. Most conversations that go bad go bad at a point you can
  name: one misread instruction compounded over six turns, one tool result that
  poisons every later answer, two agents being polite at each other until the
  turn cap stops them. What you want then is to drop the tail, not the history.

  ```
  /room rewind agent:iris             # take back the last turn
  /room rewind agent:iris turns:5     # take back five
  /room rewind agent:iris turns:0     # put the last rewind back
  ```

  Nothing is deleted. A rewound message keeps its row and gains a `rewound_at`
  stamp; `getSessionMessages` skips stamped rows, so the model stops seeing them
  while the transcript stays whole and the operation stays auditable. Deleting
  would make "one turn too many" — the obvious mistake with a command like this
  — unrecoverable.

  Repeated rewinds compose, and each undo restores exactly one of them: rewinding
  twice and undoing once lands one step back, not where you started. Because
  history is re-read from the database every round, a rewind takes effect on the
  agent's next turn with no restart.

  The reply quotes the opening of the first message taken back. A rewind is
  counted in turns and nobody remembers how many turns ago something was said, so
  the count alone gives no way to tell a correct cut from an off-by-one. It also
  reports session scope, for the reason `reset` learned to: an agent on a
  `shared` scope has one conversation covering every room it is in, so "this
  room" would be a quiet lie about the reach of the change.

  The rewind number is a counter derived from the rows, not a timestamp. Undo has
  to restore exactly one rewind, and two rewinds in the same millisecond share an
  ISO string — which is not hypothetical: the timestamp version failed on the
  first full test run, where two rewinds land in the same millisecond routinely.
  Ordering that decides correctness should not depend on clock resolution.

- 2c0fde1: Fix two things `/room rewind` got wrong on first real use.

  **The rewind was handed straight back.** A room's wake prompt is built from the
  backend's messages — `fetchSince(roomId, sub.cursor)` — not from the session.
  Rewinding only the session hid the exchange from the agent's memory and then
  re-fed it as "New messages:" on the very next wake, the agent's own last post
  included. Observed in production: an agent quoted the message it had just been
  made to forget. The rewind now moves that room's cursor to the newest message,
  so nothing taken back comes back.

  Only the cursor for the room the command was run in moves. A shared-scope agent
  has one memory across several rooms, but advancing every cursor would silently
  drop genuinely unread messages from rooms nobody asked about.

  **The excerpt quoted boilerplate.** A room turn's `user` message is a whole
  constructed prompt — identity preamble, room purpose, new messages, reply
  instructions — and the preamble is byte-identical on every turn in a room. So
  the quote came back as

      > Room "eng". You are planner. Today is …

  which told you nothing about where the cut landed, the only thing the excerpt
  is for. It now quotes the messages block and falls back to the raw text for
  turns that are not room prompts.

- 0b7a0f7: Raise `/room rewind`'s turn cap from 50 to 1000.

  50 was arbitrary and too low. An agent on `roomSessionScope: shared` keeps one
  conversation across every room it is in, so its turn count is the sum of all of
  them — the first real use needed 77 and the option rejected it. The cap only
  guards against a fat-fingered 9999, and a rewind is reversible with `turns:0`,
  so it can afford to be generous.

- 19188db: `/room all <message>` — say something to every agent in a room

  There were two ways to reach agents from Discord and neither did this. `/room
ping` sends your words to one agent. `/room status` reaches everyone but asks a
  fixed question and deliberately leaves nothing in the transcript. Saying an
  arbitrary thing to the whole room meant pinging them one at a time.

  `/room all message:…` posts your message into the room addressed to every
  subscriber whose `wakeOn` is not `none`.

  **Addressing them by name is the point.** An agent on `wakeOn: named` or
  `addressed` does not stir for a message that names nobody, so typing in the
  channel reaches only the `wakeOn: all` subscribers. Naming everyone is what
  makes it a broadcast.

  Because it goes through the room as an ordinary post rather than waking agents
  directly, everything else applies unchanged: `room(action="pass")` still lets an
  agent stay quiet, repeat suppression still holds, and the conversation-depth
  counter resets because a person really did speak — no special-casing needed.

  Unlike `status`, the message appears in the transcript under your name. That is
  not the line `status` avoids crossing: these are genuinely your words, so
  attributing them to you is accurate rather than putting words in your mouth.

  Agents on `wakeOn: none` are excluded from both the addressee list and the "sent
  to N" count — they would not hear it, and counting them would make the
  confirmation a claim the command cannot back. When _every_ subscriber is
  `wakeOn: none` it says so instead of posting, because "nobody is here" and
  "everybody is deaf" need different fixes.

  Two defects found by adversarial review of this change and fixed here. Both
  predate it — `ping` and `status` had the first one too:

  - **A failed `/room` subcommand said nothing and logged nothing.** The error
    handler called `interaction.reply()` unconditionally, which discord.js rejects
    once an interaction is deferred or replied, and that rejection was swallowed
    by an empty `.catch()`. A failing `ping`, `all` or `status` left the user on a
    "thinking…" spinner forever with no error text anywhere — and the comment
    saying it was "logged upstream" was wrong. It now branches on the interaction
    state and always logs the original error first.
  - **`/room all` could report "Sent to N agent(s)" while waking nobody.** A room
    message is parsed back out of Discord as an envelope, and a name is only
    accepted as the speaker when the identity layer knows it. Run from an account
    with no `rooms.identities` entry, the message can return with no speaker and
    `fromSelf: true`, which the wake logic drops for every subscriber before it
    looks at who was addressed. The command now warns when it cannot resolve the
    caller and prints the exact config line to add. Same condition means the
    conversation-depth reset only holds for a recognised speaker — the docs said
    otherwise and have been corrected.

- 20f9fe1: Rooms announce who joined and who left, so membership stops being invisible.

  An agent called `room-keeper` created a room, stayed subscribed to it
  because `room(action="create")` subscribes the creator, and went on receiving
  everything said there long afterwards. `/room members` would have shown it the
  whole time. Nobody looked, because nothing had ever suggested there was
  anything to see. Being in a room and looking like you are in a room were
  different facts.

  - **`room.membership_changed`** on the runtime event bus — `{ roomRef, agent,
change: "joined" | "left", source: "config" | "agent" }`. Emitted by
    `RoomStore` only for changes that actually happened: a re-subscribe that
    changed nothing is not a join, and unsubscribing an agent that was not there
    is not a leave. The store takes the bus as an optional constructor argument,
    so bare constructions keep working.
  - **`builtin:room-announcer`**, on by default, posts one line into the affected
    room: `**iris** joined this room.` / `**iris** left this room.` The creator's
    own join gets its own sentence — `**room-keeper** created this room and
joined it.` — because it is a side effect of opening the room rather than a
    decision about who should be in it, and it is the case that went unnoticed.

  `source: "config"` changes are suppressed outright. `rooms.subscriptions` is
  re-applied on every reconcile and re-created wholesale on a fresh database, so
  announcing those would post a wall of joins on every boot — the way a signal
  meant to make membership visible becomes noise everyone learns to skip.

  Announcing is a workflow opinion, so it is a removable plugin rather than a
  property of rooms: core emits the event, and a deployment that wants different
  wording or none of it sets `enabled: false`. Config: `{ module:
"builtin:room-announcer", config: { speaker, creationWindowSeconds,
announceJoins, announceLeaves } }`.

- 7f620a0: Let an agent pass on chatter that is not about its work

  The wake prompt offered `room(action="pass")` for three named cases — acknowledging, agreeing, thanking. A model reads the enumeration as exhaustive, so anything outside it gets a reply: given a passing remark from one person to nobody in particular, both models tested answered, and by the letter of the wording they were right.

  The measured cost was larger than "one unnecessary reply". A room whose `purpose` explicitly said to stay out of social chatter was overridden seven times in eight — the sentence was beating the room's own stated norm, not merely under-specifying.

  Adds a fourth case. Still a list of concrete cases rather than a general "reply only when relevant", because the general permission is the phrasing that gets over-taken.

  Not free: on the benchmark's control for the opposite failure — a loose question from a person, which must still be answered — the pass rate went from 8/8 to 5/8. The measurements are recorded next to the wording.

- b559646: Rooms: parent messages, visible tool activity, and correction rounds.

  - `OutboundRoomMessage.parentId` says a message belongs underneath another;
    `capabilities.threads` says whether a transport can render that. Discord opens
    a thread on the parent. The seam does not know what a thread is, so a
    transport that nests differently is not forced into Discord's shape.
  - `rooms.toolActivity` (`none` | `mutations` | `all`) attaches an agent's tool
    calls under its reply. Each line names the tool and the argument identifying
    its target, never the full arguments — those carry file contents and search
    bodies. Reads are included under `all` because a wrong answer usually traces
    to what was read.
  - A written-out `room(action="pass")`, and a pass after changing files, each get
    one correction round instead of being silently suppressed or overridden. The
    agent is told what looked wrong and decides; asking beats overriding, and a
    single attempt keeps a weaker model from spending its budget being corrected.

- 9883913: Agents woken by the same message take turns.

  A message naming two agents woke both, and both were dispatched without being awaited — the in-flight guard is keyed per (agent, room), so nothing serialized them. They answered the same question in parallel, and each prompt was built from the backlog as it stood when the message landed, so neither knew the other had been asked. Two overlapping answers to one question is the most common way a room becomes unreadable, and the conversation-depth cap cannot help because both replies are legitimately addressed.

  Wakes now queue on a FIFO chain per room. The payoff comes from something that was already true: `runWake` fetches the backlog when it _starts_, not when the trigger was queued. So chaining alone is enough to put the first agent's reply into the second agent's prompt — the prompt builder is untouched.

  Serialization is per room, not global: two rooms still run in parallel, and an agent slow in one room does not hold up another. Within a room the second agent does wait for the first, so a hung model turn delays the others until the loop's own timeout fires. That is the cost, and it is why the behaviour is selectable — `rooms.turnTaking: "serial" | "concurrent"`, with a per-room override, defaulting to `serial`.

  A repeat trigger for an agent already waiting its turn is now dropped rather than queued twice. The queued run re-reads the backlog when it starts, so it sees the newer message anyway — which also stops `wakeOn: "all"` waking an agent a second time for a reply that arrived while it was still in the queue.

  Every path that starts a turn for a room goes through the queue — the push debounce, a poll tick, and a scheduled check-in. Turn-taking that covered only the push path would have left the other two racing exactly as before, since both reached their runners directly.

  `/room status` is deliberately left off the chain. It is a person asking every agent at once and answers immediately, which is the reason it was written not to await in the first place.

- 77781ef: Archived rooms can be filed under a Discord category. Set
  `channels.discord.archiveCategory: Archived` and archiving a room moves its
  channel there; restoring puts it back in whatever category it came from.

  The channel is moved, not locked or hidden — people can still read it and still
  talk in it, which is the point of keeping the record. Moving never resyncs
  permissions to the new category: discord.js does that by default, and since room
  membership is derived from channel permission overwrites, accepting it would
  erase the room's roster as a side effect of tidying the sidebar.

  Unset by default, so archiving leaves channels exactly where they are. The move
  needs Manage Channels and is best-effort — if it fails the room is still
  archived, with one warning in the log.

  Adds the `RoomBackend.archiveRoom?()` seam and `RoomCapabilities.archive`, which
  reports false both when a transport cannot file rooms and when nobody configured
  it to. Backends can park opaque state across an archive via
  `RoomStore.getBackendState` / `setBackendState`.

- b7788ad: Rooms can be archived. A room could be opened three ways and closed none, so a
  finished one kept its poll and check-in timers, kept a line in every `room list`
  an agent reads, and held its name against the next room that wanted it.

  `room(action="archive")` and `/room archive` retire a room without destroying
  it: it stops waking anyone, refuses posts, and releases its name — while keeping
  its messages and every subscription's cursor, role and cadence, so `unarchive`
  gives the room back rather than an empty channel. Announced in the room by
  `builtin:room-announcer`, since archiving silences everyone else in it.

  Room names are now unique among live rooms only, so archiving `trip` frees the
  name for the next one. Config gains `rooms.rooms[].archived` as a tri-state:
  `true` archives, `false` reopens, and omitting it leaves the stored state alone.

- 7e05a94: One wake can now read several rooms in a single turn, when the subscriptions ask for it.

  The queue has produced one entry per agent since #348, but each room named in that entry still started a turn of its own: an agent watching nine rooms ran nine model turns, each blind to the other eight and each costing a wake. A person with nine channels open does not get interrupted nine times.

  Opt in per subscription, and set the per-agent floor it requires:

  ```yaml
  rooms:
    minWakeIntervalMinutes: 5 # required — batching is refused without it
    subscriptions:
      - agent: coder
        room: eng
        batch: true
      - agent: coder
        room: ops
        batch: true
  ```

  `rooms.minWakeIntervalMinutes` is a requirement, not a recommendation. While it is 0, an agent's `batch: true` rooms keep their own turns and a warning says why, once per agent. A combined turn is charged to whichever room holds the newest message, so the charged room _rotates_: nine batched rooms with round-robin traffic buy 12 × 9 = 108 combined turns an hour before any counter refuses. A feature meant to lower wake volume would instead be multiplying the runaway ceiling by the batch size, and the per-agent floor is the only brake that counts an agent rather than a room. Refusing is the honest failure; silently raising the ceiling is not.

  Two is the floor for rooms as well. One room with `batch: true` and nothing to batch with keeps today's per-room turn exactly, so a deployment that sets the flag in one place sees no change at all, and a deployment that sets it nowhere sees none either. The existing suite is the proof: it passes unedited.

  What a combined turn does differently:

  - **One prompt**, a `## room` section per room that has something new, rooms with nothing new omitted entirely. At most five messages per room, under one hard budget that charges each section's heading, purpose and role as well as its transcript. Every room the wake policy said yes to is guaranteed its newest message before the remainder is allocated newest-traffic-first, so nine idle rooms cannot crowd out the one that asked a question ten seconds ago — and the room that _caused_ the wake cannot be starved by a chattier neighbour either.
  - **One wake charged**, against the room whose newest message is most recent, rather than one per room. The hourly ceiling is an UPDATE on an `(agent, room)` row and cannot express "this agent ran once", which is exactly why `minWakeIntervalMinutes` is required; the hourly one stays as a backstop.
  - **The pause switch applied room by room.** Under `scope: autonomous` a person waiting in one room licenses a turn about that room, and the rooms carrying nothing but agent-to-agent traffic are dropped before the prompt is built. Asked over the whole batch, one human anywhere would un-pause every room the agent watches and invite it to post in all of them — the runaway the switch exists for, arriving through the feature meant to reduce wakes.
  - **Room queues acquired in one agreed order.** Each per-room chain from #332 is a lock, and a turn spanning N rooms holds all N — two agents with overlapping batches taking them in different orders is a deadlock. One comparator, in one place, with a test that deadlocks without it.
  - **Every shown room's cursor advances**, keeping the existing rule that a cursor records what was shown rather than what was acted on. A room the budget squeezed out was never shown, so it keeps its cursor, emits no `room.woke`, and is read next time.
  - **`agent_turns` cleared only where the agent posted.** The anti-chatter counter belongs to one room's conversation, so a tool call in one room is no reason to release the brake in another where two agents are looping.
  - **A shared session**, because a per-room session key would file a cross-room conversation under whichever room happened to be primary.

  Two triggers deliberately stay outside a batch. A scheduled check-in keeps its own turn — it is a different kind of prompt, and a digest that only runs when something is new would swallow it in the quiet rooms it exists for. And a poll tick over a batch where nothing deserves a wake runs nothing: poll timers fire regardless of traffic, so without that check batching would raise wake volume rather than lower it.

  Reply routing is the honest part. A combined turn has no single destination, so bare text is not posted anywhere: the agent gets one correction round naming the rooms in play and asking which, and text that still names no room is dropped with a log line. Every correction a batched turn can give says the same thing — name a room or pass — including the ones for malformed output, which a single-room turn answers by asking for plain text. A plausible message in the wrong channel is worse than a visible failure. Single-room wakes keep today's forgiving behaviour untouched.

  Step 3 of 3 toward #344.

- e3b1bc5: Let an agent see every room it watches, not just the one that woke it

  A wake prompt names one room and carries that room's new messages. For an agent
  in one room that is everything; for an agent in six it is a keyhole, and the
  conversations it has open elsewhere are invisible unless they happen to have
  spoken last.

  `rooms.crossRoomView` (off by default) adds a per-turn block: N lines across all
  rooms, a floor of M for each room the agent is not answering in, the current
  room marked and taking the remainder. Floors are paid first, so a busy room
  cannot crowd out a quiet one. Other rooms' slices are cached for
  `cacheSeconds` — otherwise every watched room is a backend round trip on every
  turn — while the current room is always fresh.

  It renders through a `turn` context slot rather than the wake prompt, so it sits
  behind the history and never enters the conversation record. The wake prompt is
  persisted as the record of what the agent was asked, and a re-rendered view
  stored as a record is what puts one block in a session twenty times over.

  Enabling it also adds a short standing paragraph, in the system prompt, telling
  an agent in several rooms how to reach the others. Without it a 27B model asked
  in one room to tell someone in another something invented `[message to dana]` as
  a reply prefix and sent it to the wrong room. The `room` tool could always do
  it; nothing said so.

- 920a799: rooms: `dm` delivers straight to an agent instead of opening a channel for it

  Shared sessions took the room's second job away — `room:all:<agent>` does not
  reference a room — so materialising a Discord channel to carry one message was
  pure overhead, and at 27 agents it was 27 channels waiting to happen. `dm` now
  hands the message to the recipient and returns its reply; the exchange lands in
  the recipient's session, so it stays durable and inspectable without being a
  place. `rooms.desks` becomes an opt-in mirror for a direct line you want to read.

- 920a799: rooms: one name per person, honest `/room reset`, and brakes that fit the room

  Found by reading what the agents actually did rather than the code:

  - **One person, one name.** A declared human identity now replaces the implicit
    `owner` instead of sitting beside it, matched on transport account id, and
    slash commands stamp that label rather than the raw Discord username. Agents
    were shown `owner` and `alex` for one human, read `@discorduser` in the
    transcript, and got `Unknown participant(s): discorduser` from a validator that
    had never heard of it.
  - **`/room reset` clears the session the agent is using.** It built the key
    without asking for the agent's session scope, so with `roomSessionScope:
shared` it wiped an abandoned per-room session, reported that session's message
    count, and left the live one untouched. The reply now says which memory went.
  - **An agent's own posts are condensed in its wake transcript.** They are already
    in its session as the reply it just made; one observed prompt was 6.4 KB, two
    thirds of it the agent quoting itself.
  - **Per-room `maxWakesPerHour` / `maxAgentTurns`**, because a coordination room
    and a weekly ideas channel cannot share one number. A wake that produced no
    post and no tool call is refunded — what makes a runaway expensive is replying.
  - **A room that fails three times in a row is left alone for thirty minutes.** A
    ref pointing at a deleted channel retried forever. Nobody is unsubscribed.
  - **One reply path.** Status updates and check-ins ran a copy that lacked the
    malformed-`pass` correction and the tool-activity record.

- b559646: Add rooms: shared multi-party conversations for agents and humans.

  A room is a named destination within a transport (a Discord channel) that
  several agents and people share, distinct from a `channel` (the transport
  itself) and a `session` (one participant's private history).

  - `RoomBackend` seam with a `local` (SQLite) and a `discord` implementation;
    backends register when a transport connects and unregister when it drops.
  - Addressing is `@name`; a participant with a Discord account is written as a
    real `<@id>` mention so they are actually notified, with `allowedMentions`
    allowlisting only the accounts a message addressed. Agents, having no
    account, stay plain text.
  - On Discord each agent posts through a channel webhook, so it appears as its
    own participant with its own name and avatar. Speaker envelopes
    (`[supervisor] @coder …`) remain the fallback where a transport has no such
    concept, so one bot account can still carry several identities. The speaker is stamped by core from the calling
    agent, never from model output, and is only trusted on messages from TAI's
    own account — a prefix typed by anyone else cannot impersonate an agent.
  - Exactly one agent hosts a room: the creator gets `addressed`, invitees get
    `named`, so a loose message gets one answer instead of one per agent.
  - Subscriptions with two independent axes: `deliver` (push/poll) decides when
    an agent looks, `wakeOn` (named/addressed/all/none) decides what makes it run.
    `named` keeps a room of several agents from all answering one loose question.
  - Runaway protection: an agent never wakes on its own message, an atomically
    consumed per-(agent, room) hourly wake ceiling, and burst debouncing. Wakes
    refused mid-run or by the ceiling are re-armed rather than dropped, and the
    watcher drains each backlog once on startup. A `maxAgentTurns` depth cap
    stops two agents being politely stuck at each other, which no single-message
    rule can detect. Reset by a human speaking, and by any turn that used a tool
    — collaboration looks identical to politeness, and tool use is what tells
    them apart, so agents working on a task are not silenced mid-task. A turn is
    a contiguous run from one speaker, so a long reply split across transport
    messages counts once rather than three times.
  - Posts reuse the NotificationGate with a window scaled by `urgency`
    (high ~15min, medium ~daily, low ~weekly). Replies to a direct address are
    exempt.
  - Each room has a `purpose` — standing instructions injected into every wake
    prompt and mirrored to the Discord channel topic so people see them too.
  - `/room` slash commands (create, ping, members, add, remove, purpose, status);
    `ping` autocompletes the agents in the room, so addressing never has to be
    guessed, and a misspelt `@name` is corrected when exactly one identity is
    close enough — otherwise a typo silently routes the message to the room host. A name is a call-out anywhere in a message, not just at the front. to manage a
    room from inside Discord. `/room status` asks every agent what it is working
    on by waking each directly, rather than faking a message from the person.
  - `room` tool (list/read/post/pass/create/invite/remove/members/purpose/subscribe/unsubscribe),
    where `pass` lets an agent decline to speak — without it, being woken
    guarantees a message and rooms fill with "Acknowledged." — and
    `room.message` / `room.woke` events for plugin-side behavior.

  Also adds `NotificationCandidate.windowHours` so any caller can scale repeat
  suppression per message rather than only per config.

- 682e304: Rooms: posting stops being pinging, plus reactions and per-room roles.

  - `OutboundRoomMessage.notify` (default false) separates writing to the record
    from interrupting a person. Addressing someone renders as plain `@name` —
    visible in the transcript, silent on their phone — and a real mention takes
    `notify: true`. Automatic replies never notify: an agent woken by a message is
    continuing a conversation, not raising something. (#276)
  - `RoomBackend.react` + `capabilities.reactions`, surfaced as
    `room(action="react")`. "Got it" costs a turn, wakes watchers and pushes the
    room toward its depth cap for no information; a reaction carries the same
    meaning at none of that cost. It removes the reason to speak, where
    `maxAgentTurns` only caps how often agents may. (#269)
  - A per-subscription `role` says what an agent is for in one room, under the
    room's `purpose`. The same agent coordinating a trip and reviewing code is not
    the same agent in both, and only its global instructions existed. (#270)

- d492806: Rooms: choose whether an agent remembers each room separately or all together, and make task ownership legible.

  `agents.<name>.roomSessionScope` is `room` (default, a session per room) or
  `shared` (one session across every room). Per-room isolation means an agent
  moved into a new room starts blank; `shared` lets an assistant carry a thread
  between places, at the cost of mixing unrelated context and growing history with
  the number of rooms rather than the conversation.

  `task_query` gains `mine`, which scopes to the calling agent, and every result
  now states ownership — `yours`, `assigned to X`, or `unassigned (not yours)`. An
  unassigned task previously rendered as bare text, so "no assignee" read as "no
  information": eleven agents freshly added to a channel each reported the same two
  unassigned personal tasks as their own in-flight work. Session history cannot
  answer "what am I working on" because it is per-room; durable state has to.

- dd3951c: rooms: stop `invite` undoing a wake mode, and stop posting raw tool-call markup

  Three fixes found by auditing what agents actually said:

  - **`invite` and `/room add` no longer reset an existing subscription's wake
    mode.** Neither takes a wake mode, so both wrote their own default over
    whatever the agent had chosen: an agent set itself to `all`, someone invited it
    to the room it was already in, and it dropped back to `named` — while the
    `subscribe` call that set `all` had truthfully reported success. Re-inviting is
    now a no-op on wake policy; only a call that names a mode changes one.
  - **Raw tool-call markup is corrected rather than posted.** A local model emitted
    `<tool_call> function=room> <parameter=action> post …` as prose and it went
    into the channel verbatim. It now gets the same one-round correction as a
    written-out `pass`, and is suppressed with a log line if it survives that. The
    message it meant to send is visible in the markup, but digging it out means
    parsing one model family's dialect and guessing — a wrong guess posts words the
    agent did not choose, under its name.
  - **Agents subscribed to a room without the `room` tool are named at startup.**
    Every wake prompt ends with "call `room(action="pass")` if you have nothing to
    add", which an agent whose `tools:` list omits `room` cannot do — so it types
    the instruction as prose, and from outside that looks like a model too weak to
    make a tool call. Four agents in one deployment were in this state, including
    the busiest. Warned, not auto-granted: withholding a tool is a config decision.

- 544aac2: Rooms: tell agents what day it is.

  Rooms are time-situated — check-ins fire on a clock, purposes carry dates,
  agents are asked how long until something — but an agent only knows the date if
  it happens to carry a clock tool, and most do not. It infers instead, and gets
  it wrong: a coordinator running a trip on an hourly check-in said "two days out"
  when it was one, and had the departure date wrong until corrected by hand.

  Every room prompt now opens with the current date. Ten tokens, no tool call,
  every agent. (#277)

- 87d2af3: Rooms: `/room reset`, visible wake reasons, and editable messages.

  - `/room reset agent:<name>` clears one agent's conversation for one room. A
    tool that was broken and then fixed does not help an agent whose history says
    it is broken — it stops trying, which is reasonable on bad evidence and
    impossible to argue it out of. Its read cursor is left alone, so it resumes
    from now rather than replaying what it just forgot. (#273)
  - `RoomWatcher.wakeReason` reports why an agent woke — named, a loose question
    from a person, watching everything, or a scheduled check-in — and the activity
    record leads with it. The reason was always computed and thrown away, which
    made wake policy guesswork to debug. (#267)
  - `RoomBackend.edit` + `capabilities.edit`, surfaced as `room(action="update")`.
    `post` now returns a message id. Rooms were append-only, so an agent checking
    in hourly posted an hourly notification whether or not anything had changed;
    one message that updates is quiet. Discord edits through the webhook that
    posted, since the bot cannot edit a webhook's message otherwise. (#268)

- c308241: The host and container sandboxes close a command's stdin too.

  The previous fix closed stdin in `ExecTool`'s own `execFile` call, which is not
  the path a running agent takes: `buildLoopOptions` gives every agent a sandbox —
  defaulting to `host` — so `ExecTool.execute` returns at its `context.sandbox`
  branch before reaching that code. The fix verified green in isolation while the
  live deployment went on hanging for the full timeout on every affected command.

  `HostSandbox.exec` and the container runner had the identical unclosed-pipe
  problem. Both now end the stream, so a CLI that reads stdin when it is not a TTY
  returns immediately instead of blocking until it is killed with empty output.

  Measured on the Notion CLI through a real agent: `ntn api v1/users/me` went from
  a 27-second failure to 235ms.

- cc792f2: Stop warning that the `schedule` tool is not enabled when it is.

  `validateConfig` builds its set of enabled tools from `config.tools` alone.
  `schedule` is gated by its own top-level `schedules:` block, because the tool is
  one surface on a subsystem that also runs a poll tick — so it never appeared in
  that set, and every agent listing it drew

      Agent "X" references tool "schedule" which is not enabled

  on every startup and every config write, while the tool was registered,
  resolvable, and being called successfully.

  A false warning is worse than none. It sits in the same list as the true ones —
  in the deployment where this surfaced, beside eleven real "room is not declared"
  warnings — and teaches an operator to skim the list rather than read it.

  Same shape as the `tasks`/`task_query` coupling handled directly above it, and
  fixed the same way.

- 7d273b5: Make TAI self-hostable: headless setup plus a Docker image.

  `tai init --non-interactive` writes config.yaml from flags and environment
  variables, so setup no longer requires a terminal. The Ink wizard was the only
  path to a config and it throws `TTYError` without a TTY, which made every
  unattended first run — container, cloud-init, CI — impossible. Running `tai`
  with no config and no TTY now prints that command instead of a React stack
  trace.

  Adds `docker/tai/` (Dockerfile, compose unit, `.env.example`): one container,
  one volume at `TAI_HOME`, first boot generates config and an API token, later
  boots leave the file alone. A root `.dockerignore` keeps `config.yaml`, `.env`,
  and `agent.db` out of every image build context. See `docs/self-hosting.md`.

  Two correctness fixes found on the way:

  - `server.proxyAuth` no longer counts as authentication in `validateConfig`.
    Its middleware is never mounted and the `/api/auth/login` endpoint its login
    page posts to does not exist, so enabling it authenticated nothing while
    silencing the warning that a non-loopback bind was wide open. It now warns
    that the setting is inert.
  - A fresh `tai init` no longer produces a config that warns at startup: the
    sample `researcher` agent claimed `web_search`, which defaults to disabled.

- 42a1e90: Send the agent's model, not the one stamped on its session.

  The loop sends `session.model`. Every server route creates the session before
  it knows which agent will handle the turn —
  `findOrCreateSession(db, key, runtime.getModel(), config.agent.defaultProvider)`
  — so the row carries the deployment defaults. The runtime's own paths resolve
  the agent first and were unaffected, which is why this only ever showed up
  through the HTTP API.

  Harmless while every agent shared one provider. The moment an agent could
  select its own, it became a mismatch in the worst direction: the request went
  to the agent's provider carrying the _global_ model name, so a correctly
  configured agent failed with `qwen3.6-27b-vllm is not a valid model ID` from
  OpenRouter.

  `buildLoopOptions` now reconciles the session against the resolved agent — the
  single place that knows both — and updates the row so the transcript records
  the model that actually answered.

- 2963457: One shared ladder for providers that learn a model's quirks from its 400s.

  Three providers had grown the same pattern independently — a bounded
  attempt ladder, a per-model memo of what the API refused, and warn-once
  plumbing — because the underlying problem is general: a per-model
  request-shape constraint that no static rule predicts, discoverable only
  by being told no.

  `runQuirkLadder`, `QuirkMemo` and `WarnOnce` now live in core next to the
  provider interface. `provider-openai` (both endpoints) and
  `provider-anthropic` use them.

  Recognition stays per-provider, deliberately. Which 400s are recoverable
  and what the corrected shape is, is vendor knowledge that does not
  generalise — every vendor words the same refusal differently, and OpenAI
  words it differently between its own two endpoints. A shared table of
  error patterns would be wrong within a release.

  Termination stays structural: a shape whose key has already been tried is
  never tried again, so the loop is bounded by the number of distinct
  shapes rather than a retry counter. The error text is the _input_ to
  recovery, so a reworded message must cost a missed recovery, never a
  hang.

  `ProviderHttpError` comes along, carrying status and body to the
  recognition step. Without it the only thing reaching `recover` is a
  message the provider formatted two lines earlier, and deciding "was that
  a 400?" by matching that string is the same mistake as inferring control
  flow from a model's prose. The message is unchanged, so anything catching
  or asserting on it is unaffected.

  No behaviour change: all 137 existing provider tests pass untouched.

- 9ec3100: The progressive-skill catalog tells agents that skills are not loaded, and when to load one.

  The block read "Activate one with `load_skill(name: <id>)`", which is an offer.
  An agent that believes it already knows the task has no reason to accept one, and
  that is exactly what happened: an agent woken for Notion work, with the notion
  skill in its catalog, made **zero** `load_skill` calls and worked from its own
  session history instead — repeating a broken pipeline the skill explicitly warns
  against, twice, in a warning it never read.

  The failure is silent. Nothing logs "the agent skipped its skill", and the answer
  often looks fine because the agent recovers by trial and error, several rounds
  later than it needed to.

  The block now states plainly that the instructions are **not** in the prompt, that
  each line is a label rather than the content, and that a skill should be loaded
  before starting a task it covers _including when the agent already believes it
  knows how_ — because a skill is the current shared instructions and gets corrected,
  while an agent's recollection is whatever happened to work last time.

  Costs about 100 extra tokens in the system prompt of agents that have progressive
  skills, and nothing for agents that do not.

- 248931d: Slash commands check who is asking.

  `shouldRespond` gates the MessageCreate path — self, other bots, the DM policy, `allowedGuilds`. Interactions arrive on a different listener and passed through none of it, so every slash command was reachable by anyone who could see the bot: `/pause` stops the deployment, `/memory set` rewrites an agent's core memory, `/room reset` clears history, `/clone-agent` writes a new agent into `config.yaml`.

  Two checks now run before any handler, in a new `discord-authorization.ts` that owns the policy and knows nothing about discord.js beyond the shape of an interaction.

  `allowedGuilds` was never a missing policy — it is declared config the interaction path simply never read. Honouring it is a bug fix.

  The owner check is new, and applies to commands that change state rather than report them. Which ones is a list (`OWNER_ONLY_COMMANDS`, `OWNER_ONLY_SUBCOMMANDS`), not an inference: a command's blast radius is not derivable from its name, and guessing wrong in either direction is worse than a list somebody maintains deliberately. `/memory show` and `/room members` stay open; `/memory set` and `/room reset` do not.

  When `channels.discord.owner` is unset, an owner-only command is refused with a message naming the key to set. Allowing it would mean the guard does nothing on exactly the deployments that never configured an owner.

  Autocomplete is gated the same way. It answers from config and the database — agent names, memory sections, room names — so suggesting them to someone who cannot run the command leaks what the command would have.

  The policy also accepts per-command restrictions declared by plugins, so a plugin can ship a privileged command without core knowing its name. Built-ins are checked first and cannot be relaxed by a plugin registering the same name.

- 4b54275: Strip orphaned `tool` messages from trimmed history so strict providers don't 400. Front-trimming (and the summarize-on-trim path) could leave a `role: "tool"`
  result whose `assistant` + `tool_calls` parent was dropped. Lenient providers
  (vLLM/qwen) ignore it, but OpenAI / Anthropic / Bedrock / DeepSeek reject it with
  "Messages with role 'tool' must be a response to a preceding message with
  'tool_calls'". `trimHistory`/`trimHistoryWithSummary` now run a
  `stripOrphanedToolMessages` pass (exported) that keeps a tool message only when a
  preceding assistant turn opened a matching `tool_call` id.
- 22f9b9e: Write the compaction summary as the agent's own note, not as something the user said.

  `compactSession` stored its summary as a `role: "user"` message. From the model's
  side that is the person on the other end having just narrated a third-person
  account of the conversation — so it continues the narrative instead of answering
  the message that actually arrived.

  Measured on a real companion session after compaction, replying to an ordinary
  greeting:

  | summary in history            | replies that carried on about events from the summary |
  | ----------------------------- | ----------------------------------------------------- |
  | as a `user` turn (before)     | **4 of 5**                                            |
  | reworded, still a `user` turn | 3 of 5                                                |
  | as an `assistant` turn        | **1 of 5**                                            |
  | no summary at all             | 1 of 5                                                |

  The role is doing the work; rewording it barely moved. As an assistant turn the
  summary reads as the agent's own note about earlier — context it already has,
  rather than a prompt to respond to.

  Symptom this fixes: an agent replying to one person with a message addressed to
  someone else, copied from the summarised history. `[assistant, user]` was checked
  against Anthropic, OpenAI and DeepSeek before changing this; all three accept it.

- d7656d8: Honour `TAI_HOME` everywhere, so `-c <config>` selects a whole instance rather than just a config file.

  `resolveHomeDir` read `TAI_HOME`, but nothing in the repo ever assigned it. Core is a library and never sees the CLI's flags, so every module that isolates per-instance state by reading the variable — the vault master key, the workflow secrets key, `exec-outputs`, `tool-outputs`, and the sandbox scratch allowlist — took its fallback branch on every run. Four more paths ignored the variable outright and resolved against `homedir()`: the resource trust store, the resource cache, and the registry index.

  The result was a home directory holding the config and database while its keys and cached output went somewhere else. The visible symptom on a real install is hundreds of session directories under `~/.tai/exec-outputs`, a path no config mentions.

  - New `taiHome()` / `taiHomePath()` in core is the single answer to "where does this instance keep its state", read from the environment on every call. Anything that caches it at module load captures the value from before the CLI publishes it.
  - The CLI now calls `adoptHomeDir()` at each entry point, which resolves the home and publishes it as `TAI_HOME`.
  - Scratch output moves from `~/.tai/{exec,tool}-outputs` to `<home>/{exec,tool}-outputs`. The old location stays on the sandbox read allowlist: truncated results hand the model an absolute path, and those pointers live in session history indefinitely.
  - `TrustStore` and `ResourceLoader` expose `storePath` / `cachePath`.

- afc05a2: Answer instead of returning a marker when a turn runs out of tool rounds

  A turn that spent `maxToolRounds` exited straight from the tool phase and
  returned `[Agent stopped: max tool rounds reached]`, discarding the work it had
  done. Measured on the benchmark's truncation scenario, 11 of 15 runs ended that
  way — and in each one the agent had already read the file, seen where it was
  cut, and tried three ways round it.

  The loop now makes one more call with the tools withheld and returns what the
  model says. Withholding is the mechanism: "stop calling tools and answer" is an
  instruction a model can decline, and a model that has spent every round reaching
  for a tool is the one that will. One extra request, only on the path that was
  going to return nothing; the marker still stands when the model says nothing,
  when the call fails, or when the caller has already aborted.

  Callers that detected a stall by matching the reply must move to `onStop` —
  `isStallStop(stop)`, or the new `stallReasonOf(stop)`. A stalled turn now
  usually returns ordinary prose. `detectStall(reply)` stays exported but is wrong
  in both directions: blind to a stall that answered, and it reports an operator
  cancelling a dispatch as one. The task watcher now reads the structured stop,
  which also stops it retrying cancelled dispatches.

- dd3951c: tasks: `task_query` requires `assignee`, and "unassigned" becomes a real answer

  The old default was everyone. That reads as harmless until an agent is asked
  what it is working on: it runs the widest query available and reports whatever
  comes back. In one deployment the only two `in_progress` rows were the owner's
  reading list — a novel and an audiobook, both unassigned — and three agents
  claimed them as work in flight. The claim then lived in each agent's own
  session, so later status updates repeated it with no tool call at all, and
  `REAMDE` drifted into "generating a README in Neal Stephenson's style".

  `assignee` now takes `"me"`, `"all"`, `"unassigned"`, an agent name, or a list.
  Omitting it is an error that names the options. No default is right — "everyone"
  is wrong for an agent reporting on itself and "me" is wrong for a planner
  surveying the board — so the caller says which it means. `mine: true` still
  works; it is the old spelling of `assignee: "me"`.

  `TaskFilter.assignee` gains `null` for "assigned to nobody", distinct from
  `undefined` for "no opinion". Conflating them is what made an unowned task look
  available, and therefore look like yours. Backends that cannot express the wider
  filter natively push down what they can and narrow the result in memory.

- 1ad506a: Preserve the host timezone through the clean launcher environment, add explicit
  `time.timezone` configuration, and expose a plugin-registerable time provider
  for runtime clocks and timezone-aware schedules.
- a1231c6: Timed wakes read from the cursor instead of re-sending the same messages for ever.

  Check-ins and self-booked scheduled wakes fetched a room with `cursor: null`,
  took the last ten messages, rendered them into a prompt, and never advanced the
  cursor. The rendered prompt is persisted to the session, so in a quiet room every
  firing stored another copy of the same block.

  Measured on a production deployment: 124 check-in prompts in one session
  collapsing to 23 distinct bodies, a single 1,115-token block stored 23 times, and
  roughly 89% of all duplicated prompt content in the database traceable to these
  two call sites. The message-wake path, which already read from the cursor and
  advanced it, produced almost no repeats — so this was cursor discipline rather
  than anything structural.

  Both paths now read from the cursor and advance it, like every other wake. A
  check-in is told what arrived since it last looked, and when nothing did it is
  told exactly that, which is both cheaper and more useful than being handed
  messages it has already acted on with nothing marking them as old.

  No context is lost. Earlier wakes leave the room's history in the agent's own
  session, and a first-ever wake still has a null cursor and still receives the
  backlog.

- 1d9e6a6: Token usage is recorded for every provider call, not just autopilot and exploratory.

  Recording lived in two callers, so `token_usage` was a ledger of those two
  subsystems and nothing else. Everything the loop actually runs day to day —
  chat, room wakes, cron, delegation — recorded nothing. On a live deployment that
  left the majority of traffic invisible: one agent ran 799 room messages in a
  fortnight and contributed not a single row, which makes "what is this costing
  me" unanswerable exactly where the answer matters.

  The loop now writes one row per provider call, before invoking the caller's
  `onUsage` so a throwing consumer cannot cost the accounting. Rows carry `agent`
  and `source` (`loop` | `autopilot` | `exploratory`), and the two workers pass
  their own label instead of recording themselves.

  Widening the table must not widen the autopilot budget, or a busy hour in the
  rooms would pause autopilot for reasons unrelated to autopilot. `checkBudget`
  and `/api/autopilot/usage` are therefore scoped to `BUDGETED_TOKEN_SOURCES`
  (autopilot + exploratory), which preserves what the caps meant before. Rows
  predating the column have a NULL source and still count, since that is what they
  were; a direct `recordTokenUsage` call that omits the source also stores NULL,
  so an external caller does not silently drop out of the budget.

  New `GET /api/usage?hours=` returns deployment-wide totals grouped by source and
  by agent.

- f0bb132: Core: let a tool end the agent's turn (`ToolResult.endsTurn`)

  Telling a model to stop _in a tool result_ does not work on small models. A tool
  whose entire meaning is "I am done" was still followed by another round-trip
  asking what to do next, and a 27B model answered by calling it again.

  Measured on a live deployment, over three scheduled room check-ins:
  `room(action="pass")` was called **3 times each**, 9 provider calls for 3
  decisions, 505,209 prompt tokens to say nothing — and every one of them exited
  through the repeated-call detector, so the most deliberate stop the loop has was
  reported as a stall.

  `ToolResult` gains `endsTurn` and `endsTurnReason`. The loop honours them after
  the round's results reach history and before the repeated-call detector, and
  reports `LoopStop { kind: "tool-ended", tool, reason }`, which `isStallStop()`
  correctly treats as a clean exit. `endsTurnReason` becomes the loop's return
  value; unset, it falls back to the model's own text, which for a tool meaning
  "nothing to say" is normally empty.

  The flag lives on the result rather than on the tool because a multi-action tool
  ends the turn on some actions and not others: `room` post and read continue,
  `room` pass does not. It is deliberately not gated on `success` — whether a tool
  worked and whether it meant to stop are separate questions. Where two calls in
  one round both set it, the first wins. The `pass` that finds no room to silence
  stays non-terminal: nothing was decided, and the agent still has a correction to
  act on.

  This replaces a private convention rather than adding a second one. `sleep` used
  to signal through `workingMemory["tick_done"]`, which the loop special-cased —
  a real platform capability that only core tools could discover, in a codebase
  whose rule is that built-ins register the way third parties do. `sleep` now
  returns `endsTurn`, and any tool can, including plugin and MCP tools.

  **Breaking (type-level):** `LoopStop`'s `{ kind: "sleep" }` variant is replaced
  by `{ kind: "tool-ended"; tool: string; reason?: string }`. Nothing branched on
  it in-tree — the exploratory worker tests only `isStallStop` and `max-rounds` —
  so runtime behaviour for ticks is unchanged, including the `[Sleep] <reason>`
  string that chat `live_state` reads.

- 19996ac: Transcript lines say what kind of speaker wrote them.

  `IdentityResolver` decides whether a room participant is an agent, a person, or
  nobody it recognises, and the room subsystem already uses that to decide wake
  and pause policy. It was discarded at render time, so a person's instruction and
  another agent's text reached the model as identical `role: "user"` bytes.

  Lines now read `planner [agent]:`, `sam [person]:`, `drive-by
[unrecognised]:`. Volatility decides where a block goes in a request;
  authorship decides how much weight it should carry, and nothing downstream — a
  prompt slot, a history composer, or the model — could express the second while
  the format did not carry it.

  Three properties this relies on: the marker is written by core from the resolved
  identity and never from message text; it appears on every line, because a marker
  that appears sometimes makes its absence meaningful; and an unresolved label
  renders `[unrecognised]` rather than falling through to a bare name, since that
  is the case that matters most.

- 28bb474: Stop the truncation marker telling agents to read a copy that returns the same cut.

  When a tool result is capped, the marker ended "To see more, narrow the request —
  fewer results, a filter, a smaller page size, or read the file above." Agents take
  that advice, at roughly two reads of the saved copy per run, and it could never
  have worked: `capToolOutput` is applied to every tool result, so reading the saved
  file is capped by the same function at the same limit on the same input and comes
  back byte-identical, elision included. `read` has no offset to page past the cut.

  The sentence is now accurate — repeating the call _or_ reading the saved copy
  returns the same result — at the same length. The saved path is still named,
  because that is how a person retrieves the full output.

  Measured rather than assumed: at 15 runs per arm the pass rate on
  `notices-a-truncated-tool-result` was 3/15 either way, and the reads of the saved
  copy did not drop. This lands because the old sentence was false, not because it
  moved a number; a longer version spelling out the consequence was tried in the
  same experiment, measured nothing, and was dropped.

- 244cdcf: Stop telling agents things that are not true

  Three places where a comment, a doc, or a string shown to the model described
  behaviour the code does not have. Each one had already cost something.

  - **`load_skill` no longer says `— scoped to: <path>`.** `activeSkill.rootPath`
    is set and read by nothing; `read`/`exec` confine against
    `workingDirectoryBoundary`, which is unrelated. The header told the model it
    was confined when it was not, and disclosed the install path to do it. The
    field stays, honestly documented — it is what a real enforcement would need
    (#287).

  - **`docs/skills.md` no longer claims `progressive` is the default.** The
    resolver falls back to `eager`, which then emits a deprecation warning: follow
    the doc, omit the key, get the path the doc says you are avoiding. The doc now
    says to write the key explicitly and notes that the CLI and UI already do.
    Fixed in the doc rather than the code — flipping a runtime default would
    silently change how live agents resolve skills.

  - **`config.ts` no longer says the `ask_user` inbox is relative to the global
    context dir.** It is one level above, deliberately: `global/` is injected into
    every agent's prompt, and an inbox there broadcast a queue of questions to all
    of them, which reported months-old entries as live work. The comment invited
    someone to put it back.

  Also adds a **Tool access** section to `docs/skills.md`, because `allowed-tools`
  means opposite things in the two modes — it grants under `eager` and restricts
  under `progressive` — and nothing said so.

- a00b73a: Type-check the global `agent:` block, which the shape walk skipped.

  `findShapeIssues` covered `agents.<name>.*`, `cron.jobs[]`, `tools.exec`
  and the `enabled` flag across the open bags. It never walked the global
  `agent:` block — where the deployment-wide defaults live. Reproduced
  against a live config: a bad `temperature` on a named agent was flagged,
  the identical mistake on `agent.temperature` was not.

  The case that bites is `agent.maxTokens: "8192"`, quoted the way YAML
  users write things. It reaches `if (params.maxTokens)`, and a non-empty
  string is truthy, so the guard does not catch it and the quoted value
  goes out on the wire. That is exactly what `quotingHint()` was written
  for; it just never got a chance to fire.

  Checked `.partial()`: this is a type checker, not a required-fields
  checker, and `DEFAULT_CONFIG` supplies anything the file omits.

  `tasks`, `memory.embeddings` and `memory.chunks` are now walked too —
  closed, all-scalar blocks where a quoted number hides best.
  `tasks.options` is deliberately left alone: it is the selected backend's
  own bag, and core does not know its shape. `rooms` remains unchecked; it
  is nested enough to want its own pass.

  Each schema carries the same `Identical<>` drift assertion the agent
  schema has, so a field added to one side and not the other is a compile
  error rather than a silent hole.

- b559646: Add a verification gate to the autonomous task loop. New built-in
  `builtin:verify-gate` plugin (off by default) subscribes to `task.transitioned`
  and bounces any task that reaches `done` without a recorded `VERIFY: PASS`
  verdict back to the review stage, escalating to a human after `maxBounces`
  rounds. Scope it to tagged work via `requireTags` (e.g. `["kind:code",
"kind:config"]`) so plain assistant tasks still self-close. Route the bounce
  per task kind with `reviewerByTag` (e.g. `{ "kind:config": "verifier",
"kind:code": "reviewer" }`) so a config / live-surface task can go to a
  non-worktree verifier (which curls the running instance) while code goes to the
  worktree reviewer — the verifier isn't blocked by the project-path guard. The autopilot worker
  now emits `task.transitioned` when it force-finalizes a task so the gate sees
  the autopilot path the same as an agent-driven close. This closes the
  "marked done without proof" hole — an implementer or the finalizer can no
  longer assert completion without the reviewer actually running the change's
  acceptance check.
- c50e55a: An agent is one entry in the wake queue, however many of its rooms are busy.

  The queue was keyed per (agent, room, trigger) — which is what every wake path did independently before the queue existed. So an agent watching ten rooms was scheduled ten times over, each scheduling knowing nothing about the other nine, and wake volume scaled with traffic rather than with the number of agents.

  Entry identity is now the agent. Enqueueing one that is already waiting merges the new room and trigger into its existing entry, so ten rooms and a thousand messages produce one entry naming ten rooms. The queue's length is bounded by agent count and never by how much arrives.

  Two merge rules worth knowing:

  - An entry fires at the earliest time any of its triggers asks for, so a poll tick that is already due is not held back by a message still inside its batching window.
  - More traffic can only make a turn **sooner**, never later. This is deliberately not a debounce reset: an agent in a room that never goes quiet would have its turn postponed indefinitely, which is starvation the old per-room debounce could produce.

  New `rooms.minWakeIntervalMinutes`, unset by default. It is the shortest gap between one agent's wakes, counted across every room it watches; triggers arriving inside the gap accumulate on the pending entry rather than starting another turn. Per agent and therefore no per-room override — a room does not get to decide how often an agent runs everywhere else.

  Be clear about the scope: this bounds how often an agent is _scheduled_. An entry naming ten rooms still starts a turn per room. Turning one due entry into one turn that reads every room at once is a change to the caller, with its own prompt, cursor and reply-routing decisions, and lands separately.

  Step 2 of 3 toward #344.

- bcc2159: One place decides when an agent is due to run.

  Three things start a room turn — a message arrives, a poll tick fires, a scheduled check-in comes due — and each owned its own timing and its own idea of "already handled". The message path debounced on `${agent} ${roomRef}`; the other two had no coalescing at all and leaned on the in-flight guard further down to sort out overlaps. Nothing could answer "is this agent already due, and why", which is the question everything about wake volume turns on.

  `WakeQueue` owns that and nothing else. It decides whether an agent is due and when; what runs when an entry comes due stays with the caller, so the poll path still filters its backlog and the check-in path still builds its own prompt.

  Behaviour is unchanged. The message path keeps its `batchSeconds` debounce, poll and check-in are still due the moment their interval fires, and the existing suite pins it.

  This is the first of three steps toward #344. Entry identity lives in one function, `queueKey`, and is per (agent, room, trigger) — exactly what the code did before. Making a wake per-agent, so an agent with ten busy rooms is due once rather than ten times, is a change to that function and to how entries merge, not a change to any caller. That is the whole point of doing this separately and first.

- 42d98c6: `validateConfig` now warns on unrecognized **top-level** `config.yaml` keys. A feature configured under a typo'd key, or one a newer doc describes but the installed version predates, was silently ignored before — the warning names the key, lists the supported keys, and hints at version skew. Top-level only: nested bags (`tools.<id>`, `providers.<id>`, `channels.<id>`, plugin config) stay open and are never checked. The recognized-key set is typed `Record<keyof AgentConfig, true>`, so it can't drift from the interface. New export: `KNOWN_TOP_LEVEL_CONFIG_KEYS`. Closes #252.
- b8a8da4: Say when `maxHistoryTokens` leaves no room for the conversation at all

  The history budget is `maxHistoryTokens - systemPrompt - tail - toolSchemas`, and since tool schemas started counting against it the schemas are the dominant term: 24 tools measure ~5,500 tokens, a 41-tool deployment ~10,900. `maxHistoryTokens` defaults to 2,000.

  A deployment that never tuned it therefore has a budget of zero: every message is dropped on every turn, and the symptom is an agent that cannot remember what was said a moment ago — indistinguishable, from the outside, from a bad model.

  Warns once per agent, naming the three numbers and the floor to clear. Warned rather than silently raised: building a bigger request than the model's context accepts would trade one quiet failure for another, and the right number depends on the model.

- cf2cd34: Give `listWorkflowRuns` a deterministic order for runs that tie.

  `started_at` is `datetime('now')` — second resolution — and the query
  ordered by it alone, so runs started in the same second tied and SQLite
  returned them in whatever order it liked. Anything asking for "the N
  newest" got an arbitrary N: `pruneOldRuns` deleted the log directory of a
  run it should have kept, and a fanned-out workflow listed its runs
  scrambled.

  Ordering now falls back to `rowid`, which is monotonic with insert order
  — the only meaning "newest" can have inside one second.

  This is also the likely cause of the intermittent `pruneOldRuns` test
  failure. That test had been avoiding the tie by sleeping 1.1s between
  runs, which spent 2.2s of wall clock on a correctness argument that
  depended on the suite not being under load; it now sets the timestamps
  explicitly instead. A second test pins the tie case directly: it fails
  against the old ordering and passes against the new one.

- Updated dependencies [571adba]
  - @tailored-ai/browser-mediator@0.1.10

## 0.1.9

### Patch Changes

- 4f992c9: Native MCP client support: declare Model Context Protocol servers under `mcp.servers` in config.yaml (stdio via `command` or streamable HTTP via `url`) and their tools are discovered and registered into the tool registry as `mcp_<server>_<tool>`, selectable per agent like any other tool. Servers reconcile on hot reload (start/stop/restart on config change), failed connections retry on the next reconcile, and `tools/list_changed` notifications re-discover live. The `@modelcontextprotocol/sdk` dependency is optional and loaded on first use.
  - @tailored-ai/browser-mediator@0.1.9

## 0.1.8

### Patch Changes

- c67120e: Route the autopilot worker's digest + notification delivery through the
  outbound registry instead of injected Discord accessors (#66, follow-up).

  `AutopilotWorker` no longer takes `getNotifier` / `getDiscord` / `getOwnerId`;
  it resolves the sink via `runtime.resolveOutbound()` and the recipient via the
  new `runtime.getOwnerId(channelId?)` — the real configured `channels[id].owner`
  (or undefined, so delivery is skipped when no operator is set, unlike
  `getPrimaryOwner().userId` which substitutes a synthetic `"owner"` for session
  keys). The CLI drops the Discord-specific autopilot wiring. Behavior is
  unchanged for a Discord deployment with an owner configured.

  Still on the legacy injected path (next steps): the workflow notify executor +
  Discord-message executor + the `dm` tool, all fed by the shared `getDiscord` /
  `getOwnerId` closures in `factories.ts` / `workflows/factory.ts`; and the
  `DiscordNotifier` default plugin (#142).

- ecb0d69: Add a config-gated Home "briefing" surface: an LLM-written greeting/summary of
  what happened, what needs the owner, and what's coming up.

  - core: `generateBriefing(runtime)` assembles a compact, data-only context from
    existing dashboard queries (blocked tasks, recently completed tasks + workflow
    runs in the last 24h, enabled cron jobs, recent `session-summary` notes), caps
    each list and the total length, then runs ONE provider completion using the
    system prompt from `config.briefing.prompt`. New `briefing` config block ships
    disabled by default (`{ enabled: false, prompt: <generic default>, ttlMinutes: 30 }`).
  - server: `GET /api/briefing` returns `{ enabled: false }` with no provider call
    when disabled; when enabled it serves a fresh cached briefing (TTL) or generates
    one (in-memory cache, single-flight guard). `POST /api/briefing/refresh` forces
    a regenerate and 429s if one is already running.
  - ui: Home renders a briefing card at the top when the feature is enabled, with
    relative timestamp and a refresh button; renders nothing when disabled.

  No behavior or token cost unless `briefing.enabled` is set.

- a6e26a4: Streaming chat end to end: `ChatStreamEvent` contract (delta/done) replaces the dead `ChatDelta`, `OpenAIProvider` + `AnthropicProvider` implement `chatStream`, the agent loop streams to a new `onTextDelta` sink (falling back to blocking `chat()`), and `POST /api/chat` emits SSE `delta` events the bundled UI renders live.
- e0b9bbe: Add config-gated chat suggestion chips: short, clickable prompts in the Chat
  empty state, generated by the LLM from current state.

  - core: `generateSuggestions(runtime)` reuses the briefing's data-only context
    (blocked tasks, pending forms, recent done tasks/runs, `session-summary`
    notes — capped at ~1200 chars) and runs ONE provider completion asking for
    `count` short prompts, one per line. Parsing is robust: leading bullets,
    numbering, and wrapping quotes are stripped, blanks and lines over 100 chars
    dropped, the list de-duplicated and capped at `count`; if fewer than 2 usable
    lines survive it returns `[]` so the UI falls back to its plain empty state.
    New `suggestions` config block ships disabled by default
    (`{ enabled: false, prompt: <generic default>, count: 4, ttlMinutes: 15 }`).
  - server: `GET /api/suggestions` returns `{ enabled: false }` with no provider
    call when disabled; when enabled it serves a fresh cached result (TTL) or
    generates one (in-memory cache, single-flight guard). TTL-only — no refresh
    endpoint.
  - ui: the Chat (and Chat dock) empty state renders the suggestions as
    ghost-button chips above the placeholder text when the feature is enabled and
    ≥2 are returned; clicking a chip sends it as a normal user message. The chips
    fade in when the fetch resolves, so a slow model doesn't jolt the layout.

  No behavior or token cost unless `suggestions.enabled` is set.

- c83c58c: Notification seams: core stops deciding who to notify and how. The autopilot
  worker, the `ask_user` tool, and the `channel_message` workflow executor no
  longer DM the owner inline — they emit typed runtime events that the new
  default `builtin:owner-notifier` plugin subscribes to and delivers. The
  autopilot task prompt becomes a config-overridable template.

  - New typed events on the runtime bus: `task.needs_human` (task errored/blocked),
    `digest.ready` (morning digest), `question.asked` (`ask_user`), and
    `form.completed` (channel_message owner-DM fallback).
  - New default plugin `builtin:owner-notifier` (seeded enabled in
    `DEFAULT_PLUGIN_MODULES`) resolves the owner via `runtime.resolveOutbound()` +
    `runtime.getOwnerId()` and DMs them — same channel/recipient resolution and the
    same autopilot quiet-hours suppression that lived inline. Disable it and
    subscribe your own handler to ship notifications anywhere (Slack, Telegram,
    email, pager).
  - New `config.autopilot.taskPrompt` template (vars: `{{task_id}}`,
    `{{task_title}}`, `{{task_description}}`, `{{prior_activity}}`), expanded by
    `buildTaskPrompt()`; `DEFAULT_CONFIG` ships the existing rules verbatim.
    `buildTaskPrompt` / `DEFAULT_AUTOPILOT_TASK_PROMPT` moved to
    `autopilot/task-prompt.ts` (re-exported from `autopilot/worker.ts`).
  - New `config.tools.ask_user.inboxFile` (default `"inbox.md"`) makes the
    out-of-autopilot inbox filename configurable.

  Behavior is identical with the default config + default plugins: every
  notification fires exactly as before, including quiet-hours suppression and the
  byte-identical task prompt. The `channel_message` executor only routes the
  implicit "DM the owner" fallback through the event bus; explicit `channelId` /
  `userId` / per-step `channel` targets stay direct deliveries.

- e4e239f: Plugin-mounted HTTP routes; move trusted-actions endpoints out of the core
  server (#206).

  Plugins can now mount HTTP routes on the TAI server through a framework-agnostic
  seam. Core owns a runtime `HttpRouteRegistry` of descriptors
  (`{ method, path, handler, auth?, absolute? }`) where the handler takes a simple
  `TaiHttpRequest` and returns a `TaiHttpResponse` — core never imports Hono.
  Plugins register via `ctx.http.register(...)` / `ctx.http.mount(prefix, ...)`,
  namespaced under `/api/ext/<plugin-id>/…` so they can't shadow core routes. An
  opt-in `absolute: true` escape hatch mounts a verbatim path for first-party
  packages preserving a legacy path; `auth: "none"` exempts a route from the
  server bearer check for service-called webhooks. The server iterates the
  registry after building its Hono app (`mountPluginHttpRoutes`) inside the
  existing `server.authToken` middleware; routes register at startup and survive
  reload (the registry persists; handlers read live runtime state).

  The Amazon-specific `/api/trusted-actions/*` endpoints (executor pass-throughs +
  the executor → TAI callback) move out of `@tailored-ai/server` into
  `@tailored-ai/trusted-actions` (`./plugin` subpath), registered through the new
  seam — the dogfood for the contract. They keep their historical paths via
  `absolute: true`, so the UI keeps working; the callback keeps its exact
  shared-secret auth via `auth: "none"`. The CLI auto-loads the route plugin as a
  runtime-context plugin when `trustedActions.enabled`, with the package as an
  `optionalDependencies`.

  No behavior change for existing deployments: the same endpoints respond at the
  same paths with unchanged auth.

- d398c93: Built-in tools now construct through the tool-factory registry, not an if-chain in createTools(). Every tool — memory, exec, read, write, web_fetch, web_search, facts, recall, tasks/task_query, notify_owner, claude_code, browser, md_to_pdf, projects, documents, extract_document, ask_user, and custom_tools — registers a factory in tools/builtin.ts on module load, identically to how external plugin tools register. createTools() is now a pure registry walk. The META_TOOL_NAMES constant replaces the hardcoded array in validateConfig. Zero behavior change: tool sets, constructor args, and config shapes are preserved exactly.
- c71e7de: Finish the channel-neutral sweep in the CLI: the setup wizard/TUI editor and
  the server runner stop special-casing Discord. The Discord channel
  implementation and the `channels.discord` config block stay legitimately
  Discord; only the channel-generic bookkeeping changed (single user, pre-1.0, no
  back-compat).

  CLI:

  - Outbound registration in `index.ts` is now channel-generic. Instead of
    tracking a single live `DiscordChannel` and registering/unregistering the
    `"discord"` id by hand, the runner walks every connected channel from the
    lifecycle manager and registers any that satisfies `OutboundNotifier`
    (`id` + `send` + `sendDM`) into the runtime's outbound registry. A
    `syncOutboundRegistry` helper reconciles registered ids against the live set
    on connect and on every reload, so Slack/Telegram/etc. drop in by id with no
    per-channel code.
  - TUI editor models channels as a generic `Record<string, boolean>` map. The
    reducer action `toggleDiscord` is now `toggleChannel { channelId }`; the
    ChannelsEditor renders one toggle row per channel id (sorted, stable), and
    the menu/detail panes iterate the map. `discord` is always seeded into the
    draft (default false) so the built-in shows even when absent from config.
  - The setup wizard still emits the built-in `channels.discord` block, but
    `hydrateFromYaml` / `patchExistingYaml` read and write through the generic
    `channels.<id>.enabled` map rather than a dedicated discord boolean, so the
    editor can toggle arbitrary channel ids.

  Core: neutralize the one autopilot log string ("no Discord target" → "no
  delivery target") so it matches the channel-neutral delivery path.

- 08ac997: Base system prompt no longer assumes the agent has no identity. It now checks context and memory first and only introduces itself when no identity exists anywhere — previously it would cold-introduce even when an identity context file was loaded.
- ef7fe84: Make generic core delivery channel-neutral and remove Discord coupling from
  code that isn't the Discord channel itself. These are breaking pre-1.0 renames
  with no aliases (single user, pre-V1).

  Renames (old → new):

  - Workflow step type `discord_message` → `channel_message`; executor
    `DiscordMessageExecutor` → `ChannelMessageExecutor`. The step gains an
    optional `channel` (outbound channel id; absent = default channel). The
    `DiscordSender` alias is gone — executors take `OutboundNotifier` directly.
  - Tool `discord_dm` (`DiscordDmTool`) → `notify_owner` (`NotifyOwnerTool`),
    resolved via `resolveOutbound(channel?)` / `getOwnerId(channel?)` with an
    optional `channel` param and channel-neutral error text.
  - Default plugin `builtin:discord-notifier` (`DiscordNotifier`) →
    `builtin:agent-notifier` (`AgentNotifier`). Delivery was already
    channel-neutral via `taskWatcher.delivery.{channel,mode,target}`; only the
    name/log-prefix changed.
  - Config tool key `tools.discord_dm` → `tools.notify_owner` (now
    `{ enabled; channel? }`).
  - Barrel: `buildDiscordNotification` is exported as `buildNotification`;
    `DiscordSender` / `DiscordMessageExecutorOptions`-as-was are dropped in favor
    of `ChannelMessageExecutorOptions`.

  The `notify` and form-`notify` channel fields are now open strings: `email`
  and `log` keep their special cases, every other value is an outbound channel id
  resolved from the runtime's outbound registry.

  Two cheap config migrations (only back-compat kept):

  - `migrateDefaultPlugins` rewrites an existing `builtin:discord-notifier`
    entry (string or object form, preserving `enabled` / `config`) to
    `builtin:agent-notifier`.
  - `loadConfig` moves a legacy `tools.discord_dm` block to `tools.notify_owner`.

  Bug fix: the runtime config-reload path rebuilt tools WITHOUT the outbound
  accessors, so reloaded `notify_owner` / `ask_user` tools silently lost channel
  access. Reload now passes the same `resolveOutbound` / `getOwnerId` accessors as
  the constructor.

  The legitimately-Discord channel implementation
  (`channels/discord*.ts`, `DiscordChannel`, `getDiscordConfig`, the
  `builtin:discord` channel factory) keeps its names. Behavior for a
  Discord-configured install is unchanged — channel id `"discord"` still works.

- ff81e89: Add a channel-neutral operator identity so the task-watcher no longer hardcodes
  Discord (#155).

  New `config.defaultChannel` names the deployment's primary channel (a key in the
  existing opaque `channels` map). `runtime.getPrimaryOwner()` resolves the
  operator — `{ channelId, userId, displayName }` — from that channel's `owner`,
  falling back to the first channel that declares an owner, then the first
  registered channel. The task-watcher's no-agent "primary session" routing and
  its prompt owner-name now go through this instead of `getDiscordConfig().owner`

  - a hardcoded `"discord"` channel id.

  Back-compatible: a Discord deployment with `channels.discord.owner` set and no
  `defaultChannel` still resolves to `{ channelId: "discord", userId: <owner> }`,
  preserving the existing `discord:<owner>` session key. Prerequisite for the
  channel-neutral outbound router (#66) and per-plugin channel routing (#142).

- 290f96d: Register the four default plugins through `config.plugins` (#142).

  `DiscordNotifier`, `ScopeCreepFlagger`, `StallGuard`, and `CoderProjectGuard`
  were hardcoded `new …()` constructions in the CLI's `runServer()`. They now
  ship as `builtin:*` entries in `config.plugins` and load through the existing
  config-driven `loadPlugins` path, so they are user-toggleable.

  - `PluginContext` gains `runtime?` (the live `AgentRuntime`) and a per-entry
    `config` bag; each plugin module adds a `default` `register(ctx)` export that
    wraps its class and returns a disposer.
  - `loadPlugins` threads each entry's `config` into `ctx.config`, captures the
    disposer on `LoadedPlugin.stop`, and skips `{ module, enabled: false }`
    entries.
  - The CLI importer resolves a `builtin:<name>` prefix to
    `@tailored-ai/core/plugins/<name>` (new `./plugins/*` subpath export); no
    builtin allowlist.
  - `DEFAULT_CONFIG.plugins` seeds the four defaults, and `migrateDefaultPlugins`
    re-appends any missing `builtin:` entry on load — so **`enabled: false` is the
    durable off switch**; deleting an entry is re-added by the migration.
  - Fixes a latent reload bug: `runtime.reload()` calls `events.clear()`, which
    silently killed the default plugins' subscriptions until restart. The
    `onReload` hook now disposes and re-loads the runtime plugins.

  A default install behaves identically. The `scope-creep.ts` module is renamed
  to `scope-creep-flagger.ts` so its subpath export matches the
  `builtin:scope-creep-flagger` entry.

- 04181f5: Open the `delivery.channel` union to a `{ channel?, mode?, target? }` shape so
  task-watcher and cron delivery can target any channel id, not just Discord
  (#142, Option A).

  `TaskWatcherConfig.delivery` and `CronJobConfig.delivery` previously pinned
  `channel` to a closed `"log" | "discord" | "discord-dm"` set that conflated
  _which_ channel with _channel-post vs DM_. Now `channel` is an open id (resolved
  against the runtime's outbound registry via `getOutbound`) or the reserved
  sentinel `"log"` (console only, the default when omitted), `mode` is
  `"channel"` (post via `send`, default) or `"dm"` (direct message via `sendDM`),
  and `target` is the room id (channel mode) or user id (dm mode, defaulting to
  `getOwnerId(channel)`).

  A new idempotent `migrateDeliveryConfig` (run in `loadConfig` and
  `mergeProjectOverlay` alongside `migrateTaskBackendConfig`) maps the legacy
  string values onto the new shape, preserving `target`: `"discord"` →
  `{ channel: "discord", mode: "channel" }`, `"discord-dm"` →
  `{ channel: "discord", mode: "dm" }`, `"log"` → `{ channel: "log" }`. Existing
  configs keep working with no edits. The `DiscordNotifier` plugin and
  `CronScheduler.deliver` share the same resolution logic; cron's old
  `getDiscordConfig(...)?.owner` DM fallback is replaced with
  `runtime.getOwnerId(channelId)`. The other half of #142 — registering the
  default plugins through the config-toggleable loader — is separate/upcoming.

- 330a6c5: De-role the task watcher: no more hardcoded `coder`/`reviewer` agent names or
  personal workflow preambles in core (#204).

  What moved where:

  - New `AgentDefinition` fields: `worktree?: boolean` (task-watcher dispatches
    to this agent run in an isolated git worktree on a per-task branch) and
    `taskPreamble?: string` (a prompt template prepended to dispatch prompts,
    expanded with `task_*`, `action`, `project_id`, `owner_name`,
    `worktree_path`, `worktree_branch`). Both are surfaced on `ResolvedAgent`
    and parsed for registry-defined agents.
  - `TaskWatcher` keys worktree creation off the resolved agent's `worktree`
    flag instead of `agentName === "coder" || "reviewer"`, and prepends
    `taskPreamble` (when set) instead of the two ~115-line hardcoded
    coder/reviewer preambles, which are deleted. New runtime helpers
    `getAgentDefinition(name)` and `getWorktreeAgentNames()`.
  - GitHub task backend no longer ships `DEFAULT_AGENT_ROLES` (the personal
    email-fetcher/classifier/planner/... list). The factory now derives the
    agent-role set from `config.agents` keys + `config.taskWatcher.agent` +
    `tasks.options.agentRoles`. The `agent:<name>` label mechanics are unchanged.
  - `builtin:coder-project-guard` (id kept for config compatibility) now guards
    the worktree-opted agents (or an explicit `agents: string[]` from its config
    bag) rather than the names coder/reviewer.
  - `builtin:scope-creep-flagger` now watches worktree-opted agents and fires on
    handoff to a different configured agent; configurable via `watchAgents` /
    `reviewerAssignee`.
  - `builtin:stall-guard` blocked-reason uses the actual agent name
    (`<name>-stalled`) instead of the literal `coder-stalled`.

  BREAKING (behavioral) for installs that relied on the names `coder`/`reviewer`:
  those agents no longer get an automatic worktree or role preamble. To restore
  the old behavior, add `worktree: true` and a `taskPreamble:` to each of those
  agents in your config, and (if you use the GitHub backend) make sure the agent
  names appear under `agents:` so they keep routing to `agent:<name>` labels.

- d927a26: Resolve the `DiscordNotifier` default plugin's Discord sink from the runtime's
  outbound registry instead of a constructor-injected notifier (#66, #142).

  `DiscordNotifier` now takes only `{ runtime }` — the `notifier` option, the
  private notifier field, and `setNotifier()` are gone. At delivery time it reads
  `runtime.getOutbound("discord")` (keeping the existing "Discord is not
  connected" guard) and resolves the `discord-dm` owner fallback via
  `runtime.getOwnerId("discord")`. The CLI drops the now-dead injected-notifier
  machinery (`_discordNotifier` global, the `notifier` local, the
  `setNotifier()` hot-swap on reload). This was the last consumer on the legacy
  injected path — cron, autopilot, the workflow engine, the createTools tools,
  and now this plugin all resolve the Discord sink through the registry. Behavior
  is unchanged for a Discord deployment with an owner configured. Opening the
  `delivery.channel` union beyond `"discord"` is the remaining #142 work and is
  separate.

- 02c0a5a: The daily memory-hygiene sweep schedule is now configurable via `autopilot.memorySweepCron` (default `"14 3 * * *"`, the previous hardcoded value). An empty string disables the sweep; an invalid expression logs a warning and disables it instead of crashing the worker.
- 98160f3: DEFAULT_CONFIG no longer ships a specific local model name (`devstral-small-2:latest`). `providers.openai_compatible.defaultModel` defaults to empty; `validateConfig` warns until a model is set, and `tai init` discovers installed models as before. The deprecated `providers.ollama` migration also stops injecting the model name.
- 14fdab3: The `tools` config section is now an open map (`[toolId: string]: { enabled?: boolean; ... }`): plugin tools read `tools.<id>` through the index instead of needing typed slots in core. The `gmail` / `google_calendar` / `google_drive` shapes move out of core's `AgentConfig` into `@tailored-ai/google-tools`, and `validateConfig` no longer special-cases those tool ids (the plugin already warns and skips at factory time when `account` is missing).
- ba79819: Add a channel-id-keyed outbound-notifier registry on the runtime (#66, first
  step). `registerOutbound` / `unregisterOutbound` / `getOutbound` / `listOutbound`
  let consumers resolve a live delivery sink by channel id instead of being
  hand-injected the single Discord notifier, and `resolveOutbound(channelId?)`
  applies the channel-neutral fallback (explicit id → `config.defaultChannel` via
  `getPrimaryOwner`).

  The Discord channel registers itself into the registry on connect and on
  config reload (CLI). `CronScheduler` now resolves its sink through
  `runtime.getOutbound("discord")` instead of a constructor-injected notifier —
  its `notifier` / `discord` options and `setNotifier` / `setDiscord` are removed.
  Behavior is unchanged (cron still delivers to Discord). Autopilot, the
  DiscordNotifier default plugin, and the workflow notify executor still use the
  existing path; migrating them — and opening the `delivery.channel` union — is
  the follow-up (#142).

- 04181f5: Source the Discord delivery accessor for `discord_dm` and `ask_user` from the runtime's outbound registry instead of CLI-wired closures. `createTools` now narrows `getDiscord` to `OutboundNotifier`, and `AgentRuntime` wires `getOutbound("discord")` / `getOwnerId("discord")` into the tool factory so the CLI no longer hand-injects them (#66).
- f240f5e: Plugin self-description and config validation: optional `meta` and `validateConfig` named exports on plugin modules, captured by the loader onto `LoadedPlugin`, surfaced via the new `GET /api/plugins` route and startup warnings. `tai plugin list` shows package descriptions. The builtin plugins, channel-slack, and google-tools ship reference `meta`/`validateConfig` implementations.
- 10bfad3: Provider plugin utilities: `runProviderContractSuite` + `assertValidChatResponse` in `@tailored-ai/core/testing` (contract coverage for provider plugins in ~10 LOC), and the optional `AIProvider.listModels?()` discovery capability — implemented by the OpenAI-family and Anthropic built-ins.
- c759128: Retire the built-in `openai` and `anthropic` provider registrations (#236) — they live in `@tailored-ai/provider-openai` and `@tailored-ai/provider-anthropic` now. Core keeps `openai_compatible`; unknown provider ids fail with a plugin install hint; the server model-list endpoint and editor provider rendering are now generic over registered providers.
- a655023: feat(core): sandbox backend registry — open selector, built-ins register like plugins (#17)
- 877795c: Add the `builtin:session-summarizer` plugin — cross-channel continuity, shipped
  disabled by default.

  Sessions are hermetic per-channel silos (`discord:<user>`, `web:<key>`), and
  nothing summarized an idle session, so a new session on a different channel
  started cold. This opt-in plugin runs a periodic sweep (`sweepIdleSessions`)
  that summarizes idle sessions, then refreshes the always-injected
  `recent_summary` core-memory section — the channel-agnostic layer the agent
  loop reads on every turn — so the next session anywhere sees what recently
  happened. Composed from the most recent summaries (newest first), hard-capped
  (~600 bytes) so the always-injected layer stays small for local models.

  It autonomously calls the LLM and writes memory, so it ships `enabled: false`
  (new `DEFAULT_DISABLED_PLUGIN_MODULES` tier; `migrateDefaultPlugins` seeds it
  disabled and never flips a user's opt-in back off). No behavior change for
  anyone who doesn't enable it. Knobs (`intervalMinutes`, `idleMinutes`,
  `maxPerSweep`, `keyPrefixes`, `updateRecentSummary`, `recentSummaryCount`,
  `recentSummaryMaxBytes`) come from the plugin's `config` bag.

  Also adds `sessionId` to `SummarizeSessionResult` so sweep callers can map a
  result back to its source session.

- 773e16c: Built-in workflow step executors now construct through StepExecutorRegistry factories (#62).

  `createWorkflowEngine` no longer maintains a hardcoded executor array; instead it
  calls `StepExecutorRegistry.buildAll(ctx)` on the runtime's registry. Built-ins
  register factories via `populateBuiltinExecutors` (a side-effect called inside
  `createWorkflowEngine`). Plugins register custom step types through
  `ctx.stepExecutors.register(type, factory)` in their plugin function — factories
  run in the same pass as built-ins, giving plugins first-class parity. Existing
  workflow YAML and step-type strings are unchanged.

- 1747dbe: Stop privileging the built-in Discord channel in config. `config.channels`
  is now a uniform id-keyed map of `{ enabled?, ...opaque options }` — the
  special-cased typed `channels.discord` block is gone. The Discord channel,
  like any plugin channel, owns its own schema: a new dependency-light
  `channels/discord-config.ts` exports `DiscordConfig` + `getDiscordConfig()`,
  which parses the opaque slice once. All readers (the Discord channel itself,
  the cron scheduler, the discord-notifier plugin, the task-watcher, and the
  CLI) go through it, so core carries no per-channel types.

  Non-breaking: existing `channels.discord: { token, owner, … }` configs stay
  valid (they're already option bags) — no migration, no fixture changes. The
  `enabled` flag stays first-class on every channel via the map's value type.

- ef1e01c: Stop privileging built-in LLM providers in config. `config.providers` is now
  a generic id-keyed map of backend-opaque option bags
  (`{ [id: string]: Record<string, unknown> }`) instead of three typed blocks
  (`openai_compatible` / `openai` / `anthropic`). Each provider — built-in or
  plugin — reads its own slice (`baseUrl` / `defaultModel` / `apiKey`, plus
  `name` for openai_compatible); core carries no per-provider schema.
  `agent.defaultProvider` still selects the active provider by id.

  `populateBuiltinProviders` now registers every configured provider whose
  factory is available by iterating the map, instead of hard-coding the three
  built-in ids. The editor's `ProviderKind` widens to `string` so any
  registered provider id is valid.

  Non-breaking: existing flat `providers.openai_compatible: { baseUrl, … }`
  configs remain valid (they're already option bags), so no migration is
  needed and existing config files keep working unchanged.

- cdc0034: Default the workflow engine's Discord delivery to the outbound registry (#66,
  follow-up). `createWorkflowEngine` now resolves `getDiscord` /`getOwnerId` from
  `runtime.getOutbound("discord")` / `runtime.getOwnerId("discord")` when the host
  doesn't pass them, so the notify, discord-message, and form executors no longer
  need the live Discord channel hand-injected. The CLI drops the `getDiscord` /
  `getOwnerId` it was passing to `createWorkflowEngine`. Behavior is unchanged —
  `getOutbound("discord")` returns the same channel instance the CLI registers,
  and `getOwnerId("discord")` reads `channels.discord.owner`. Callers may still
  override both (e.g. tests).
  - @tailored-ai/browser-mediator@0.1.8

## 1.0.1

### Patch Changes

- e568706: Stop privileging built-in task backends in config (matches the `repo`
  backend treatment). `tasks.backend` is now an open `string` resolved
  through the task-backend registry instead of the closed union
  `"native" | "github" | "beans" | "beads"`, and backend-specific settings
  move to a generic, opaque `tasks.options` bag the selected backend reads
  itself — the same path a third-party backend uses. Core carries no
  per-backend schema, and `validateConfig` no longer hard-codes a list of
  valid backend names or github-specific checks (an unknown backend throws a
  dynamic `Known: …` error at construction; a github backend missing
  `options.repo`/`options.token` throws with a clear message).

  Backward compatible: the legacy `tasks.github` / `tasks.beans` /
  `tasks.beads` blocks are folded into `tasks.options` at load (and on
  project overlays) with a deprecation warning, mirroring the existing
  `providers.ollama` migration.

  - @tailored-ai/browser-mediator@1.0.1

## 1.0.0

### Minor Changes

- 274de6f: Add the `RepoBackend` contract + default `gh` implementation — Slice 4 of
  the platform vision (`docs/platform-vision.md`, `docs/repo-backend.md`).

  `RepoBackend` is the forge seam: `pushBranch`, `openProposal`,
  `getProposalState`, `mergeProposal`, `closeProposal`, normalized around a
  forge-neutral `Proposal` (PR / MR / change). The default `GhRepoBackend`
  wraps the `gh` CLI through an injectable `CmdRunner`; GitLab / Gitea /
  Bitbucket / trunk-based workflows register their own backend via
  `registerRepoBackendFactory` (exposed to plugins as `ctx.repoBackends`).

  Backend selection is **opt-in**: with no `repo.backend` configured,
  `createRepoBackend` returns `undefined` and core neither pushes nor opens
  proposals — today's behavior is unchanged. Setting `repo.backend: github`
  lights up the default.

  Built-ins are not privileged: `repo.backend` is a plain `string` resolved
  through the registry, and backend-specific settings live in an opaque
  `repo.options` bag the selected backend reads itself (the github backend
  reads `options.repo` / `options.token`). Core carries no per-forge schema.

  New `repo.*` events on the runtime bus: `repo.proposal.opened` /
  `.merged` / `.closed` are emitted by the default backend; `.reviewed` and
  `repo.check.completed` are declared placeholders for a future forge
  webhook bridge. This is purely additive; migrating the reviewer-approve
  flow to call the backend is a follow-up.

### Patch Changes

- @tailored-ai/browser-mediator@1.0.0

## 0.1.6

### Patch Changes

- 4201cc9: Extract coder/reviewer project_id guardrail out of TaskWatcher into a
  `CoderProjectGuard` default plugin — Slice 3 step 4 of the platform
  vision (`docs/platform-vision.md`). The watcher emits `agent.dispatched`
  via `bus.emitAsync(...)`; the guard subscribes and returns `false` to
  veto when a coder or reviewer is about to dispatch without an isolated
  worktree. Watcher honours the veto and skips the dispatch.

  **New EventBus capability: `emitAsync` with veto semantics.**

  `EventBus.emitAsync<K>(event, payload): Promise<boolean>` is the
  synchronous-causality variant of `emit`. It awaits every subscriber
  (sequentially, in registration order) and returns:

  - `true` when no handler vetoed
  - `false` when any handler returned `false`

  A throwing handler is logged and treated as non-veto, so a buggy
  observability plugin can't accidentally block real work. The handler
  type widens to `void | boolean | Promise<void | boolean>` —
  `undefined`/`true` returns are equivalent and the common case stays
  side-effect-only.

  **New event: `agent.dispatched`.**

  Payload `{ taskId, projectId, agentName, task }`. Fired by the watcher
  _before_ it starts the agent loop; the guard's veto causes the watcher
  to skip resolveAgent / session setup / worktree creation / loop
  entirely. Same hard guarantee the watcher used to enforce inline.

  - New `packages/core/src/plugins/coder-project-guard.ts` with
    `CoderProjectGuard`. On veto, writes a BLOCKED comment + transitions
    the task to `blocked` (same shape the watcher used to write).
  - Watcher drops the two inline guard checks (~36 LOC), removes the
    now-unused `addTaskComment`/`updateProjectTask` imports and the
    `WATCHER_COMMENT_AUTHOR` constant.
  - CLI constructs `new CoderProjectGuard({ runtime })` alongside the
    other defaults; stops on shutdown.

  11 new tests in `coder-project-guard.test.ts` cover the veto path
  (missing project_id, missing project path), the allow path (non-coder
  agents, valid project, default routing), `stop()` lifecycle, and the
  new `TypedEventBus.emitAsync` (empty subscribers, void/true returns,
  explicit false veto, sequential ordering, throw-as-non-veto).
  Pre-existing watcher tests construct the guard so the same invariants
  remain pinned. 1419 tests pass overall.

  This closes Slice 3 of the platform vision. Slices 1, 2, 3, 5 are
  shipped; Slice 4 (RepoBackend / Notifier / ApprovalSurface contracts)
  follows.

- 4201cc9: Extract scope-creep flagging out of TaskWatcher into a
  `ScopeCreepFlagger` default plugin — Slice 3 step 2 of the platform
  vision (`docs/platform-vision.md`). The plugin subscribes to
  `agent.completed` and, when the coder hands off a worktree branch to
  the reviewer, scans the branch's commits for foreign `ptask_*` ids
  and writes a SCOPE WARNING comment when it finds any.

  **Bug fix**: the watcher's inline implementation ran git inside
  `worktree.path`, which is gone by the time the check runs on a clean
  coder→reviewer handoff (worktree.cleanup() removes the dir before the
  scope-creep block executes). The plugin now runs git in the parent
  repo and references the branch by name, so it works in both the
  preserved and cleaned-up cases. `detectScopeCreep`'s signature changes
  from `(worktreePath, expectedTaskId)` to
  `({ repoPath, branch, expectedTaskId })` to reflect this.

  - New `agent.completed` payload field: `worktree?: { repoPath,
worktreePath, branch, preservedPath }`. The watcher captures
    `worktreeRepoPath` at creation time so it can attach the parent-repo
    path to the event even after cleanup.
  - New `packages/core/src/plugins/scope-creep.ts` with
    `ScopeCreepFlagger` and a thin `writeScopeWarning` helper.
  - Watcher drops the inline scope-creep block (~26 LOC) and the
    unconditional `addTaskComment` import path that fed it.
  - CLI constructs `new ScopeCreepFlagger({ runtime })` alongside
    `new DiscordNotifier(...)` and stops both on shutdown.

  9 new tests cover the gate (3 cases that should be ignored), the
  write path (2 cases including the parent-repo-not-worktree assertion),
  git error handling, stop()/dispose, and the formatter shape.

  Slice 3 step 3 (stall guard as a plugin, using a new
  `task.dispatch_requested` event for re-fire) follows as a separate PR.

- 4201cc9: Extract stall detection + retry out of TaskWatcher into a `StallGuard`
  default plugin — Slice 3 step 3 of the platform vision
  (`docs/platform-vision.md`). The watcher emits `agent.stalled`
  instead of `agent.completed` when the loop response carries an
  `[Agent stopped: …]` terminator; the guard subscribes and either
  requests a retry or transitions the task to blocked.

  **Two new events:**

  - `agent.stalled` — emitted by the watcher when `detectStall(response)`
    returns a reason. Same payload as `agent.completed` plus
    `stallReason: string`. Lets observability plugins react to stalls
    separately from clean completions.
  - `task.dispatch_requested` — emitted by the StallGuard when it wants
    the watcher to re-fire routing on a retry. Payload is
    `{ taskId; projectId?; reason: string }`. The watcher subscribes
    in its constructor and forwards to `notify({...}, { force: true })`.
    Any plugin (a future scheduler, a remote-signal handler) can emit
    this and the watcher will route accordingly.

  **Behavior preserved.** Comment shape (`STALL #N: …`), retry count
  (`taskWatcher.maxStallRetries`, default 1), decompose-hint on block,
  500ms delay before re-fire — all identical to the old watcher path.
  On the out-of-retries branch the guard re-emits `agent.completed` with
  the new `finalTask.status = "blocked"` so the DiscordNotifier (which
  only subscribes to `agent.completed`) still sees the terminal
  transition. StallGuard subscribes to `agent.stalled` only, so the
  re-emit doesn't loop.

  - New `packages/core/src/plugins/stall-guard.ts` with `StallGuard`,
    `countPriorStalls`, and `formatStallComment`. Constructor accepts
    an optional `maxStallRetries` override for tests.
  - Watcher drops `handleStall`, `formatStallComment`,
    `summarizeWorktreeChanges`, and the unused `STALL_COMMENT_PREFIX`
    helper from inside the class. `detectStall` stays exported.
  - `TaskWatcher` subscribes to `task.dispatch_requested` in its
    constructor and disposes on `stop()`.
  - CLI constructs `new StallGuard({ runtime })` alongside the other
    default plugins and stops it on shutdown.

  10 new tests in `stall-guard.test.ts` cover retry, block, re-emit,
  override, lifecycle. Pre-existing handleStall + formatStallComment
  tests removed from `task-watcher-notification.test.ts` (they exercised
  the now-deleted watcher private API). 1408 tests pass overall (was
  1405).

  - @tailored-ai/browser-mediator@0.1.6

## 0.1.5

### Patch Changes

- b443c8e: Extract Discord delivery out of TaskWatcher into a `DiscordNotifier`
  default plugin — Slice 3 step 1 of the platform vision
  (`docs/platform-vision.md`). The watcher emits `agent.completed`
  when a loop returns; `DiscordNotifier` subscribes and decides whether
  to deliver based on the final task state.

  - New `agent.completed` event in `RuntimeEventMap`. Payload carries
    `taskId`, `projectId`, `agentName`, the initial + final task
    snapshots (id/title/description/status/assignee), and the agent's
    response.
  - New `packages/core/src/plugins/discord-notifier.ts`. `DiscordNotifier`
    class constructed with `{ runtime, notifier? }`, subscribes on
    construction, disposes on `stop()`. Owns `shouldSuppressDelivery`,
    `buildNotification`, `nextActionHint`, `findBranchInTaskComments`,
    `isKnownAgent`, the `deliver` channel-routing logic, and the
    `emojiForStatus` helper. Notifier is mutable via `setNotifier()` so
    the CLI can swap it on Discord connect / disconnect / reload.
  - `TaskWatcher` loses `notifier`, `setNotifier`, `setDiscord`, `deliver`,
    `buildNotification`, `nextActionHint`, `findBranchInTaskComments`,
    `shouldSuppressDelivery`, and `isKnownAgent`. After agent loop +
    stall handling + scope check, it emits `agent.completed` instead
    of inlining delivery. The watcher's responsibility narrows to
    routing + dispatch.
  - CLI constructs `new DiscordNotifier({ runtime, notifier })` alongside
    `new TaskWatcher({ runtime })`, and the hot-reload notifier-swap
    now calls `discordNotifier.setNotifier` instead of the watcher.

  No behavior change for users. The delivery rules + envelope formatter
  are byte-identical to before — the tests that pinned the format moved
  to `discord-notifier.test.ts` and still pass.

  Slice 3 step 2 (stall-guard + scope-creep flagger plugins) and step 3
  (project_id guardrail plugin) follow as separate PRs, building on
  this event surface.

  - @tailored-ai/browser-mediator@0.1.5

## 0.1.4

### Patch Changes

- b163368: Wire task lifecycle emissions onto the runtime event bus — Slice 2 of
  the platform vision (`docs/platform-vision.md`). The `tasks` tool now
  emits typed `task.created` / `task.updated` / `task.transitioned` /
  `task.commented` events alongside the legacy `notify` watcher
  callback. Plugins can subscribe via `ctx.events.on(...)` without
  reaching into the watcher class.

  - `TasksTool` accepts an optional `{ events }` options bag. On a
    successful `create`, it emits `task.created`. On `update`, it diffs
    the before/after task and emits `task.updated` with the changed
    field list. If status changed, it fans out a separate
    `task.transitioned` with `from`/`to`/`assignee`. If the update path
    posted a status-change comment, it also emits `task.commented`.
    On `comment`, it emits `task.commented`.
  - `AgentRuntime` threads `runtime.events` through to `createTools`,
    so any tool factory wired to a runtime gets the bus automatically —
    the CLI doesn't need to wire it explicitly.
  - `createTools` accepts `events?: EventBus` in its options and forwards
    it to `TasksTool`.

  The legacy `notifyTaskEvent` callback keeps firing, so the existing
  watcher behavior is unchanged. Slice 3 will start migrating the
  watcher's individual responsibilities to plugins that consume these
  events; the watcher's notify hook eventually disappears.

  11 new tests cover each emission path plus the no-bus back-compat case.

  - @tailored-ai/browser-mediator@0.1.4

## 0.1.3

### Patch Changes

- 41bea5c: Add a typed runtime event bus — Slice 1 of the platform vision
  (`docs/platform-vision.md`). The bus is the seam the rest of the
  plugin model gets to use: task lifecycle, runtime reloads, and the
  default behaviors that will move out of the core in later slices all
  flow through one shared pub/sub surface.

  - New `TypedEventBus` (`packages/core/src/events.ts`) with a strongly
    typed `RuntimeEventMap`. Subscribing returns a disposer; emit is
    fire-and-forget from the emitter's point of view, sync throws and
    async rejections in handlers are logged and isolated so one bad
    subscriber can't break the rest.
  - `AgentRuntime` owns a single bus instance (`runtime.events`) and
    emits `runtime.reloaded` at the end of `reload()` before clearing
    the bus for the next generation.
  - `PluginContext.events` exposes the same bus to plugins so
    `ctx.events.on(...)` lands on the runtime's wiring.
  - The CLI pre-constructs the bus before `loadPlugins` and hands the
    same instance to both `createPluginContext` and the runtime.

  No emissions are wired beyond `runtime.reloaded` yet — Slice 2 lands
  the task lifecycle events (`task.created`, `task.updated`,
  `task.transitioned`, `task.commented`), and later slices migrate the
  in-core watchers + default behaviors onto the bus.

  17 unit tests cover delivery, dispose semantics, error isolation,
  iteration safety during dispatch, listener counts, and clear().

  - @tailored-ai/browser-mediator@0.1.3

## 0.1.2

### Patch Changes

- d2733dc: GitHub task backend routes TAI agent-role assignees (coder, reviewer,
  planner, etc.) through `agent:<role>` labels instead of GitHub's
  `assignees` API. GitHub rejects `assignees: ["coder"]` with 422 because
  "coder" isn't a real collaborator, which previously prevented the
  backend from creating any task assigned to an agent role.

  - New `tasks.github.agentRoles` config option to extend the built-in
    set of agent names (defaults cover the standard TAI agents).
  - Real GitHub usernames still go through the assignees API.
  - Reads round-trip cleanly: `toTask` prefers the `agent:*` label, falls
    back to the first GH assignee.
  - `query` and `nextBacklogTask` filter by label when the requested
    assignee is an agent role.

- a6d5d9b: Project overlays (`.tai.yaml`) now have `${ENV}` references interpolated
  before merging onto the global config. Previously a per-project overlay
  that referenced `${GITHUB_PERSONAL_TOKEN}` in `tasks.github.token`
  reached the GitHub task backend as the literal string
  `${GITHUB_PERSONAL_TOKEN}`, producing `Bad credentials` on every Octokit
  call. The base config has always been interpolated by `loadConfig`; the
  overlay path skipped this step entirely.

  Fix applies in `mergeProjectOverlay` itself so every overlay consumer
  (per-project task backends, the active-project runtime overlay, etc.)
  benefits without each caller having to remember to interpolate.

- 74bc27d: Task-watcher routes notifyById through the per-project backend resolver
  (PR #123). Previously the watcher's notifyById always looked up tasks
  via direct SQL against `project_tasks` — fine for native-backend tasks
  but invisible to GitHub-issue tasks (`gh-*` ids), which silently
  dropped out of the routing pipeline. The coder agent never ran on any
  task filed via the per-project GH backend.

  - `TasksToolNotify` callback signature gains an optional `projectId`
    argument. The tasks tool passes the calling args' `project_id` on
    every create/update/comment.
  - The CLI's `_taskWatcherRef.notifyById` accepts the new arg and
    forwards to the watcher.
  - `TaskWatcher.notifyById` uses `runtime.getTaskBackendForProject(projectId).get(id)`
    when `projectId` is supplied; the native SQL path is preserved as
    fallback for the no-projectId case.
  - Project id is injected back onto the resolved task so downstream
    worktree-path resolution finds the right repo.

  Three new tests cover the project-routed path, the native-fallback
  path, and the gracefully-empty case.

  - @tailored-ai/browser-mediator@0.1.2

## 0.1.1

### Patch Changes

- e0fd7d4: **Security:** Centralized SSRF / outbound-HTTP egress policy at `packages/core/src/security/egress-policy.ts`. Applied to `web_fetch` and the workflow `http_request` step. By default, loopback, RFC1918, IPv6 ULA (fc00::/7), link-local (169.254/16, fe80::/10), carrier-grade NAT (100.64/10), unspecified, and cloud metadata endpoints (169.254.169.254, fd00:ec2::254, fe80::a9fe:a9fe) are denied. DNS is resolved before fetch so a hostname that resolves to a private IP gets caught — including the multi-A-record case where one leg is public and another is private. Operators opt back into internal targets via `security.egress.allowHosts` / `allowPrivateNetworks` / `allowMetadataEndpoints` in `config.yaml`, or turn the policy off entirely with `disabled: true` (loud `validateConfig` warning fires when set). Closes #57.

  **Known limitation**: DNS-rebinding is not addressed (the policy resolves DNS, the fetch resolves separately). A follow-up will pin fetch to the resolved IP via a custom Undici dispatcher.

- 6e56681: **Refactor:** Centralize the session-key convention on `AgentRuntime` (#39). Channels used to hand-roll `${id}:${user}` and `${id}:${projectId}:${user}` strings — three lines in Discord, one in Slack, one in `task-watcher.ts`. Downstream consumers (autopilot, task-watcher) prefix-matched the raw strings, which silently broke when one channel drifted on field order.

  Two helpers now own the format:

  ```ts
  runtime.makeSessionKey({ channelId, userId, project?: ProjectRef | null }): string
  runtime.parseSessionKey(key): { channelId, userId, projectId?: string } | undefined
  ```

  Format guarantees documented in the JSDoc: `<channelId>:<userId>` or `<channelId>:<projectId>:<userId>`. `make` rejects inputs containing the `:` delimiter (would corrupt round-trip). `parse` returns `undefined` for unrecognized shapes so callers can ignore freeform CLI/web session ids without throwing.

  Migrated: Discord (3 call sites), Slack (1), `task-watcher.ts`'s Discord-owner fallback (1).

- 268041a: **Refactor:** Channel contract polish (#41). Three small smells from PR #35 resolved in one pass.

  - **`runtime.defaultLoopObservers({ prefix })`**: new helper that returns the standard `onToolCall` / `onApprovalRequest` / `onApprovalResponse` `console.log` callbacks. Discord (two call sites) and Slack used to hand-roll identical handlers — they now opt in via `{...runtime.defaultLoopObservers({ prefix })}` so a future format change happens in one place. Tool-call args truncate at 200 chars to keep logs scannable.
  - **`Channel.indicateWorking?(target): () => void`**: new optional capability. Channels with a "typing" or "thinking" affordance implement it; consumers wrap their work in `const stop = ch.indicateWorking?.(target); try { ... } finally { stop?.(); }`. The Discord channel implements it on top of `sendTyping`; the existing inline keep-alive timer in `handleMessageWithContent` is gone in favor of the new method.
  - **`Channel.onMessage` dropped**: the hook was never called from production code — the field was always undefined and the emit paths in Discord and Slack were dead. Removed from the `Channel` interface, the contract test, and both reference channels. Channel authors that want an external observer should hang one off their own transport.

  **Breaking change** for external channels: implementations no longer need (and must not provide) an `onMessage` method on the `Channel` interface. The compiler will catch this — adopting the new shape is a one-line delete.

- 4552f5e: Add `runChannelContractSuite` test helper at the `@tailored-ai/core/testing` subpath. Channel authors plug a small harness (build / emitIncoming / drainSent) into the helper and get the Channel contract assertions (id/type, connect/disconnect, send round-trip, onMessage observer, plugin registration) for free instead of re-deriving them from Discord's source. `vitest` is now an optional peer of `@tailored-ai/core` — only consumed by the `/testing` subpath. `channel-slack` adopts the suite as its smoke coverage.
- e7eeeec: Channel hot-reload now reconciles per-channel state via a new `ChannelLifecycleManager`. Previously, toggling `channels.discord.enabled` on reload called `startRegisteredChannels(runtime)` again — which re-invoked every registered factory, including ones whose channel was already running. A second Slack Bolt app would attach to Socket Mode while the first kept listening, so every incoming message fired the agent loop twice. The lifecycle manager keys by channel id, treats reload as a set-difference (start new, stop removed, restart on config change), and exposes `get(id)` / `list()` / `stopAll()`. Closes #58.
- 3137e3d: ExecTool now resolves its scratch directory (where truncated command output is persisted) from `$TAI_HOME` / a constructor override / `~/.tai` in that order — the hardcoded `~/.tai/exec-outputs` path used to silently ignore configured TAI homes. The truncation path is also wrapped in `try/catch` so a filesystem failure (permission denied, missing $HOME on a CI runner, sandbox without write access) returns visible truncated output with a "could not be persisted" warning instead of leaving the tool promise unsettled until the timeout fires. Closes #60.
- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
- d89b679: **Security:** Filesystem `allowedPaths` checks in `ReadTool` and `WriteTool` now use a proper path-containment helper instead of `startsWith`. Previously, allowing `/srv/project` also permitted `/srv/project-secrets` (sibling-prefix), and a symlink inside an allowed directory pointing at `/etc/passwd` would let the read/write tools escape the sandbox. The new `isPathContainedRealpath` helper normalizes paths, requires a true descendant boundary, and resolves symlinks (with nearest-existing-parent resolution for write targets that don't exist yet). Closes #59.
- c6ee302: **Fix:** `recall list` now returns notes in deterministic newest-first order, even when many notes share the same `created_at` second. SQLite's `datetime('now')` is second-precision, and the previous tiebreak — `id DESC` where the id is `note_${randomHex}` — was _not_ monotonic in insertion order. Two notes written in the same tick came back in arbitrary order. The query now tiebreaks on `rowid DESC` (SQLite's implicit monotonic insertion counter), giving sub-second deterministic ordering with no schema migration. Closes #63.
- f585b70: Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
- e434b43: **Security:** Server now binds to `127.0.0.1` by default instead of `0.0.0.0`. Previously, a default install exposed the (unauthenticated) HTTP API and dashboard to anyone on the local network. The validate-config warning that fired when `host: 0.0.0.0` was paired with no auth is still in place — it now fires only when users explicitly opt in to a non-loopback bind. To restore the prior behavior, set `server.host: 0.0.0.0` in `config.yaml` AND configure `server.authToken` or `server.proxyAuth`. The settings-editor TUI now emits loopback in newly-generated configs.
- c87fce0: Initial public release.

  - `@tailored-ai/core` — agent runtime, config, tools, providers, channels, db, cron, hooks.
  - `@tailored-ai/server` — Hono-based HTTP API with SSE streaming and webhooks.
  - `@tailored-ai/cli` — `tai` command, REPL + one-shot + project management + bundled web UI.
  - `@tailored-ai/browser-mediator` — framework-agnostic bounded browser tool with egress allow-list, vault `$ref` expansion, output sanitiser, always-HITL gates. Ships with OpenAI / Anthropic / TAI adapters.
  - `@tailored-ai/google-tools` — Gmail, Google Calendar, Google Drive tools that register via `@tailored-ai/core`'s tool-factory registry.
  - `@tailored-ai/trusted-actions` — HITL gateway for risky agent actions; approval over web-push to a phone PWA, executor runs in a hermetic Docker container.

- 26f7c92: Workflow async-trigger pollers (file_drop, email, calendar, rss, geofence, weather, sensor, finance, home_assistant) now reconcile against the live workflow registry instead of being wired once at CLI startup. New `WorkflowTriggerCoordinator` listens to registry change events and runs a per-workflow set diff: adds new triggers, removes triggers for deleted workflows, restarts triggers whose config changed, and leaves untouched any workflow whose triggers match the last signature (no duplicate timers). Each poller class gains an `unregister(workflowName)` method for the diff path. Closes #65.
- 2c651b4: **Fix:** Workflow steps now anchor to the active project root instead of the server's `process.cwd()`. The `WorkflowEngine` snapshots `runtime.getActiveProject()?.path` at the start of every run and threads it onto each step's `StepContext.projectPath`. The `shell`, `tool_call`, and `worktree` executors and the run-level sandbox `prepare` all prefer this over their constructor-default cwd, so a workflow launched from any directory (CLI, channel, cron, HTTP) runs against the intended project files. Explicit `step.cwd` / `worktree.repoDir` continue to win. The path is captured once per run, so `setActiveProject` mid-run doesn't reroute in-flight steps. Closes #64.
- 5b19bd7: Workflow loader now drives trigger validation from the trigger registry instead of a closed allowlist. Built-in pollers (`geofence`, `weather`, `sensor`, `finance`, `home_assistant`) were rejected by the loader despite being in `BUILTIN_TRIGGER_KINDS` and wired into the runtime — they now load cleanly. `validateWorkflow` and `loadWorkflowsFromDir` accept an optional `allowedTriggerKinds` for plugin-supplied trigger kinds. `WorkflowRegistry.setExtraTriggerKinds(supplier)` lets the runtime feed the active registry's kinds in. Closes #54.
- Updated dependencies [f585b70]
- Updated dependencies [c87fce0]
  - @tailored-ai/browser-mediator@0.1.1
