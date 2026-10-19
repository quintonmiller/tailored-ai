---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

An agent with a body can change its room. The new built-in `builtin:places` plugin keeps each agent's room as a `place` world-state record and gives the agent a `place` tool to add, move, restyle and remove furniture in words ("by the window", "on the desk"), resize and repaint the room, and undo. The chat page redraws the room as soon as it changes. The plugin does nothing unless some agent has an avatar.
