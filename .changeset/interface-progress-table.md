---
"@tailored-ai/core": patch
---

Two more interface kinds. `table` shows the world-state records a query matches as rows and columns, filled and kept current like a list (columns default to the title field, then the other fields). `progress` says how far along a job is, as a value out of a max or as named steps, and is moved with `update`, which redraws it in place everywhere. The web UI draws a table and a bar; Discord draws an aligned monospace block and `▓▓▓░░` bars or marked steps.
