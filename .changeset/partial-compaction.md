---
"@tailored-ai/core": patch
---

Compaction can keep a recent window instead of replacing everything.

`compactSession` was all-or-nothing: the whole session became one summary. For a
long-running conversation that is the wrong trade. Measured on a real
1,632-message session, the full history summarised to **907 characters — a 534x
reduction**. The summary was accurate about participants, events and current
state, and it discarded the voice, the running context and every established
preference. What makes such a session worth keeping is exactly what a synopsis
loses.

`compactSession(db, id, provider, model, { keepRecent: 200 })` folds away only
what precedes the newest 200 messages. On that same session it takes the request
from ~142,000 real tokens to ~33,000, and takes the share of the request
occupied by the user's actual new message from 0.019% to 0.073% — which is the
number that decides whether the model answers you or answers its own history.

Two details that make it correct rather than merely smaller:

- **Only the hidden part is summarised.** Sending the kept window to the
  summariser as well would put the same content in the next request twice, once
  summarised and once verbatim.
- **Summaries sort ahead of surviving messages.** A summary row is written last
  and carries the highest id, but stands in for the *oldest* content; ordering on
  id put a synopsis of the beginning after the turns it precedes. Ordering on the
  compaction batch restores chronology, and holds across repeated compactions
  because each batch only ever replaces content older than everything visible.

`keepRecent` defaults to 0, so existing callers are unchanged. Undo restores the
whole batch either way.
