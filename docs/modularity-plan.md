# Modularity plan

TAI's positioning is **spec + runtime + first-party packages**. A user
should be able to swap any major component (agent, memory, tool,
channel, provider, task backend, trigger, step executor) without
forking. Today some components live up to that and others don't.

This doc inventories the gaps, ranks them, and sketches the change
needed to close each one. It is contributor-facing. User-facing docs
get updated downstream once a gap closes.

## Scoring

Each gap has three labels:

- **Interface** — does a `T` interface exist in `@tailored-ai/core`?
- **Registry** — can a third party register a new `T` at runtime?
- **Config** — can a user pick a `T` from `config.yaml` by name?

A green row in all three columns is fully pluggable. Anything red is a
gap.

| Component | Interface | Registry | Config | Notes |
|---|---|---|---|---|
| Tools | ✅ | ✅ | ✅ | `Tool` interface, registry, `tools:` config block. |
| Triggers | ✅ | ⚠️ | ✅ | `TriggerKindRegistry` catalogs kinds; nothing lets a plugin supply the *runner*. See below. |
| Task backends | ✅ | ✅ | ✅ | `registerTaskBackendFactory`, shipped. |
| Step executors | ✅ | ✅ | ✅ | `StepExecutorRegistry`; docs updated. |
| Providers | ✅ | ✅ | ✅ | `registerProviderFactory`, shipped. |
| Embedding providers | ✅ | ✅ | ✅ | `registerEmbeddingFactory`, `memory.embeddings.type`, shipped. |
| Channels | ✅ | ✅ | ✅ | `registerChannelFactory` + `startRegisteredChannels`, shipped. Discord still directly wired due to cron/autopilot coupling. |
| System prompt | ✅ | n/a | ✅ | `systemPrompt:` override with base / order / custom layers, shipped. |
| Memory backends | ❌ | ❌ | ❌ | Three tiers baked into SQL schema and tool implementations. v0.3 candidate. |

**Status as of 2026-05-30: waves 1-6 shipped. Memory backends (wave 7) deferred.**

**Correction, 2026-08-30.** The Triggers row read all-green until now. It was
scoring the wrong thing. `TriggerKindRegistry` is a catalog — its own docblock
says "the actual scheduling/polling implementation still lives in the runtime
subsystem that handles the kind" — and `plugin-context.ts` exposes no trigger
surface at all, so a plugin can register a *kind* and never a *runner*.

The result was worse than a plain gap: `loader.ts` accepts any catalogued kind
via `setExtraTriggerKinds`, so a plugin's workflow validated, appeared in the
UI picker, was filtered out at `trigger-coordinator.ts`, and never fired, with
nothing said. #609 makes that drop warn; #61 is the contract that closes it.

The lesson generalises past triggers, and is why this row is now ⚠️ rather than
red: **a registry that is only consulted for validation will score green on
these three columns while nothing runs.** "Can a third party register one?" is
not the same question as "does registering one do anything?" — and only the
second one is worth a ✅.

---

## 1. System prompt composition

**Today.** `packages/core/src/agent/loop.ts:501` concatenates seven
strings in fixed order: `BASE_SYSTEM_PROMPT + extraInstructions +
contextContent + catalogBlock + coreMemoryBlock + chatLiveBlock +
memoryBlock`. The base is a constant in `prompt.ts`.

`instructions:` in an agent definition only fills the `extraInstructions`
slot. There is no way to:

- Replace the base prompt (which teaches identity discovery and memory
  semantics — useful default, not always wanted).
- Reorder the layers.
- Strip a layer (e.g. an agent that doesn't want the recall block).
- Inject a custom layer (e.g. "current sprint goals" between context
  and catalog).

**Spec.** A `SystemPromptComposer` interface:

```ts
export interface SystemPromptLayer {
  name: string;
  render(ctx: PromptContext): string | Promise<string>;
}

export interface SystemPromptComposer {
  layers(ctx: PromptContext): SystemPromptLayer[];
}
```

The default composer returns today's seven layers in today's order. An
agent can supply its own composer (or list of layer names + an `order:`
override) via config:

```yaml
agents:
  coder:
    systemPrompt:
      base: ./prompts/coder-base.md    # replace BASE_SYSTEM_PROMPT
      layers:                           # reorder / strip / add
        - core_memory
        - context
        - catalog
        - custom: ./prompts/sprint-goals.md
```

**Lift.** Small refactor. ~1 day. Extract the concatenation into a
default composer, expose the interface, add config schema, write tests
that exercise reorder + strip + custom. No DB changes.

**Doc impact.** Agents page needs a "Customizing the system prompt"
section. Architecture page needs a one-line callout that the prompt
is layered + replaceable.

---

## 2. Memory backends

**Today.** Three tiers live as SQL tables in `agent.db`: `notes`
(recall), `chunks` (promoted recall), `core_memory` (identity store).
`facts` is a fourth, schema-locked store. The promotion logic in
`packages/core/src/memory/memory-promotion.ts` is hardcoded against
those tables. `memory-inject.ts` builds the prompt block from those
tables.

There is no `MemoryBackend` interface. A user who wants to:

- Replace recall with a Qdrant or Pinecone tier.
- Drop the chunk tier entirely (some agents don't promote).
- Add an episodic tier (one note per meeting, TTL'd to a week).

…has to fork.

**Spec.** Two layers:

```ts
export interface MemoryStore {
  kind: string;                       // "recall" | "chunks" | "core" | ...
  write(note: MemoryNote): Promise<MemoryId>;
  search(query: string, opts: SearchOpts): Promise<MemoryHit[]>;
  delete(id: MemoryId): Promise<void>;
  // optional: promote, sweep, summarize
}

export interface MemoryComposer {
  // Decides which stores get written to and how prompts are assembled.
  injectBlock(ctx: PromptContext): Promise<string>;
  recordObservation(text: string, source: ObservationSource): Promise<void>;
}
```

The default `MemoryComposer` mirrors today's behavior (recall +
chunks + core + facts, with the current promotion rules). A user can
register a different composer or add stores to the default composer's
roster.

```yaml
memory:
  stores:
    recall:    { kind: sqlite-embeddings }    # default
    chunks:    { kind: sqlite-embeddings }    # default
    core:      { kind: file }                 # default
    episodic:  { kind: qdrant, url: ... }     # custom
  composer: default                            # or a registered name
```

**Lift.** Bigger refactor. ~1 week. Migration story: existing DBs keep
working with the default composer. `memory-promotion.ts` becomes the
default composer's implementation. The `recall` / `chunks` /
`core_memory` / `facts` tools each route through `MemoryComposer`
instead of touching SQL directly.

**Doc impact.** Memory page gets a "Backends" section. Memory-tiers
design doc moves to "default composer" framing.

This is the biggest lift on the list. It also unlocks the user
request most often hit: "can I plug in my own vector store?"

---

## 3. Channels

**Today.** `Channel` interface exists in `packages/core/src/channels/interface.ts`.
Discord is wired into CLI startup directly. There is no
`ChannelRegistry` on the runtime. Adding Slack means editing
`packages/cli/src/`.

**Spec.** Mirror the trigger registry pattern:

```ts
export interface Channel {
  id: string;                       // "discord", "slack", "imessage"
  start(runtime: AgentRuntime, config: unknown): Promise<ChannelHandle>;
}

export class ChannelRegistry {
  register(channel: Channel): void;
  list(): Channel[];
  get(id: string): Channel | undefined;
}
```

Discord registers itself in `@tailored-ai/core` (built-in). A
hypothetical `@tailored-ai/slack` package registers on import.
`config.yaml`:

```yaml
channels:
  discord:
    token: ${DISCORD_BOT_TOKEN}
    enabled: true
  slack:
    botToken: ${SLACK_BOT_TOKEN}
    enabled: true
```

**Lift.** Small refactor. ~2 days. The interface exists; the work is
registry + CLI wire-up + config loader changes.

**Doc impact.** Channels page already flags this as v0.2 plugin work.
After this lands, that section becomes "Channels" instead of "v0.2".

---

## 4. Providers (LLM)

**Today.** `AIProvider` interface in `packages/core/src/providers/interface.ts`.
`createProvider()` in `factories.ts` switches on type (`openai`,
`anthropic`, `ollama`). Adding Bedrock or Cohere requires editing the
switch.

**Spec.** A `ProviderRegistry`. Built-ins (OpenAI, Anthropic,
OpenAI-compatible) register on import. Third parties register their
own:

```ts
import { registerProvider } from "@tailored-ai/core";
import { BedrockProvider } from "@tailored-ai/bedrock";

registerProvider("bedrock", (config) => new BedrockProvider(config));
```

`config.yaml`:

```yaml
providers:
  default: openai
  bedrock:
    type: bedrock
    region: us-east-1
    model: anthropic.claude-3-sonnet
```

**Lift.** Small refactor. ~1 day. Refactor `createProvider` into a
registry lookup. Built-ins stay built-in; the test is whether an
external package can register without forking.

**Doc impact.** Configuration page gets a "Custom providers" section.
Provider names move from enum to discoverable list.

---

## 5. Embedding providers

**Today.** `EmbeddingProvider` interface exists. Only
`OpenAICompatibleEmbeddingProvider` is instantiable from the factory.
Tied up in the memory backends gap above — once `MemoryStore` is
pluggable, a Qdrant tier brings its own embedder. But the standalone
embedder choice still matters (the default recall store needs one).

**Spec.** Same registry pattern as providers. `embedding:` block in
config picks the implementation.

**Lift.** Trivial once Providers are done. ~half a day. Same registry
shape.

**Doc impact.** Memory page surfaces the `EmbeddingProvider` interface
and lists supported backends.

---

## 6. Task backends

**Today.** `TaskBackend` interface clean. Factory switch hardcoded to
`native`, `github`, `beans`, `beads`. Documented honestly. Adding Jira
means editing the switch.

**Spec.** Same registry pattern as providers and channels. The
interface is already shaped for this; only the factory needs to be a
lookup.

**Lift.** Trivial. ~half a day.

**Doc impact.** Tasks page already says "implement `TaskBackend`."
After the registry lands, it can say "register it" with a code
sample.

---

## 7. Step executors

**Today.** Registry exists. `StepExecutor` interface exists.
Workflows page lists 10 built-in step types but does not mention the
extension path.

**Lift.** Doc-only. Add a "Custom step types" section to the
Workflows page with a 15-line example. ~1 hour.

**Doc impact.** Just the Workflows page.

---

## Priority order

Ranked by user-value-per-day-of-work, not strict dependency:

1. **System prompt composer** (1 day) — unlocks per-agent prompt
   tailoring, which is the most-requested customization.
2. **Channels registry** (2 days) — unblocks Slack, Telegram, iMessage
   plugin packages.
3. **Provider registry** (1 day) — unblocks Bedrock, Cohere, custom
   gateways.
4. **Embedding provider registry** (half day) — small, falls out of #3.
5. **Task backend registry** (half day) — small refactor of existing
   factory.
6. **Step executor doc fix** (1 hour) — pure documentation.
7. **Memory backends** (1 week) — biggest lift, biggest payoff. Phase
   on its own.

Items 1–6 are all v0.2 candidates. Item 7 is a v0.3 conversation.

## Conventions across registries

If we're going to add four registries, they should look alike.

- Each registry has `register(id, factory)`, `get(id)`, `list()`.
- Built-ins register from `@tailored-ai/core` on module load.
- Config picks implementations by `id` string. Schema accepts unknown
  ids with a warning at load time (so plugins that fail to load
  surface clearly).
- Each registry exposes its known ids via a `GET /api/<name>` endpoint
  for the UI's picker components.

A small shared utility (`createRegistry<T>()`) keeps the four
identical at the type level. Tools and triggers can migrate to the
shared utility too, so the pattern is uniform across the codebase.
