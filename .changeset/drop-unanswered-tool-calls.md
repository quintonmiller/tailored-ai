---
"@tailored-ai/core": patch
---

Drop an assistant `tool_calls` that nothing answered, instead of sending it.

`stripOrphanedToolMessages` handled one direction — a `tool` result whose parent
was trimmed away — on the reasoning that the reverse was unreachable, since
results are dropped from the front where their parent goes too. That holds for
trimming alone and stops holding the moment anything else edits the window: the
same function resets its open-call set on a user or system message, so a user
turn landing between a call and its result drops the result and leaves the call
unanswered.

Every strict provider then rejects the entire request — DeepSeek "must be
followed by tool messages", OpenAI "no tool output found for function call",
Anthropic "`tool_use` ids were found without `tool_result` blocks" — and the
fallback chain fails again on every rung. Seen in production as three provider
errors and 26 retries for a single turn, absorbed by the fallback chain but paid
for four times over.

Unanswered calls are now removed from the message rather than the message being
dropped, so the assistant's text survives; a message left with neither text nor
calls is dropped, having nothing left to carry.
