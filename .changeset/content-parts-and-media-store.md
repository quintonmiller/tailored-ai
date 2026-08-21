---
"@tailored-ai/core": patch
"@tailored-ai/provider-anthropic": patch
"@tailored-ai/provider-bedrock": patch
"@tailored-ai/provider-openai": patch
---

Messages and tool results can carry media, not only text.

`Message.content` is now `string | MessageContent | null` and `ToolResult.output`
is `string | ToolOutput`. A plain string still means exactly what it did before,
so every text-only call site and all 398 tool-result construction sites are
unchanged; only code that *reads* content had to say what it does about media.

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
