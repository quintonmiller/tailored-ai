---
"@tailored-ai/core": patch
"@tailored-ai/channel-slack": patch
"@tailored-ai/cli": patch
---

Agents can send media out to Discord, Slack, and the terminal, not only receive it.

Inbound media has worked since the attachment support landed: an agent could be
shown a screenshot on Discord and describe it. Sending one *back* was
unrepresentable, because `Channel.send` took a string. So an agent asked to
screenshot a page could see the result and talk about it, while the person who
asked to look at it got only prose.

`Channel.send` and `OutboundNotifier.send` now take `string | MessageContent`.
Both had to widen: `OutboundNotifier` is the interface every production caller
actually resolves through, and widening only `Channel` would have shipped a
parameter nothing could ever pass — the failure mode this workstream has already
hit twice.

Surfaces declare what they can show through a required `SurfaceCapabilities`,
modelled on `RoomCapabilities`. Required rather than optional on purpose: an
optional capability field is one nobody fills in and nobody reads, which is how
`AIProvider.supportsTools` spent its entire life. Surfaces with nothing to
declare spread `TEXT_ONLY_SURFACE` and are then honestly described rather than
merely undescribed. The message-length limits move in too — they were a
`MAX_MESSAGE_LENGTH` constant copy-pasted into two `splitMessage`
implementations, which is one fact recorded twice with nothing keeping the
copies honest.

One shared `renderForSurface()` applies the degradation ladder — attachment,
then link, then text placeholder — so three transports cannot each decide
differently what to do with a file too large to upload. It enforces the rule the
media design states outright: a part that does not reach the reader leaves a
warning or a placeholder, never nothing. Writing the test for that caught a real
defect in this change, where a deployment with no media store configured
produced neither an upload nor a placeholder: the ladder had been told the
surface could attach, so it skipped the placeholder, and then nothing uploaded
the file. Both transports now report what they cannot do *before* rendering
rather than after.

The media a channel sends comes from the message record, read back with
`collectTurnMedia()` against a watermark taken before the turn. That is the same
source the web UI already renders from, so a channel and the UI cannot disagree
about what a turn produced, and it avoids widening `runAgentLoop`'s return type
across eighteen call sites — most of which only ever want text — to serve three
surfaces. Only `tool` and `assistant` rows are read, so an inbound photo is
never echoed back at the person who just sent it, and results are deduped by
content hash: an agent that screenshots an unchanged screen three times has one
blob and sends one file.

Discord uploads through `files:` on the last text chunk, so attachments never
float above the prose explaining them. Slack posts text then uploads through
`files.uploadV2`, and an upload failure is logged rather than thrown — the text
has already been posted, and throwing would report the whole reply as failed
when most of it arrived. The CLI prints a placeholder and a `file://` path to
stderr, keeping stdout exactly the answer for anyone redirecting it. Terminal
inline images are deliberately not attempted: emitting an iTerm2 escape sequence
to a terminal that does not understand it dumps kilobytes of base64 into the
user's scrollback.

`MediaStore` gains an optional `localPathFor()` for surfaces that can open a
path. Optional because a store backed by S3 genuinely has none, and returning a
fabricated path would be worse than returning nothing.
