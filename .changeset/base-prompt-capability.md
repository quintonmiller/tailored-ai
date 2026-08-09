---
"@tailored-ai/core": patch
---

The base prompt now describes the agent it is addressed to

`BASE_SYSTEM_PROMPT` was a flat string constant, so two of its claims were told
to every agent whether or not they were true.

**"You are a self-modifying agent … creating new tools, adjusting settings"** went
to a `trip-researcher` and a `mail-sorter` as plainly as to a `supervisor`.
That instruction, plus `admin` being able to write `custom_tools.` and
`permissions.`, is the path by which an agent authored `temp: 0.3` into its own
config — a key that then parsed and did nothing.

It is now gated on `canSelfModify(resolved.tools)`, read from the agent's
**declared** `tools:` list. Reading the final tool set would not have worked:
`admin` and `resource_admin` are meta tools appended to every agent, so the flag
would be true for all of them and the paragraph would drop for nobody. There is
a test pinning that distinction. On the reference deployment this removes the
paragraph for 25 of 29 agents; the 3 that name `admin`, and any that declare no
`tools:` at all, keep it.

Nothing is revoked — the tool is still there and still callable when a task
needs it. It stops *encouraging* agents whose job is something else.

**"When context files are loaded below, use them as ground truth"** is now:
context files are notes written earlier, not a live feed; prefer what a tool
reports now; check the date on anything time-sensitive. They are snapshots that
nothing invalidates, and that sentence is why a two-month-old question in
`inbox.md` was reported as live outstanding work by three separate agents.

The memory section restated itself across two paragraphs and five bullets and is
now three. Net: the base prompt is ~26% smaller for agents without `admin` and
slightly smaller for those with it. The history budget is
`maxHistoryTokens - systemPromptTokens`, so this buys back conversation.

New: `buildBaseSystemPrompt(opts)`, `canSelfModify(declaredTools)`,
`AgentLoopOptions.selfModifying`, and an optional second argument to
`resolveBase`. An explicit `systemPrompt.base` / `baseFile` override is still
returned verbatim — a deployment that wrote its own base owns every sentence in
it. `BASE_SYSTEM_PROMPT` remains exported and is now the no-self-modification
shape.
