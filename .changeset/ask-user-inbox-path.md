---
"@tailored-ai/core": patch
---

ask_user: write the inbox outside the directory that is injected into every prompt

`ask_user` appended questions to `<contextDir>/global/inbox.md`. Everything in
`global/` is read verbatim into every agent's system prompt on every turn, so a
queue meant for one person doubled as a broadcast to all of them — and nothing
ever removed a question once answered.

Observed: five questions accumulated over three weeks, about a task archived in
May and a hotel booking already made, read by 27 agents on every turn for two
months. One eventually reported the hotel question as its own outstanding work.
At 2.4 KB the file was half the entire global context budget, and none of it was
true any more.

The inbox now lives one level up, at `<contextDir>/inbox.md`, where
`loadAllContext` does not look. Nothing else read it — the file is a write-only
queue plus a `question.asked` event — so delivery and the configured
`tools.ask_user.inboxFile` name are unchanged.
