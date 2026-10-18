---
"@tailored-ai/core": patch
---

Interface components now draw on Discord with Discord's own controls: a choice as buttons, a confirm as a green and a grey button, a card as an embed with its buttons, and a form as a button that opens a pop-up form. A click rewrites the message to show the answer, and the agent carries on in the same conversation. Only the person the conversation belongs to can answer (or the deployment owner, for a conversation nobody on Discord owns). Surfaces declare the kinds they draw with the new `SurfaceCapabilities.components`; anything else still gets the text form.
