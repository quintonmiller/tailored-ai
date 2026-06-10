---
"@tailored-ai/core": patch
---

Source the Discord delivery accessor for `discord_dm` and `ask_user` from the runtime's outbound registry instead of CLI-wired closures. `createTools` now narrows `getDiscord` to `OutboundNotifier`, and `AgentRuntime` wires `getOutbound("discord")` / `getOwnerId("discord")` into the tool factory so the CLI no longer hand-injects them (#66).
