---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
---

An agent with a body can take a photo of its room or a selfie and send it. The `place` tool's new `photo` action renders the room in a headless browser (Playwright) and returns the picture, so it goes out with the reply on Discord and shows under the reply on the chat page. The web chat now shows any picture a turn's tools made with the reply, as Discord already attached them. The server gives its runtime a read-only way to reach itself (`runtime.getSelfAccess()`), which the camera uses to load the page.
