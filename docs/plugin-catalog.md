# Plugin catalog

The canonical answer to "what plugins exist, which are shipped, and which are open holes?" — by category, with status and issue cross-references. The dogfooding matrix (#71) tracks implementation priority; the wizard registry (#5) will eventually display installable plugins to new users. Both feed from this doc.

**Maintenance**: manually maintained (automation from issue labels + package metadata can come later). Update it whenever a plugin ships or a new contract/reference-impl issue is opened. An entry earns a row when it has been discussed in an issue or PR, or is an obvious missing member of a category that already has shipped entries; anything else is out of scope and not listed. Embedding providers and sandbox backends get their own (small) categories rather than being folded into memory/tools.

**Status key**:

- **core** — built into `@tailored-ai/core` (registered through the same registries as everything else; see [no privileged built-ins](./platform-vision.md))
- **plugin** — shipped first-party package in this repo, installable via `tai plugin install`
- **#N** — open issue, not yet built
- **hole** — community-shaped gap: real demand, no issue yet beyond this catalog

## Channels

| Channel | Status | Notes |
|---|---|---|
| Discord | core | `channels/discord-builtin.ts`, registered via the channel registry |
| Slack | plugin | `@tailored-ai/channel-slack` |
| Telegram | [#107](https://github.com/quintonmiller/tailored-ai/issues/107) | **Highest-priority channel.** Bot-token setup, no app review; the recommended first channel in every comparable ecosystem |
| Email (IMAP/SMTP) | [#101](https://github.com/quintonmiller/tailored-ai/issues/101) | Doubles as a tool (triage workflows); vendor-neutral |
| WhatsApp | [#107](https://github.com/quintonmiller/tailored-ai/issues/107) | Huge demand, but no official personal-account API — bridge libraries are fragile and carry ban risk; needs honest scope caveats |
| Signal | [#107](https://github.com/quintonmiller/tailored-ai/issues/107) | signal-cli bridge; privacy-aligned audience |
| Matrix | hole | |
| MS Teams | hole | |
| iMessage | hole | Only feasible via a macOS bridge (BlueBubbles-style Messages.app automation); fragile, no official API |
| SMS / telephony | hole | Twilio/Telnyx-style; pairs with voice (#110) |
| Generic webhook | partial | Inbound webhook triggers exist in the server; a two-way webhook *channel* does not |

## Providers

| Provider | Status | Notes |
|---|---|---|
| OpenAI-compatible | core | The only built-in (`openai_compatible`) — local gateways, Ollama, vLLM |
| OpenAI | plugin | `@tailored-ai/provider-openai` |
| Anthropic | plugin | `@tailored-ai/provider-anthropic` |
| OpenRouter | plugin | `@tailored-ai/provider-openrouter` |
| AWS Bedrock | plugin | `@tailored-ai/provider-bedrock` |
| Gemini | [#27](https://github.com/quintonmiller/tailored-ai/issues/27) / [#235](https://github.com/quintonmiller/tailored-ai/issues/235) | Cheap win — mostly mechanical given the provider-plugin pattern |
| Mistral, Groq, Azure, xAI, … | [#235](https://github.com/quintonmiller/tailored-ai/issues/235) | OpenAI-compatible ones are thin wrappers per the openrouter pattern |
| Router / cascading | [#173](https://github.com/quintonmiller/tailored-ai/issues/173) | Model cascading and privacy tiers across providers |

## Tools

| Tool | Status | Notes |
|---|---|---|
| Google suite (Gmail/Calendar/Drive) | plugin | `@tailored-ai/google-tools` — a genuine strength; the equivalent bundle is a top-5 download in OpenClaw's ecosystem |
| Browser mediator | plugin | `@tailored-ai/browser-mediator` |
| Web search / fetch | core | Built-in tools; pluggable search providers tracked in [#221](https://github.com/quintonmiller/tailored-ai/issues/221) |
| MCP client | [#99](https://github.com/quintonmiller/tailored-ai/issues/99) | **Highest-leverage tool item** — one integration inherits thousands of existing MCP servers. Direction: native core support (MCP is a protocol, like `openai_compatible`), not a plugin |
| GitHub (issues/PRs/notifications) | [#244](https://github.com/quintonmiller/tailored-ai/issues/244) | Top-3 skill by downloads in comparable ecosystems; distinct from the repo backend and github task backend seams |
| Home Assistant bridge | [#245](https://github.com/quintonmiller/tailored-ai/issues/245) | One plugin covers the whole smart-home category; most-starred smart-home skill in OpenClaw's ecosystem |
| Notion | [#31](https://github.com/quintonmiller/tailored-ai/issues/31) | Partially obsoleted by MCP (#99) — Notion ships an official MCP server |
| CalDAV calendar | [#102](https://github.com/quintonmiller/tailored-ai/issues/102) | Non-Google PIM for self-hosters (Nextcloud, Fastmail, Apple); pairs with #101 |
| Spotify | hole | Popular community skill in both OpenClaw and Hermes; never built-in anywhere; also reachable via MCP |
| Notes/PKM (Obsidian-style) | hole | Sizable skill category elsewhere; overlaps memory + #116 |

## Task backends

| Backend | Status | Notes |
|---|---|---|
| Native (SQLite) | core | |
| GitHub issues | core | `tasks.backend: github` |
| beans / beads | core | |
| Linear | [#25](https://github.com/quintonmiller/tailored-ai/issues/25) | |

## Memory backends

| Backend | Status | Notes |
|---|---|---|
| SQLite | core | |
| Postgres / pgvector | [#24](https://github.com/quintonmiller/tailored-ai/issues/24) | |

## Embedding providers

| Provider | Status | Notes |
|---|---|---|
| OpenAI-compatible | core | `/v1/embeddings` endpoint (Ollama, vLLM, OpenAI) |
| Voyage AI | [#28](https://github.com/quintonmiller/tailored-ai/issues/28) | |

## Sandbox backends

| Backend | Status | Notes |
|---|---|---|
| Host / Docker / Podman | core | See [sandboxes-and-worktrees](./sandboxes-and-worktrees.md) |

## Surfaces

| Surface | Status | Notes |
|---|---|---|
| Web UI | core | `@tailored-ai/ui`, replaceable via the UI provider registry |
| PWA | core | Shipped (#121) |
| Desktop / mobile apps | [#188](https://github.com/quintonmiller/tailored-ai/issues/188) / [#106](https://github.com/quintonmiller/tailored-ai/issues/106) | |

## Other

| Item | Status | Notes |
|---|---|---|
| Voice in/out | [#110](https://github.com/quintonmiller/tailored-ai/issues/110) | |
| Observability sinks | [#75](https://github.com/quintonmiller/tailored-ai/issues/75) | |
| TAI as an MCP server | [#178](https://github.com/quintonmiller/tailored-ai/issues/178) | The inverse of #99 |
| OpenAI-compatible API facade | [#103](https://github.com/quintonmiller/tailored-ai/issues/103) | |
| Agent packs | [#171](https://github.com/quintonmiller/tailored-ai/issues/171) | |

## Community priority

Ranked by what it enables × how many people would use it, from a June 2026 survey of comparable ecosystems (OpenClaw ~145K stars, Hermes ~130K, Odysseus, n8n's AI-agent nodes, Home Assistant analytics, LibreChat/Open WebUI/Letta):

1. **Telegram channel** (#107) — the universal first channel; bot-token setup; highest reach-per-effort
2. **MCP client** (#99) — every comparable project converged on MCP as *the* integration mechanism; one item multiplies the entire tool surface
3. **Email IMAP/SMTP** (#101) — universal, vendor-neutral; the winning shape is triage *behavior* (urgency, summaries, draft replies), not a raw send/read tool
4. **GitHub tool** (#244) — TAI's audience is developers
5. **Home Assistant bridge** (#245) — one plugin, whole category, perfect audience fit
6. **WhatsApp channel** (#107) — massive demand, ranked below HA only for bridge fragility
7. **CalDAV** (#102) — completes the non-Google PIM story with #101
8. **Gemini provider** (#27) — mechanical given the provider-plugin pattern
9. Notion (#31), Spotify, Signal — popular but narrower, and the first two are largely covered once MCP lands

Two ecosystem lessons worth encoding as principles:

- **Curated beats huge.** OpenClaw's unmoderated skill marketplace measured ~7.6% malicious entries; its #1 download is a skill that vets other skills. When the wizard registry (#5) ships, "small, signed, first-party-reviewed" is a feature.
- **Self-improving skills are the next demand wave.** Hermes's core identity is the agent writing its own reusable skills; OpenClaw's top-starred skill is a capability evolver. Tracked in #111.
