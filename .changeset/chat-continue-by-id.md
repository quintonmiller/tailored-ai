---
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

A message on the chat page always continues the conversation on screen. When the page has a conversation open but no key for it (restored from storage or a link written before keys were kept), it now names the conversation by id, and `/api/chat` continues it: by its key when it has one, directly when it has none. Before, such a message quietly started a new conversation.
