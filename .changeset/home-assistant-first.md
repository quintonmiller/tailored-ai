---
"@tailored-ai/ui": patch
---

Rebuild the Home page as the assistant's surface. The old dashboard of stacked
list cards (Now / Needs Human / Upcoming / Recent / health) is replaced by a
single centered column: an eyebrow status line, a large serif-italic briefing
hero (the agent's voice), a flat hairline "Needs you" stack with deep-link
actions, reused suggestion chips as quick actions, a docked ask bar that hands
off the typed message to Chat through the shared chat store, and a one-line
footer status. One orchestrated fade-up reveal on load (respecting
`prefers-reduced-motion`). All data comes from the existing config-gated
endpoints (briefing, suggestions, autopilot activity, blocked tasks, pending
forms/approvals, failed runs, cron, health) and the page degrades gracefully
when any are disabled. Folds the standalone `BriefingCard` into the new hero.
