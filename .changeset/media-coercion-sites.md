---
"@tailored-ai/core": patch
---

Fix four places where media-carrying content was silently coerced to a string.

The worst was live and user-visible. The agent loop's stall detector builds a
per-round signature from `results.map((r) => r.output).join("|")`. Since media
support widened `ToolResult.output` to `string | ToolOutput`, `join` stringified
the object arm to `[object Object]` — so **every** media-carrying tool result
compared equal to every other. A browser agent screenshotting two different
pages read as making no progress, and the loop took its screenshot tool away
mid-turn. The projection carries the content hash precisely so this works:
identical bytes still compare equal, different bytes no longer do.

Three quieter ones, all the same shape:

- A rewind preview read `messages.content` straight from the column, so anyone
  who had attached an image saw `{"__tai_content":true,…}` quoted back at them
  instead of an excerpt of what they said.
- Cron's `last_response` template variable read the same column the same way,
  pasting the encoded JSON into the next prompt — tokens spent teaching the
  model our storage format.
- A failing `tool_call` workflow step raised
  `tool_call "x" failed: [object Object]` when the tool returned media instead
  of an error string.

Worth naming the pattern rather than just the four sites. The original sweep
looked for `${...}` interpolation, because that is the coercion everyone
pictures. But `Array.prototype.join`, `String()`, and reading a TEXT column
without decoding it are the same hazard in different clothes, and none of them
is a compile error — TypeScript is happy to stringify an object anywhere a
string is merely conventional. When a widened type flows through a codebase,
grep for the operations that coerce, not for the syntax that usually does.
