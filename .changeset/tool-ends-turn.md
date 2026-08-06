---
"@tailored-ai/core": patch
---

Core: let a tool end the agent's turn (`ToolResult.endsTurn`)

Telling a model to stop *in a tool result* does not work on small models. A tool
whose entire meaning is "I am done" was still followed by another round-trip
asking what to do next, and a 27B model answered by calling it again.

Measured on a live deployment, over three scheduled room check-ins:
`room(action="pass")` was called **3 times each**, 9 provider calls for 3
decisions, 505,209 prompt tokens to say nothing — and every one of them exited
through the repeated-call detector, so the most deliberate stop the loop has was
reported as a stall.

`ToolResult` gains `endsTurn` and `endsTurnReason`. The loop honours them after
the round's results reach history and before the repeated-call detector, and
reports `LoopStop { kind: "tool-ended", tool, reason }`, which `isStallStop()`
correctly treats as a clean exit. `endsTurnReason` becomes the loop's return
value; unset, it falls back to the model's own text, which for a tool meaning
"nothing to say" is normally empty.

The flag lives on the result rather than on the tool because a multi-action tool
ends the turn on some actions and not others: `room` post and read continue,
`room` pass does not. It is deliberately not gated on `success` — whether a tool
worked and whether it meant to stop are separate questions. Where two calls in
one round both set it, the first wins. The `pass` that finds no room to silence
stays non-terminal: nothing was decided, and the agent still has a correction to
act on.

This replaces a private convention rather than adding a second one. `sleep` used
to signal through `workingMemory["tick_done"]`, which the loop special-cased —
a real platform capability that only core tools could discover, in a codebase
whose rule is that built-ins register the way third parties do. `sleep` now
returns `endsTurn`, and any tool can, including plugin and MCP tools.

**Breaking (type-level):** `LoopStop`'s `{ kind: "sleep" }` variant is replaced
by `{ kind: "tool-ended"; tool: string; reason?: string }`. Nothing branched on
it in-tree — the exploratory worker tests only `isStallStop` and `max-rounds` —
so runtime behaviour for ticks is unchanged, including the `[Sleep] <reason>`
string that chat `live_state` reads.
