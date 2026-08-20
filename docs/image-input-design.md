# Image input — a design for review

Nothing here is built. This is a proposal for a **tier-1 core seam**, written to
be argued with before any of it is written.

## What is actually blocked

Checked on 2026-08-20 rather than assumed, because this package spent a week
asserting the opposite:

| layer | state |
|---|---|
| the weights | `image-text-to-text`, `multimodal`; the served artifact contains "the registered Text, **Vision**, MTP, optimized proposal-head, tokenizer" |
| the server | NInfer takes `--vision` — "enables media and loads the fixed Vision GPU allocations". Off, so an `image_url` part returns `400 vision_disabled` |
| **TAI** | **`ToolResult.output` is a `string`. `Message.content` is `string \| null`. There is nowhere to put an image.** |

TAI's existing answer to an image is `extract_document`, which OCRs it to text
with `tesseract.js`. That is right for a scanned invoice and useless for a game
screenshot, a chart, or a UI bug.

## The one measurement that should gate this

We now own an instrument that can say whether this is worth building: the
workshop. Same brief, same seed, same theme, two arms — one where `playtest`
returns its text description, one where it returns the screenshot — and a person
scores both on the same six categories.

**That should run before phase 2.** The feature is plausible rather than proven:
a 32×16 luminance grid plus a colour histogram already let a tester identify a
title screen and diagnose a black canvas. It is entirely possible that an image
is worse per token than the description, and if so this is a smaller feature
than it looks.

## Decision 1 — a sibling field, not a widened `content`

The obvious move is `content: string | ContentPart[] | null`, matching the wire
format. It is wrong here. **121 sites in core read `.content`**, most of them as
`msg.content ?? ""`; each becomes a place that renders `[object Object]` into a
prompt, a log, a summary or a Discord message. That is not a refactor with a
finish line.

```ts
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;   // unchanged, and still the text
  media?: MediaRef[];       // new
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoning?: string;
}
```

Every existing reader keeps working, and a message carrying an image still
carries text — a placeholder like `[screenshot 960×720]` — so a text-only
provider degrades to something readable instead of something broken.

The precedent is in the same interface: `reasoning` was added exactly this way,
as a sibling that some providers emit, that is persisted and rendered, and that
converters deliberately drop.

## Decision 2 — the bytes live outside the message

Not base64 in `content`, and not base64 in SQLite. `messages.content` is a TEXT
column; a 90 KB screenshot is ~120 KB of base64, and the workshop's last run
called `playtest` 58 times.

```ts
export interface MediaRef {
  id: string;            // sha256 of the bytes
  mime: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width?: number;
  height?: number;
  /** Estimated prompt cost. See decision 4. */
  tokens: number;
  /** What a text-only provider shows instead. */
  alt: string;
}
```

Bytes go to `<TAI_HOME>/media/<sha256>.<ext>`, content-addressed, so the same
screenshot stored twice costs one file. The message row gains a `media TEXT`
column via `ALTER TABLE messages ADD COLUMN media TEXT` — the additive pattern
the schema already uses everywhere.

## Decision 3 — the tool-result problem, which is the sharp one

**OpenAI-compatible endpoints do not accept image parts in a `tool` message.**
Image parts are a `user`-role feature there. Anthropic *does* allow images
inside a `tool_result` block. So a tool that returns an image cannot be relayed
the same way on both.

Proposed: the converter owns this, and the two shapes are named.

- **Anthropic** — inline the image into the `tool_result` block. Its converter
  is already `ContentBlock[]`-shaped, so this is the natural path.
- **OpenAI-compatible** — emit the `tool` message with text only, then a
  synthetic `user` message carrying the image, captioned with the call it
  belongs to: `Output of playtest (call_abc):` + the image part.

The synthetic message is a real behaviour change — it alters the message
sequence, and strict tool-call validators may object to a `user` turn between a
tool result and the next assistant turn. **This is the single biggest unknown in
the design and phase 0 exists to settle it.**

## Decision 4 — token accounting has to stop lying

`estimateTokens` is `content.length / 4`. It is the input to history trimming
and to every budget check. With media it must add a declared cost, because
neither answer is close: base64 length would say a screenshot is 30,000 tokens,
and ignoring it would say zero.

Estimate at attach time with a provider-agnostic heuristic (tiles of 512², plus
a base) and store it on the ref. It will be wrong in the third digit and right
in the first, which is what trimming needs. Providers that report exact image
tokens in `usage` can correct the stored value afterwards.

## Decision 5 — images are evicted before text, and there is a cap

The piece that makes this survivable. Images are expensive and, unlike a
transcript, **not summarisable**: a compaction pass can turn ten messages into a
paragraph and can do nothing with a PNG.

- `agent.maxImagesInHistory`, default small (2–4). Older refs are dropped,
  keeping their text placeholder: `[screenshot 960×720 — dropped from history]`.
- Media is evicted **before** any text trimming runs, so a long conversation
  loses pictures before it loses what people said.
- Eviction drops the ref, never the file. The bytes stay on disk for the human.

## Decision 6 — off by default, per provider

`providers.<id>.vision: boolean`, default false. When false the converter drops
media to placeholders and the run still works. No capability sniffing: a wrong
guess here is a 400 on every request, and the descent's history is full of
config keys that parsed and were never read.

## What lands where

Per the repo's tiering, this splits and the seam must make sense without the
consumers:

**Tier 1, core** — `MediaRef`, `Message.media`, `ToolResult.media`, the media
store, the `messages.media` column, token accounting, the eviction policy, and
the `openai_compatible` converter.

**Tier 2, provider plugins** — Anthropic (blocks, native tool_result images),
OpenAI (Responses API shape), Bedrock, DeepSeek, OpenRouter. Each in its own
package, each optional.

**Tier 2, consumers** — `playtest` returning media; Discord inbound attachments,
which is the other real source and today is not handled at all; and a path for
`extract_document` to hand back the image as well as the OCR.

## Phases

**Phase 0 — spike, no core code (half a day).** Restart NInfer with `--vision`
and settle three questions with `curl`:

1. Does the vision allocation fit alongside `--max-context 131072` on a 32 GB
   card? `--vision` "loads the fixed Vision GPU allocations" and the text
   artifact is already 21.5 GB.
2. Does it accept an image part in a **`tool`** message, or only in `user`?
   This decides Decision 3 and nothing else can be built confidently first.
3. What does an image do to **prefix caching**? The workshop's economics depend
   on it — 29 M input tokens in a run — and if an image invalidates the prefix
   every turn, the feature costs far more than it looks.

If (1) fails, everything below still lands; it just cannot be tested locally
against this model.

**Phase 1 — the seam.** Types, store, column, converter, accounting, eviction,
config flag. Behind `vision: false` so nothing changes until asked. ~600 lines
plus tests, including a provider-contract case so every provider plugin has to
answer the question.

**Phase 2 — the measurement.** The A/B above. Two workshop runs, same seed and
theme, image versus description, scored blind on the six categories.

**Phase 3 — providers and consumers**, ordered by what phase 2 says.

## What could make this not worth doing

Stated up front, because a core seam is the most expensive thing to be wrong
about:

- **The description may be competitive.** A luminance grid diffs cleanly between
  frames, survives a history trim, and costs ~600 characters. An image does none
  of those and costs perhaps 1,500 tokens.
- **Prefix caching.** If images break it, a run's cost could rise several-fold
  for a marginal quality gain.
- **It is one model.** Vision here is Qwen3.8's; the deployment's default agent
  runs a cloud model whose image support and pricing are different.
- **The eviction policy is a guess.** Two images is a number nobody has
  measured; it exists so the first version cannot run away.

## Open questions for Quinton

1. **Is this worth a core seam now, or after phase 2 says it helps?** The
   honest ordering is spike → measure → build, and the plan above is written
   that way, but it means phase 1 sits unbuilt for a while.
2. **Should `ToolResult.media` exist at all**, or should images reach the model
   only through user messages and channels? Restricting it avoids Decision 3
   entirely — at the cost of the workshop's `playtest`, which is the use case
   that raised this.
3. **Does the media store belong in `<TAI_HOME>/media/` or in the existing
   resources tree?** I have not read enough of the resource registry to say.
4. **Discord attachments first?** It is a more common path than tool media, has
   no protocol ambiguity, and would exercise the same seam.
