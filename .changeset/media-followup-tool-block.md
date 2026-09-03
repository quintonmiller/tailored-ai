---
"@tailored-ai/core": patch
---

Stop the tool-result media workaround from splitting a tool-call block

When a model accepts media but not inside a tool result, core lifts it into a
following user turn. It emitted that user turn immediately after the offending
tool message — which is fine for a single tool call and wrong for several.

An assistant turn can open any number of tool calls, and every `tool` answering
it must follow with nothing in between. Inserting a user message after the first
media-bearing result splits the block and strands the rest:

    assistant(tool_calls: [a, b, c])
    tool(a)            <- returned a screenshot
    user(media)        <- inserted here
    tool(b), tool(c)   <- no longer adjacent

Strict providers reject the whole request for it. Observed in production as
DeepSeek's "An assistant message with 'tool_calls' must be followed by tool
messages responding to each 'tool_call_id'", then an OpenAI 400, then the turn
landing on the most expensive rung of the fallback chain — for one screenshot in
a multi-call turn.

The media is now held until the tool block closes and flushed as a single user
turn after it, keeping both the adjacency the API requires and the origin marker
that stops tool output looking like something the user said.
