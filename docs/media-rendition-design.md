# What the model sees when a picture arrives

An image reaching an agent currently has one fate: it is hydrated to bytes and
handed to the provider as an `image_url` part, or — if the model declares it
cannot take pictures — flattened to a text placeholder. Two outcomes, chosen by
capability, never by preference.

There are good reasons to want others. Image tokens are expensive and a
screenshot of a terminal is mostly text; a local model may read OCR output
better than it reads the picture; a path is sometimes all an agent needs,
because its next move is a shell command. None of those are *the* right
behaviour, which is the point of this document: they are **configurations**, and
the work is a seam that lets a deployment pick one, not a new default.

This proposal covers five asks, all from the same conversation:

1. OCR the image and give the agent the extracted text instead of image tokens.
2. Give the agent only a path (local or remote), no image tokens.
3. Give the agent a compressed/resized image, with the settings in plugin config.
4. Give the agent a cheap version *plus* a handle it can spend to ask for more.
5. Have another agent or an API describe the image, and pass that description on.

## The pipeline today

```
surface (Discord DM, room, /api/chat)
   └─ bytes → MediaStore.put() → MediaRef {id = sha256, mimeType, w/h, name}
        └─ history stores the REF, never the payload

per round:   hydrateMedia(messages, store)        async, once, shared by all rungs
per rung:    shapeForCandidate → adaptForCapabilities   sync, per candidate
             └─ provider.chat({ ..., media: hydrated })
                  └─ toOpenAIMessages emits image_url / Anthropic image blocks
```

Two facts about that shape decide most of the design.

**`hydrateMedia` is the only async media step**, and it deliberately runs once
per round rather than per rung, because "a fallback chain sends the same history
to each candidate". Anything that has to *do work* on an image — OCR, a resize,
an HTTP call to a describing model — belongs at this level or above it.

**`adaptForCapabilities` is synchronous**, and runs per candidate. It is the
existing precedent for "replace a picture with text" (`flatten`), which makes it
the tempting home for all of this. It is the wrong one: it cannot await, so an
OCR pass there would have to block or be pre-computed. What it should keep doing
is deciding *whether a rung can take media at all*.

## What already exists

More than I expected, which is why this is a smaller job than it looks.

| Need | Already there |
|---|---|
| A stable handle for "that image" | `MediaRef.id` is the sha256 of the bytes — content-addressed, so it is already the id item 4 needs |
| A text projection | `mediaPlaceholder()` renders `[image: chart.png 1280x1000 image/png #cafc7f71]`, and the short id is *already visible to the model* |
| Media→text substitution | `adaptForCapabilities` + `MediaPolicy` already do this under `degrade` |
| A URL for the bytes | `MediaRef.url` plus `media.urlBase`, which the HTTP API serves blobs from |
| An OCR engine | `tesseract.js` is already an optional dependency, wrapped by `extractImage()` in `tools/extract-document.ts` |
| The registry pattern to copy | `media/registry.ts` — string key, open selector, opaque options bag |
| Dedupe and retention for derived bytes | The store is content-addressed, so a rendition stored twice is one blob |

## What shipped

The seam, and no strategy. Core knows how to ask "what should this model be
shown"; it does not know what OCR is.

| | |
|---|---|
| `media/renditions.ts` | the `MediaRendition` interface, the registry, `applyRenditions`, and `recipeFor` |
| `media/rendition-cache.ts` | SQLite-backed cache over `media_renditions` |
| `media.renditions` / `media.rendition` | named recipes and the deployment default |
| `agents.<name>.mediaRendition` | per-agent override |
| `ctx.mediaRenditions`, `ctx.mediaStores` | plugin registration, both new |
| `ToolContext.mediaStore` | so a plugin tool can hand a picture back |

Three things came out of building it that the proposal did not predict.

**There are two request-building paths, not one.** The round loop and the
out-of-rounds final report each compose their own `messages` from `history`.
Wiring the first and not the second is how a feature works for ordinary turns
and silently does not for the turn that ran out of rounds — which is what the
first version of this did, and what a test now pins. Both now go through one
`renderHistory` helper so a third path cannot quietly skip it.

**Renditions are applied before the history is trimmed**, not after. A rendition
changes size, usually by a lot: a page of OCR text is a fraction of the 1,500
tokens the same screenshot is priced at. Trimming first would evict real turns
to make room for bytes that were about to be replaced.

**`registerMediaStoreFactory` returned `void`.** Every other registration in core
returns its inverse; this one dropped the disposer the registry already handed
it, which made a media-store plugin the one kind that could not be unregistered.
Fixed on the way past.

## The seam

One interface covers all five asks, because all five are the same operation:
*given a reference, decide what the model actually receives.*

```ts
export interface MediaRendition {
  /** What the model gets instead of the raw part. May be text, media, or both. */
  render(ref: MediaRef, ctx: RenditionContext): Promise<ContentPart[]>;
}

export interface RenditionContext {
  store: MediaStore;
  /** Bytes, if this rendition needs them. Lazy: a path-only rendition never reads. */
  bytes(): Promise<Buffer>;
  /** Config for this rendition, verbatim — the opaque options bag. */
  options: Record<string, unknown>;
  /** For renditions that ask a model to describe an image. */
  runtime: AgentRuntime;
}
```

`ContentPart` already exists and is already a union of text and media, so the
return type needs no new vocabulary. The five asks fall out of it:

| Ask | Returns |
|---|---|
| 1. OCR | `[{ type: "text", text: ocr }]` |
| 2. Path only | `[{ type: "text", text: ref.url ?? pathFor(ref) }]` |
| 3. Resized | `[{ type: "media", media: smallerRef }]` |
| 4. Cheap + handle | `[{ type: "media", media: thumbRef }, { type: "text", text: "full image #abc123 — media(action=\"get\", id, size)" }]` |
| 5. Described | `[{ type: "text", text: description }]` |

Selection is config, per agent and per rung, with the same shape every other
registry uses:

```yaml
media:
  renditions:
    ocr-only:
      transform: ocr           # a registered factory id
      options: { language: eng }
    thumb:
      transform: resize
      options: { maxWidth: 640, quality: 60 }

agents:
  triage:
    media: { rendition: ocr-only }     # this agent never pays for image tokens
  designer:
    models:
      - provider: openai_compatible
        model: qwen3.8-27b
        media: { rendition: thumb }    # local rung gets a thumbnail
      - provider: anthropic
        model: claude-sonnet-5         # cloud rung gets the original
```

## Writing one

A rendition is a factory and a function. This is the whole of a path-only
plugin, which is the smallest useful one — it never reads the bytes at all:

```ts
export default function plugin(ctx: PluginContext) {
  ctx.mediaRenditions.register("path", ({ options }) => ({
    async render(ref) {
      const base = String(options.urlBase ?? "");
      return [textPart(base ? `${base}/${ref.id}` : `media://${ref.id}`)];
    },
  }));
}
```

```yaml
media:
  renditions:
    path-only: { transform: path, options: { urlBase: "https://host/media" } }
agents:
  shell-runner:
    mediaRendition: path-only
```

The other four differ only in what they return. An OCR rendition awaits
`ctx.bytes()` and returns one text part; a resize returns
`[mediaPart(await ctx.store.put(smaller))]`; a describing rendition calls a
model and returns its answer; and the cheap-copy-plus-handle case returns both a
media part and a text part naming `ref.id`, which the agent spends on a tool the
same plugin registers — `ToolContext.mediaStore` is there so that tool can read
the original back.

Three properties worth knowing when writing one:

- **`ctx.bytes()` is lazy and memoised.** Never called, never read; called
  twice, read once.
- **Throwing is safe.** A rendition that fails is logged and its part is left
  alone. A broken OCR plugin costs the agent its text extraction, not its
  picture and not its turn.
- **Results are cached by `(blob, recipe)`,** and both halves are
  content-derived, so an entry never goes stale. Change the options and you get
  a different recipe, not a wrong answer.

## Where it runs

Once per round, before hydration and before trimming, in `_runAgentLoopBody`.

Before hydration because a rendition can mint bytes that did not exist when the
round began — a thumbnail, a re-encode — so hydrating first would fetch the
original and miss the replacement. Before trimming because a rendition changes
size, and trimming the original would evict turns to make room for bytes about
to be replaced. Once per round rather than per rung for the reason hydration
gives: a fallback chain sends the same history to every candidate.

Both request-building paths go through the same `renderHistory` helper — the
round loop and the out-of-rounds final report. The compaction summariser does
not, and does not need to: it builds its transcript through `messageText()`, so
media is already projected to text before it gets there.

## Renditions are media too, and retention nearly ate them

A rendition's derived bytes go in the same content-addressed store — free
dedupe, one code path — and the mapping lives in `media_renditions`, keyed by
`(parent_id, recipe)`. Both halves of that key are content-derived, so an entry
never goes stale.

The trap was retention. `findExpiredMedia` sweeps on `last_seen_at`, and only a
`put` refreshed it — reading never counted, which was harmless while reading was
the only other thing anyone did. It stops being harmless the moment a rendition
exists: the rendition becomes the thing being served, the original stops being
touched, and the sweep deletes it first. That breaks the one case that depends
on the original outliving its cheap copy — an agent handed a thumbnail, spending
its handle an hour later on an image that is gone. Nothing fails at the time; it
fails a week later, on exactly the request the feature exists to serve.

The fix is `touchMedia`, called on the **parent** whenever a rendition of it is
written or served. Serving a rendition is using the original, and retention had
no other way to know. There is a test for it, and reverting the touch fails it.

## Tiering

Core (tier 1) is built: the seam, the registry, the cache, the retention fix,
config selection, the plugin surface, and `ToolContext.mediaStore`. Core ships
no strategy and knows no strategy's name.

Plugins (tier 2) are what remains, and none of them belong in this repo unless
they earn it the ordinary way:

- `ocr` — wraps the `tesseract.js` path `extract-document.ts` already uses
- `path` — no dependency; the example above is the whole thing
- `resize` — brings `sharp` or `jimp`, which is the reason it is not core
- `describe` — calls a model through the runtime
- `thumb+handle` — composes `resize` with a tool that reads
  `ToolContext.mediaStore`

## What this deliberately does not do

**It is not a default.** Every deployment that works today works because an
image reaches a vision model as an image. Configure nothing and nothing changes:
`media.rendition` unset means the picture is passed through untouched.

**It does not rewrite the record.** Renditions shape the request, the same way
capability adaptation and hydration do. The session keeps the original
reference, so turning a rendition off gives the pictures back, and turning one
on does not rewrite what earlier rounds saw. This answers the "what does the
record keep" question the first draft left open — the record keeps the truth,
and the model sees the view.

**It does not put renditions in `adaptForCapabilities`.** That function is
synchronous and runs per rung, and its question — "can this model take media at
all" — is a different one from "what should this model be shown". Answering both
there is how an OCR pass ends up inside a function every rung calls.

## Still open

- **Per-rung selection**, as above.
- **Does a rendition see the conversation?** A describing model does better with
  "the user asked about the error in this screenshot" than with the image alone.
  Passing context in makes it part of the cache key, which mostly defeats the
  cache. Not done; the `RenditionContext` can grow a field without breaking
  anyone.
- **Failure policy.** A rendition that throws currently keeps the original,
  which is the safe default. `MediaPolicy` already argues this out for
  capabilities (`degrade` / `skip-rung` / `error`) and the same three answers
  would apply if anyone wants them.
