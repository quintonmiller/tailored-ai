---
'@tailored-ai/ui': patch
'@tailored-ai/server': patch
---

Tasks and agents are handled without leaving the 3D world. A note on a task board opens that task's card: change its status in one click, give it to an agent (the card says first whether that wakes the agent), edit it or archive it, and the board shows the change at once. A board away from a note, or the new Tasks button, opens a task list filtered by status and by whose tasks, newest first. An agent's menu opens its card: what it is doing, what it last said, when it next runs on its own, where it is, and buttons to chat, visit, send home, pause or wake. The lobby's New room kiosk says plainly what will happen before anything is written to the default agent. Panels take the chat's column on a wide screen and open as a sheet on a phone. The server adds `GET /api/task-watcher`, which says whether a task change wakes its agent.
