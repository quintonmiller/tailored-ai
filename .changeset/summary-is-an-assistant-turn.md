---
"@tailored-ai/core": patch
---

Write the compaction summary as the agent's own note, not as something the user said.

`compactSession` stored its summary as a `role: "user"` message. From the model's
side that is the person on the other end having just narrated a third-person
account of the conversation — so it continues the narrative instead of answering
the message that actually arrived.

Measured on a real companion session after compaction, replying to an ordinary
greeting:

| summary in history | replies that carried on about events from the summary |
|---|---|
| as a `user` turn (before) | **4 of 5** |
| reworded, still a `user` turn | 3 of 5 |
| as an `assistant` turn | **1 of 5** |
| no summary at all | 1 of 5 |

The role is doing the work; rewording it barely moved. As an assistant turn the
summary reads as the agent's own note about earlier — context it already has,
rather than a prompt to respond to.

Symptom this fixes: an agent replying to one person with a message addressed to
someone else, copied from the summarised history. `[assistant, user]` was checked
against Anthropic, OpenAI and DeepSeek before changing this; all three accept it.
