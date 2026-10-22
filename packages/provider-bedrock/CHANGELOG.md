# @tailored-ai/provider-bedrock

## 0.1.11

### Patch Changes

- 38b808b: Messages and tool results can carry media, not only text.

  `Message.content` is now `string | MessageContent | null` and `ToolResult.output`
  is `string | ToolOutput`. A plain string still means exactly what it did before,
  so every text-only call site and all 398 tool-result construction sites are
  unchanged; only code that _reads_ content had to say what it does about media.

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

- 2b9db74: Streaming support via ConverseStream (`chatStream` — text deltas + complete tool calls on done), plus `meta` and `validateConfig` plugin exports.
- 04c5c6d: New plugin: AWS Bedrock model provider. Registers the `bedrock` provider factory (Converse API, tool calling, AWS credential chain auth, optional `region`/`profile` config).
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
