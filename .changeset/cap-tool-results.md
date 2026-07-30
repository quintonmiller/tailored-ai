---
"@tailored-ai/core": patch
---

Bound how much of a tool result reaches the conversation.

Nothing capped tool results. Tool *descriptions* were truncated at 300 chars
for local-model compatibility; results — the part that actually grows, and the
part that arrives from third-party servers whose response size is not ours to
choose — were unbounded.

Measured cost: one `mcp_notion_API-post-search` with `page_size: 50` returned
70,485 chars / 27,187 real tokens against an 18,800-token history budget.
`trimHistory` then evicted from the front until it fit, which meant evicting
the user's question, and `ensureUserMessagePresent` spliced the *first* user
message back in — so the agent answered a welcome message from an hour earlier
and introduced itself. Three times in forty minutes. The symptom reads as an
agent with amnesia, never as an agent with a large tool result.

`loop.ts` already says exactly this about the `<context>` block — "the symptom
is an agent that forgets rather than an agent with a big prompt" — and guards
the system-prompt side of the budget. This is the same hole on the history
side, where it is worse: per-turn, unbounded, and remote.

Adds `agent.maxToolOutputChars` (default 32000, `0` disables) with a per-tool
override at `tools.<id>.maxOutputChars`. Because the lookup is by resolved tool
name and `tools:` is an open map, MCP tools can be named there as
`mcp_<server>_<tool>` even though discovery never keys them.

The cap runs at the single `ToolResult`-to-string conversion in
`executeToolCall`, so builtin, custom, plugin and MCP tools are covered by one
check, upstream of `onToolResult`, the tool Message, `saveMessage()` and the
repeat detector. Over the limit, the result becomes a head+tail summary led by
a marker naming the tool, its real size, and a path to the full output — and
saying that repeating the call returns the same truncated string, since running
it again is the obvious move for a model handed a partial answer.

Two properties the tests pin. The result is byte-identical for identical input
(the scratch file is content-addressed, not timestamped) because the loop's
stuck-model detector compares consecutive results verbatim and a unique path
would silently disable it — the guard that catches a model re-issuing the call
that got truncated. And a scratch-write failure still truncates, rather than
falling back to the full string and reinstating the blowup.
