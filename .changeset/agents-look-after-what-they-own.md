---
'@tailored-ai/core': patch
'@tailored-ai/ui': patch
---

Agents can look after what they own. With `upkeep: { every: 24h, agents: all }` in the `builtin:directory` plugin's config, each agent with the `commitment` tool gets an upkeep turn on that interval: one message, in its own `upkeep:<agent>` session, counting what needs a look (a next check that came, work waiting or quiet too long, finished work not archived, docs not reviewed, docs other agents read, questions nobody could answer, a missing or stale page note, notes nobody recalls, near-duplicate notes, notes about to expire, and pinned notes plus core memory over a token budget), and an invitation to tidy with the tools it already has. A turn is skipped when nothing changed since the last one, takes at most `maxRounds` rounds of tool calls, and says retiring means archiving. Every bar has a config key and a default; see `docs/directory.md#upkeep`. Off unless set.

The agent page shows when its last upkeep was and what it changed, counted from its records' history rather than from what the agent said, and has a "Tidy up now" button (`POST /api/ext/builtin:directory/agents/:name/upkeep`) that runs a turn at once, past the "nothing changed" check but not the pause.

Behaviour you may notice: an agent can now only give its own commitments `autonomy: suggest`. `tell` and `quiet` are a person's to grant, on the State page, in the hand-over form (which gains an autonomy choice), or on a commitment in the agent page's Working on list. An agent asking for more gets one sentence saying so; commitments it already set higher are left as they are. New commitment and doc ids are cut at a whole word instead of mid-word. Notes now record when recall last surfaced them (`recalled_at`, an additive column), and another agent's `writeup read` is counted for the doc's owner.
