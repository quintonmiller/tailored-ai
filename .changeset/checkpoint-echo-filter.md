---
"@tailored-ai/core": patch
---

Stop the compaction checkpoint saving the transcript back to itself.

The first real run of the memory checkpoint reported twelve durable facts saved.
Ten of them were lines like `[tool]: saved note_6c0a6ccf`, copied straight out
of the transcript it had just been shown.

Tool results are the most copy-shaped text in a conversation and carry nothing
worth remembering — they record that a call happened, not anything about the
people in it. They are now stripped before the checkpoint call, and any output
line still wearing a `[tool]:` / `[user]:` / `[assistant]:` prefix is rejected as
quoted history rather than a fact the model chose to keep.

Worth noting how this was found: the return value said `notesWritten: 12` and
every test passed. Only reading the twelve rows showed they were garbage.
