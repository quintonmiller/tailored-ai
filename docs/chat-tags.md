# Chat Output Tags (DUX3 / DUX6 / DUX7)

Default chat-facing agents may emit a small set of XML-style tags inside their normal markdown output. The web UI lifts each into an interactive chip or card. Unknown / malformed tags fall back to inert text — the renderer never breaks a bubble.

## Entity chips (self-closing, inline)

- `<task id="ptask_..."/>` — fetches the task, renders title + status pill, links to `#/tasks/{id}`.
- `<agent name="researcher"/>` — links to `#/agents/{name}`, hover shows description.
- `<note id="note_..."/>` — fetches the note, shows first-line preview + ★ if importance ≥ 0.8.
- `<file path="..." line="..."/>` — monospace pill with optional line ref.

## Proposals (block-level — for things outside the current request)

```xml
<proposal kind="task|fix|note" priority="low|normal|high|critical" tags="a,b">
  <title>One-line summary</title>
  <body>Why and what.</body>
</proposal>
```

The user gets Accept / Tell-me-more / Dismiss. Accept routes to:
- `kind=task` → POST `/api/project-tasks` (tags: `["proposal", ...yourTags]`)
- `kind=fix`  → re-prompts the agent: "Please apply the fix you proposed: …"
- `kind=note` → writes a memory note (importance 0.6)

Dismiss writes a `dismissed-proposal` note so memory injection surfaces the dismissal next time the agent considers re-proposing.

## Asks (block-level — for clarifying questions mid-conversation)

```xml
<ask kind="choice" choices="yes,no,defer">Should I migrate the old key now?</ask>
<ask kind="text">What domain should I use?</ask>
```

Choice renders as buttons; text renders as an inline composer. Clicking a choice or submitting text calls `store.send(reply)` which continues the chat as the next user turn. (Loop-pause + `messages.in_reply_to` threading is a follow-up — today the agent's turn ends naturally and the user's reply starts the next turn.)

## Observation extraction (DUX9 + DUX10)

Default chat agents scan every user message for three classes of information worth absorbing silently. They write to memory via `recall(action: "note", ...)` with the right tag + importance + TTL for each class. Retrieval is automatic via `injectMemory`.

| Class | Tag(s) | Importance | TTL | Example trigger | Stored as |
|---|---|---:|---|---|---|
| Pinned preference | `["preference","pinned"]` | 0.95 | none | "from now on never commit without asking" | always-inject lane |
| Preference | `["preference"]` | 0.85 | none | "I prefer terse answers" | relevance-ranked |
| Profile fact (stated) | `["profile"]` | 0.7 | none | "I'm taking my car to the lake" → "user has a car" | relevance-ranked |
| Profile fact (inferred) | `["profile"]` | 0.5–0.6 | none | "let's go hiking again" → "user enjoys hiking" | relevance-ranked |
| Ephemeral context | `["ephemeral"]` | 0.4 | event date + 2 days | "visiting the lake on Saturday" | relevance-ranked, auto-swept |

### Worked example

User says: *"I'm taking my car to the lake on Saturday."*

The agent silently records three notes:

```
recall(action:"note", content:"user has a car", tags:["profile"], importance:0.7)
recall(action:"note", content:"user enjoys nature / outdoor activities", tags:["profile"], importance:0.55)
recall(action:"note", content:"user is visiting a lake on Saturday 2026-05-16",
       tags:["ephemeral"], importance:0.4, ttl_at:"2026-05-18T00:00:00Z")
```

A week later when the user asks *"should I drive to the office or take transit?"* — none of these are pinned, so they don't always inject, but **with embeddings on** (DUX5) the semantic recall surfaces "user has a car" because driving ↔ has-car is a tight cosine match. By then the ephemeral lake note has been swept by TTL.

### Discipline rules

- **Don't save** questions, hypotheticals, jokes, one-off task instructions, or anything already in memory. The agent may `recall(action:"query")` first if unsure.
- **When in doubt, lower importance.** Unused notes get reaped naturally — `sweepExpiredNotes` deletes any note with `importance < 0.8` past its `ttl_at`.
- **Pinned is precious.** Reserve 0.95 + "pinned" for rules that should apply on every turn regardless of topic. The injection budget caps pinned at ~4 notes / 200 tokens; over-pinning crowds it.

### How recall stays bounded

`buildMemoryBlock` (`packages/core/src/agent/memory-inject.ts`) injects in two tiers, both capped:

| Tier | Content | Budget (default) | Cap |
|---|---|---|---|
| `[Pinned preferences]` | notes tagged `pinned` OR `importance >= 0.95` | 200 tokens | 4 notes |
| `[Relevant memory]` | relevance-ranked via `recallQuery` (keyword + semantic if embeddings on) | remaining (~600 tokens) | 5 notes |

- Total per turn is capped at `memoryInjectBudgetTokens` (default 800) regardless of how many notes exist.
- Pinned budget is clamped to ≤ half of total so it can't crowd out relevance.
- A note that is both pinned and relevant only appears once (pinned slot wins).
- Pinned notes pull from the active project AND globally-scoped (`project_id IS NULL`) so global rules survive project switches.

### Surfacing in the UI

- Chat: `RecalledChip` above each assistant message shows `N pinned · M relevant`; expanding lists ids with a `PINNED` tag on the relevant ones.
- Memory page (`#/memory`): a "Pinned preferences" section renders pinned notes first with a 📌 badge. Each note has a Pin/Unpin toggle that goes through `PATCH /api/memory/notes/:id { pinned: true|false }` (which manages the tag + bumps importance to 0.95).

### Curation

- Manual: pin/unpin from the Memory page; agents can also `recall(action: "note", ...)` with the right tags.
- Automatic: low-importance preferences TTL out in 14 days (`sweepExpiredNotes` keeps `importance >= 0.8`).
- Future: a consolidation cron job could LLM-merge duplicate prefs into single rules.
