# @tailored-ai/cli

## 0.1.10

### Patch Changes

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

- e7e3768: Fail loudly, and early, when the HTTP port is already taken.

  `serve()` registered no `error` listener, so `EADDRINUSE` surfaced as an unhandled event: the process died on a raw stack trace that never named the port or the likely cause. And the Discord gateway login, cron, autopilot and the room watcher all start _before_ the HTTP bind, so a second instance started by mistake logged a second bot into the guild and fired cron for several seconds before the collision killed it.

  - New `checkPortAvailable()` runs before anything with side effects, so a doomed start exits with a message instead of briefly standing up a duplicate bot.
  - `start()` now handles the bind error itself, as a backstop for the case where something takes the port between the check and the real bind.
  - `portInUseMessage()` names the port, says another instance is the likely holder, and points at `tai-ctl.sh status` / `switch`.

  Two TAI instances share one port deliberately — it is the lock that keeps only one running — so a collision is an expected event that has to read as one.

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

- de1ce69: MCP observability (#249). Connected MCP servers were silent — "no log lines" was indistinguishable from "never ran", and the #248 drop-on-reload bug surfaced nothing. Now `McpManager` logs the happy path: one line per server on connect (`[mcp:github] connected (3 tools: ...)`), on tool-list change, and on teardown/restart. The CLI startup banner gains an `MCP: github (3), ...` line (only when servers are configured), and `McpManager.list()` now reports `connectedAt`. New `GET /api/mcp` route (wired via the server's `mcpStatus` option) exposes per-server id, tool names, tool count, and ISO connected-at for the UI / `tai doctor`.
- 963efe3: MCP tools survive startup reloads: the reconcile-on-reload hook is now registered the moment the manager is constructed, before any runtime.reload() can swap the tool registry. Previously, activating a project overlay during startup (setActiveProject → reload) silently dropped freshly-registered MCP tools because the hook was only installed later in server mode.
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

- b024d69: `scripts/tai-ctl.sh` gains an instance dimension, so one machine can hold a work and a personal deployment.

  Instances are declared in `~/.tai/instances.conf` as `name=/path/to/home`; the file is created on first run holding the single instance that already exists. `-i <instance>` is now required by every command that touches `agent` or `ui`.

  - pid and log files for `agent`/`ui` are namespaced per instance. `vllm` stays shared — one model server serves every instance — and is no longer in the default target set, so restarting an agent no longer reloads a 27B model.
  - The agent is spawned with a scrubbed environment (`env -i`) carrying an explicit `TAI_HOME`. The scrub is the point: `dotenv` does not overwrite a variable already in the environment, so a `DISCORD_TOKEN` exported in the invoking shell would outrank the instance's own `.env` and log the wrong bot in with no error anywhere.
  - Only one instance may hold the `agent` slot, enforced by scanning every instance's pid file for a live process. Pid liveness is the only truth, so a crash releases the slot with nothing stale to clean up.
  - New `switch -i <instance>` and `instances` subcommands.
  - The previous flat `~/.tai/{run,logs}/agent.*` layout is adopted into the first declared instance on first run, so an agent started under the old script stays visible to `stop` rather than becoming an unkillable process holding port 3000.

  Note the log path change: `~/.tai/logs/agent.log` is now `~/.tai/logs/<instance>/agent.log`.

- d7656d8: Honour `TAI_HOME` everywhere, so `-c <config>` selects a whole instance rather than just a config file.

  `resolveHomeDir` read `TAI_HOME`, but nothing in the repo ever assigned it. Core is a library and never sees the CLI's flags, so every module that isolates per-instance state by reading the variable — the vault master key, the workflow secrets key, `exec-outputs`, `tool-outputs`, and the sandbox scratch allowlist — took its fallback branch on every run. Four more paths ignored the variable outright and resolved against `homedir()`: the resource trust store, the resource cache, and the registry index.

  The result was a home directory holding the config and database while its keys and cached output went somewhere else. The visible symptom on a real install is hundreds of session directories under `~/.tai/exec-outputs`, a path no config mentions.

  - New `taiHome()` / `taiHomePath()` in core is the single answer to "where does this instance keep its state", read from the environment on every call. Anything that caches it at module load captures the value from before the CLI publishes it.
  - The CLI now calls `adoptHomeDir()` at each entry point, which resolves the home and publishes it as `TAI_HOME`.
  - Scratch output moves from `~/.tai/{exec,tool}-outputs` to `<home>/{exec,tool}-outputs`. The old location stays on the sandbox read allowlist: truncated results hand the model an absolute path, and those pointers live in session history indefinitely.
  - `TrustStore` and `ResourceLoader` expose `storePath` / `cachePath`.

- 1ad506a: Preserve the host timezone through the clean launcher environment, add explicit
  `time.timezone` configuration, and expose a plugin-registerable time provider
  for runtime clocks and timezone-aware schedules.
- Updated dependencies [b559646]
- Updated dependencies [ef9e809]
- Updated dependencies [a2f8016]
- Updated dependencies [ed98f4a]
- Updated dependencies [b559646]
- Updated dependencies [920a799]
- Updated dependencies [fecc3d8]
- Updated dependencies [2632f51]
- Updated dependencies [9af06b7]
- Updated dependencies [b8f5d16]
- Updated dependencies [aee6802]
- Updated dependencies [9d32c15]
- Updated dependencies [8b0c45a]
- Updated dependencies [f67b15a]
- Updated dependencies [7447619]
- Updated dependencies [fd84749]
- Updated dependencies [b559646]
- Updated dependencies [d9e294f]
- Updated dependencies [b1ec29a]
- Updated dependencies [fd19549]
- Updated dependencies [a38b5fc]
- Updated dependencies [1206560]
- Updated dependencies [0a3b591]
- Updated dependencies [dc312f1]
- Updated dependencies [5a01ceb]
- Updated dependencies [b1cdad9]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [54ce46f]
- Updated dependencies [7017c2d]
- Updated dependencies [7d273b5]
- Updated dependencies [b559646]
- Updated dependencies [e6cb5fb]
- Updated dependencies [e66f07b]
- Updated dependencies [0187e0c]
- Updated dependencies [b559646]
- Updated dependencies [daa6302]
- Updated dependencies [e7e3768]
- Updated dependencies [a970a8b]
- Updated dependencies [57a5d48]
- Updated dependencies [39445bb]
- Updated dependencies [4c48ad8]
- Updated dependencies [ba7bad5]
- Updated dependencies [571adba]
- Updated dependencies [de1ce69]
- Updated dependencies [87fc6fd]
- Updated dependencies [611f94d]
- Updated dependencies [8aa5720]
- Updated dependencies [d2b5939]
- Updated dependencies [7e9a130]
- Updated dependencies [b559646]
- Updated dependencies [d3a4cf1]
- Updated dependencies [36a50b7]
- Updated dependencies [4656518]
- Updated dependencies [d3e79e3]
- Updated dependencies [128c561]
- Updated dependencies [30a0c14]
- Updated dependencies [df2d055]
- Updated dependencies [9ccec1f]
- Updated dependencies [e698f39]
- Updated dependencies [b8fe10c]
- Updated dependencies [0d4f4b6]
- Updated dependencies [6460c00]
- Updated dependencies [0039c3a]
- Updated dependencies [8d0f50e]
- Updated dependencies [9b13c86]
- Updated dependencies [c120f51]
- Updated dependencies [7c6217a]
- Updated dependencies [449e827]
- Updated dependencies [58dd367]
- Updated dependencies [bbcde3b]
- Updated dependencies [2c0fde1]
- Updated dependencies [0b7a0f7]
- Updated dependencies [19188db]
- Updated dependencies [20f9fe1]
- Updated dependencies [7f620a0]
- Updated dependencies [b559646]
- Updated dependencies [9883913]
- Updated dependencies [77781ef]
- Updated dependencies [b7788ad]
- Updated dependencies [7e05a94]
- Updated dependencies [e3b1bc5]
- Updated dependencies [920a799]
- Updated dependencies [920a799]
- Updated dependencies [b559646]
- Updated dependencies [682e304]
- Updated dependencies [d492806]
- Updated dependencies [dd3951c]
- Updated dependencies [544aac2]
- Updated dependencies [87d2af3]
- Updated dependencies [c308241]
- Updated dependencies [cc792f2]
- Updated dependencies [7d273b5]
- Updated dependencies [42a1e90]
- Updated dependencies [2963457]
- Updated dependencies [9ec3100]
- Updated dependencies [248931d]
- Updated dependencies [4b54275]
- Updated dependencies [22f9b9e]
- Updated dependencies [d7656d8]
- Updated dependencies [afc05a2]
- Updated dependencies [dd3951c]
- Updated dependencies [1ad506a]
- Updated dependencies [a1231c6]
- Updated dependencies [1d9e6a6]
- Updated dependencies [f0bb132]
- Updated dependencies [19996ac]
- Updated dependencies [28bb474]
- Updated dependencies [244cdcf]
- Updated dependencies [a00b73a]
- Updated dependencies [b559646]
- Updated dependencies [c50e55a]
- Updated dependencies [bcc2159]
- Updated dependencies [42d98c6]
- Updated dependencies [b8a8da4]
- Updated dependencies [cf2cd34]
  - @tailored-ai/core@0.1.10
  - @tailored-ai/server@0.1.10

## 0.1.9

### Patch Changes

- 4f992c9: Native MCP client support: declare Model Context Protocol servers under `mcp.servers` in config.yaml (stdio via `command` or streamable HTTP via `url`) and their tools are discovered and registered into the tool registry as `mcp_<server>_<tool>`, selectable per agent like any other tool. Servers reconcile on hot reload (start/stop/restart on config change), failed connections retry on the next reconcile, and `tools/list_changed` notifications re-discover live. The `@modelcontextprotocol/sdk` dependency is optional and loaded on first use.
- cc238a6: `tai plugin install` now replaces an existing dependency installed under a different spec (e.g. swapping a `file:` link for a registry version) instead of failing with ERESOLVE. The stale manifest entry is dropped before npm runs and restored if the install fails.
- Updated dependencies [4f992c9]
  - @tailored-ai/core@0.1.9
  - @tailored-ai/server@0.1.9

## 0.1.8

### Patch Changes

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

- 3b8798e: `tai edit` provider screen: the Kind list is now discovered live (registry built-ins + providers registered by the config's plugins, probed via a capture context) instead of hardcoded, and the Model field offers a picker populated from the provider's `listModels` capability when available — free-text entry remains the fallback.
- 98160f3: DEFAULT_CONFIG no longer ships a specific local model name (`devstral-small-2:latest`). `providers.openai_compatible.defaultModel` defaults to empty; `validateConfig` warns until a model is set, and `tai init` discovers installed models as before. The deprecated `providers.ollama` migration also stops injecting the model name.
- 6c24fe9: `tai plugin install` / `remove` now keep config.yaml's `plugins:` list in sync (comment-preserving YAML edit; real package names resolved even for git/file/tarball specs). Pass `--no-save` to manage the list yourself.
- f240f5e: Plugin self-description and config validation: optional `meta` and `validateConfig` named exports on plugin modules, captured by the loader onto `LoadedPlugin`, surfaced via the new `GET /api/plugins` route and startup warnings. `tai plugin list` shows package descriptions. The builtin plugins, channel-slack, and google-tools ship reference `meta`/`validateConfig` implementations.
- c759128: Retire the built-in `openai` and `anthropic` provider registrations (#236) — they live in `@tailored-ai/provider-openai` and `@tailored-ai/provider-anthropic` now. Core keeps `openai_compatible`; unknown provider ids fail with a plugin install hint; the server model-list endpoint and editor provider rendering are now generic over registered providers.
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

- 7506c28: Setup wizard now emits the `agents:` config key instead of the deprecated `profiles:` key.
- Updated dependencies [c67120e]
- Updated dependencies [ecb0d69]
- Updated dependencies [a6e26a4]
- Updated dependencies [e0b9bbe]
- Updated dependencies [c83c58c]
- Updated dependencies [e4e239f]
- Updated dependencies [d398c93]
- Updated dependencies [c71e7de]
- Updated dependencies [08ac997]
- Updated dependencies [ef7fe84]
- Updated dependencies [ff81e89]
- Updated dependencies [290f96d]
- Updated dependencies [04181f5]
- Updated dependencies [330a6c5]
- Updated dependencies [d927a26]
- Updated dependencies [02c0a5a]
- Updated dependencies [98160f3]
- Updated dependencies [14fdab3]
- Updated dependencies [ba79819]
- Updated dependencies [04181f5]
- Updated dependencies [f240f5e]
- Updated dependencies [10bfad3]
- Updated dependencies [c759128]
- Updated dependencies [a655023]
- Updated dependencies [877795c]
- Updated dependencies [773e16c]
- Updated dependencies [4bf85d1]
- Updated dependencies [1747dbe]
- Updated dependencies [ef1e01c]
- Updated dependencies [cdc0034]
  - @tailored-ai/core@0.1.8
  - @tailored-ai/server@0.1.8

## 1.0.1

### Patch Changes

- Updated dependencies [e568706]
  - @tailored-ai/core@1.0.1
  - @tailored-ai/server@1.0.1

## 1.0.0

### Patch Changes

- Updated dependencies [274de6f]
  - @tailored-ai/core@1.0.0
  - @tailored-ai/server@1.0.0

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

- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
  - @tailored-ai/core@0.1.6
  - @tailored-ai/server@0.1.6

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

- Updated dependencies [b443c8e]
  - @tailored-ai/core@0.1.5
  - @tailored-ai/server@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [b163368]
  - @tailored-ai/core@0.1.4
  - @tailored-ai/server@0.1.4

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

- Updated dependencies [41bea5c]
  - @tailored-ai/core@0.1.3
  - @tailored-ai/server@0.1.3

## 0.1.2

### Patch Changes

- 185e468: Plugin loader falls back to manual exports-map resolution for pure-ESM
  plugins. Previously a plugin whose published `exports` map only declared
  the `import` condition (no `default`, no `require`, no top-level `main`)
  failed to load because `createRequire().resolve()` couldn't see the
  `import` condition. Affected `@tailored-ai/google-tools@0.1.1` —
  restarting the agent after a fresh `tai plugin install` produced
  "plugin … is not installed" even though it was.

  Two changes ship together:

  - `@tailored-ai/cli`: the plugin loader now tries `createRequire().resolve`
    first, then walks the plugin's own `package.json` exports map by hand
    (`exports["."].import` / `default` / `require`, then `module` / `main`)
    and dynamic-imports the resolved file path. Pure-ESM plugins load
    without the author having to publish a CJS-visible entry condition.
  - `@tailored-ai/google-tools`: the `exports` map now also exposes a
    `default` condition so older versions of the loader still resolve this
    package correctly via the CJS path.

  A regression test covers the pure-ESM-only layout end-to-end in the
  plugin manager's importer.

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

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2
  - @tailored-ai/server@0.1.2

## 0.1.1

### Patch Changes

- e7eeeec: Channel hot-reload now reconciles per-channel state via a new `ChannelLifecycleManager`. Previously, toggling `channels.discord.enabled` on reload called `startRegisteredChannels(runtime)` again — which re-invoked every registered factory, including ones whose channel was already running. A second Slack Bolt app would attach to Socket Mode while the first kept listening, so every incoming message fired the agent loop twice. The lifecycle manager keys by channel id, treats reload as a set-difference (start new, stop removed, restart on config change), and exposes `get(id)` / `list()` / `stopAll()`. Closes #58.
- dddf565: Migrate `@tailored-ai/google-tools` to the `register(ctx)` plugin contract (closes #55). The package previously registered Gmail / GoogleCalendar / GoogleDrive via module-load side effects, which broke when installed via `tai plugin install` outside the host's resolution tree (same class of bug as channel-slack pre-#47). Default export is now a `Plugin` function the host invokes with a `PluginContext`. CLI drops its `@tailored-ai/google-tools` workspace dep — Google tools are now fully optional, opt-in via `plugins: ["@tailored-ai/google-tools"]` in config.yaml.
- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
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
- Updated dependencies [e0fd7d4]
- Updated dependencies [6e56681]
- Updated dependencies [268041a]
- Updated dependencies [4552f5e]
- Updated dependencies [e7eeeec]
- Updated dependencies [3137e3d]
- Updated dependencies [3b5c2c4]
- Updated dependencies [d89b679]
- Updated dependencies [c6ee302]
- Updated dependencies [f585b70]
- Updated dependencies [e434b43]
- Updated dependencies [c87fce0]
- Updated dependencies [26f7c92]
- Updated dependencies [2c651b4]
- Updated dependencies [5b19bd7]
  - @tailored-ai/core@0.1.1
  - @tailored-ai/server@0.1.1
