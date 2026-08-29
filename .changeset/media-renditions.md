---
"@tailored-ai/core": patch
---

Let a deployment choose what a model is shown when a picture arrives.

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
