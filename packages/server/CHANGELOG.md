# @tailored-ai/server

## 0.1.11

### Patch Changes

- Updated dependencies [9018bc8]
- Updated dependencies [9dc9836]
- Updated dependencies [e21c40e]
- Updated dependencies [0651034]
- Updated dependencies [5c6f252]
- Updated dependencies [0b62d07]
- Updated dependencies [38b808b]
- Updated dependencies [662b23a]
- Updated dependencies [f13cec6]
- Updated dependencies [0c8e8c4]
- Updated dependencies [390be8e]
- Updated dependencies [bf2faf1]
- Updated dependencies [b17aa82]
- Updated dependencies [bf2faf1]
- Updated dependencies [2c98cab]
- Updated dependencies [b8e39ef]
- Updated dependencies [49e6ce4]
- Updated dependencies [02f9be2]
- Updated dependencies [662b23a]
- Updated dependencies [38b808b]
- Updated dependencies [2c98cab]
- Updated dependencies [afdfc82]
- Updated dependencies [0594a2b]
- Updated dependencies [325e5f2]
- Updated dependencies [38b808b]
- Updated dependencies [bf2faf1]
- Updated dependencies [3d27ba5]
- Updated dependencies [1d83122]
- Updated dependencies [415ba15]
- Updated dependencies [0594a2b]
- Updated dependencies [a098702]
- Updated dependencies [d4c4baa]
- Updated dependencies [1537522]
- Updated dependencies [0b90020]
- Updated dependencies [6557b85]
- Updated dependencies [bdacf8d]
- Updated dependencies [2e7a342]
- Updated dependencies [9190838]
- Updated dependencies [2c98cab]
- Updated dependencies [1d83122]
- Updated dependencies [1537522]
- Updated dependencies [e21c40e]
  - @tailored-ai/core@0.1.11

## 0.1.10

### Patch Changes

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

- e7e3768: Fail loudly, and early, when the HTTP port is already taken.

  `serve()` registered no `error` listener, so `EADDRINUSE` surfaced as an unhandled event: the process died on a raw stack trace that never named the port or the likely cause. And the Discord gateway login, cron, autopilot and the room watcher all start _before_ the HTTP bind, so a second instance started by mistake logged a second bot into the guild and fired cron for several seconds before the collision killed it.

  - New `checkPortAvailable()` runs before anything with side effects, so a doomed start exits with a message instead of briefly standing up a duplicate bot.
  - `start()` now handles the bind error itself, as a backstop for the case where something takes the port between the check and the real bind.
  - `portInUseMessage()` names the port, says another instance is the likely holder, and points at `tai-ctl.sh status` / `switch`.

  Two TAI instances share one port deliberately — it is the lock that keeps only one running — so a collision is an expected event that has to read as one.

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

- de1ce69: MCP observability (#249). Connected MCP servers were silent — "no log lines" was indistinguishable from "never ran", and the #248 drop-on-reload bug surfaced nothing. Now `McpManager` logs the happy path: one line per server on connect (`[mcp:github] connected (3 tools: ...)`), on tool-list change, and on teardown/restart. The CLI startup banner gains an `MCP: github (3), ...` line (only when servers are configured), and `McpManager.list()` now reports `connectedAt`. New `GET /api/mcp` route (wired via the server's `mcpStatus` option) exposes per-server id, tool names, tool count, and ISO connected-at for the UI / `tai doctor`.
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

## 0.1.9

### Patch Changes

- Updated dependencies [4f992c9]
  - @tailored-ai/core@0.1.9

## 0.1.8

### Patch Changes

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

- f240f5e: Plugin self-description and config validation: optional `meta` and `validateConfig` named exports on plugin modules, captured by the loader onto `LoadedPlugin`, surfaced via the new `GET /api/plugins` route and startup warnings. `tai plugin list` shows package descriptions. The builtin plugins, channel-slack, and google-tools ship reference `meta`/`validateConfig` implementations.
- c759128: Retire the built-in `openai` and `anthropic` provider registrations (#236) — they live in `@tailored-ai/provider-openai` and `@tailored-ai/provider-anthropic` now. Core keeps `openai_compatible`; unknown provider ids fail with a plugin install hint; the server model-list endpoint and editor provider rendering are now generic over registered providers.
- 4bf85d1: Make the UI + server delivery editors and config sections channel-neutral, the
  matching half of the core channel-neutral refactor (pairs with #192).

  UI: the workflow step `discord_message` becomes `channel_message` with an
  optional outbound `channel` id (blank = default channel); the `notify` and form
  `notify` channel pickers open to an arbitrary channel id alongside the
  `email`/`log` specials; the Cron and Task-watcher delivery editors swap the
  hardcoded `log`/`discord`/`discord-dm` preset list for a `log`/`channel`/`dm`
  mode select plus an open "Delivery Channel" id field and the existing target
  field, mapping to/from the `{ channel, mode, target }` shape. Labels and
  placeholders are neutralized (no more "Discord channel/user ID"), and the
  workflow templates / metadata / graph drop their hardcoded Discord references.

  Server: the config-section route resolves `channels.<id>` keys generically
  (e.g. `channels.discord` → `channels.discord` in YAML) instead of a hardcoded
  `discord` entry in `SECTION_MAP`, so each channel's setup page reads/writes its
  own section without a built-in list. The Discord setup page now targets
  `channels.discord`. The Discord setup/config page stays as the Discord
  channel's own config surface.

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
- Updated dependencies [1747dbe]
- Updated dependencies [ef1e01c]
- Updated dependencies [cdc0034]
  - @tailored-ai/core@0.1.8

## 1.0.1

### Patch Changes

- Updated dependencies [e568706]
  - @tailored-ai/core@1.0.1

## 1.0.0

### Patch Changes

- Updated dependencies [274de6f]
  - @tailored-ai/core@1.0.0

## 0.1.6

### Patch Changes

- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
  - @tailored-ai/core@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [b443c8e]
  - @tailored-ai/core@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [b163368]
  - @tailored-ai/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [41bea5c]
  - @tailored-ai/core@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2

## 0.1.1

### Patch Changes

- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
- f585b70: Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
- c87fce0: Initial public release.

  - `@tailored-ai/core` — agent runtime, config, tools, providers, channels, db, cron, hooks.
  - `@tailored-ai/server` — Hono-based HTTP API with SSE streaming and webhooks.
  - `@tailored-ai/cli` — `tai` command, REPL + one-shot + project management + bundled web UI.
  - `@tailored-ai/browser-mediator` — framework-agnostic bounded browser tool with egress allow-list, vault `$ref` expansion, output sanitiser, always-HITL gates. Ships with OpenAI / Anthropic / TAI adapters.
  - `@tailored-ai/google-tools` — Gmail, Google Calendar, Google Drive tools that register via `@tailored-ai/core`'s tool-factory registry.
  - `@tailored-ai/trusted-actions` — HITL gateway for risky agent actions; approval over web-push to a phone PWA, executor runs in a hermetic Docker container.

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
