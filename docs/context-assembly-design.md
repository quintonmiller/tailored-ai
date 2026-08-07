# Redesigning the LLM invocation message

Status: **proposal, not accepted.** High-level structure first; per-section
architecture once the tiering is agreed.

Measurements come from a production deployment (29 agents, ~4,000 sessions,
~100,000 stored messages) on 2026-08-06. Agent and room names are replaced with
placeholders; the numbers are unmodified.

## Why now

Nobody owns the shape of a request. Six subsystems each append their own block —
`prompt.ts`, `context.ts`, `memory-inject.ts`, `chat-live-state.ts`,
`watcher.ts`, `load-skill.ts` — and no single place decides what a turn should
contain, in what order, or at what cost.

## Measured

| Thing | Measurement |
|---|---|
| Tool schemas | 42 tools, **~10,857 tokens** — **never counted against any budget** |
| Global context files | ~5,000 tokens, paid by every agent but one, every turn |
| Worst room session | 152 user messages, **48 distinct**, 150,689 tokens |
| Worst single block | one 1,115-token check-in prompt stored **23 times** |
| Largest session overall | 9,283 messages / ~772k tokens, read from SQLite in full every turn, then trimmed to 110k |
| `agent.maxHistoryTokens` | 110,000 in that deployment (code default: **2,000**) |

Split every room session by author:

| Role | Messages | Tokens | Distinct |
|---|---|---|---|
| `user` — prompts **we** generate | 589 | 350,687 | heavy repeat |
| `tool` — results | 1,857 | 338,358 | 858 → **54% exact repeats** |
| `assistant` — what the agent actually said | 2,005 | **40,059** | — |

**95% of what these agents read is material we handed them. 5% is their own
work.**

## The cause of the 72%

One bug, two call sites. `runCheckIn` (`watcher.ts:868`) and `runScheduledWake`
(`watcher.ts:920`) fetch with `fetchBacklog({ ...sub, cursor: null })`, take the
last 10 messages, render them into a prompt — which `runAgentLoop` persists via
`saveMessage` (`loop.ts:966`) — and **never advance the cursor**. An hour later,
same ten messages, same framing, new row.

Attributing the measured duplication in the worst-affected session:

| Path | Messages | Distinct | Tokens |
|---|---|---|---|
| check-in / scheduled (`cursor: null`) | 124 | **23** | 133,829 |
| message wake (cursor-correct) | 28 | 25 | 16,860 |

**89% of the volume is the cursor bug.** The message-wake path fetches from the
cursor and advances, and produces almost no exact repeats. An earlier draft of
this document blamed the architecture for that number; the measurement above
does not support it, and the cursor fix should not wait for any redesign.

What the architecture *does* explain is the residue, which is real but smaller:
on the cursor-correct path, **25% of prompt tokens are repeated framing** ("Room
`{ROOM}`. You are `{AGENT}`. Today is `{DATE}`. / Purpose: … / Reply as … /
Known participants: …"), re-paid on every wake and frozen into history
permanently. Plus:

| Where | The view | Written into the record as | Consequence |
|---|---|---|---|
| Skills | SKILL.md body | a tool result | load two skills → model sees both; the gate resets per turn, the text does not, so a body can sit in the prompt with **no skill active** |
| `read` | file contents | a tool result | read a file twice → two full copies, stale one first |
| Corrections | retry framing | a second `user` message | two persisted prompts for one turn |

And the mirror-image mistake: history is **trimmed oldest-first**, and unless
`summarizeOnTrim` is set (no default, so off) nothing marks the cut. The
mechanism to say so exists — `[Earlier conversation summary: …]` — it just isn't
the default.

## The organizing principle

Not a claim about the 72%. A rule for deciding **where a thing goes**:

> Every block is either a **record** — something that happened, immutable,
> append-only, already in history, never re-sent — or a **view** — a rendering
> of current state, where only the latest copy is correct, so it must be
> rendered fresh and **replace** rather than accumulate.

Honest edges, because the distinction is not clean:

- **Genuinely both.** A room transcript is a rendering of backend state *and*
  the only record of why the agent spoke. Resolution: keep a **terse record of
  what arrived** (who said what) and treat **the framing as a view**. That also
  answers the "monologue" objection below.
- **Welded together.** A `load_skill` result is a view (the body) bolted to a
  record (the agent chose to load it) — and it cannot simply be dropped, because
  `stripOrphanedToolMessages` exists precisely because `tool_call_id` pairing is
  mandatory. Replacing the *payload* while keeping the pairing is the move.
- **Neither.** Budget warnings and the "tools have been updated" notice are
  `history.push`ed but never saved — per-turn injections that are neither.
- **Stored ≠ sent.** `reasoning` is persisted and rendered by the API but never
  sent to a provider. The tier model needs two words here, not one.

## The tier model

| Tier | What | Changes | Placement | Lifecycle |
|---|---|---|---|---|
| **T0 — Identity** | base prompt, persona, tool schemas | on reload | head of system prompt | replace |
| **T1 — Standing knowledge** | context files, core memory, skill catalog | on edit | system prompt | replace |
| **T2 — The record** | history: turns, tool calls + results | append-only | middle | **append, never rewrite** |
| **T3 — Current state** | clock, room view, active skill body, in-flight, recalled memory | every turn | tail | **replace, exactly once** |
| **T4 — This turn's ask** | user message, or wake reason + note | every turn | last | replace |

Two rules: **a view never enters T2**, and **T0–T2 is the cacheable prefix while
T3–T4 sits deliberately outside it.**

The codebase already got the second rule partly right — `DEFAULT_TAIL_LAYERS`
moves `chat_live_state` and `recall_memory` behind the history for exactly this
reason, which is why the clock is not currently destroying the cache. This
finishes that idea rather than inventing it.

## An example invocation

Schematic, not exhaustive — `{PLACEHOLDERS}` mark what each slot holds.

```
────────────────────────────────────────────────────── wire: tools
  [{TOOL_SCHEMA}, {TOOL_SCHEMA}, …]         ← T0. own cache breakpoint,
                                              re-resolved every round

──────────────────────────────────────────── role: system   ← T0 + T1
  {BASE_PROMPT}                             T0  stable
  {AGENT_PERSONA_AND_INSTRUCTIONS}          T0  stable

  <context>{CONTEXT_FILES}</context>        T1  re-read per turn, ~always equal
  # Core memory
  {CORE_MEMORY}                             T1  changes only when written
  # Skills you can load
  {SKILL_CATALOG}                           T1  ids + one-line descriptions only
  {SLOT: refresh="reload"}                  T1  a plugin or config slot lands
                                                here — no placement declared

──────────────────────────────────── roles: user/assistant/tool   ← T2
  user:      {WHAT_ARRIVED}                 terse record: who said what
  assistant: {WHAT_THE_AGENT_SAID}
  assistant: tool_call {ID} {TOOL} {ARGS}
  tool:      {ID} → {RESULT}                payload may be superseded later;
                                            the ID pairing must survive
  …                                         append-only. never rewritten,
                                            so the prefix stays cacheable
                                            ← cache breakpoint: messages.len-2

──────────────────────────────────── role: user    ← T3, ONE block
  [System: current context, refreshed each turn]

  ## Now
  {TIMESTAMP}

  ## Rooms
  ### {ROOM_A} — {PURPOSE}
    {SEEN_MESSAGES}                         context, already acted on
    ——— new since your last turn ———        drawn from the stored cursor
    {NEW_MESSAGES}
  ### {ROOM_B}
    (nothing new)                           absence stated, not inferred

  ## Active skill
  {SKILL_BODY}                              replaced on next load,
                                            removed on deactivate

  ## In flight
  {IN_PROGRESS_WORK}

  ## Recalled memory
  {MEMORY_HITS}                             query built from {NEW_MESSAGES},
                                            not from this rendered prompt

  ## {SLOT_TITLE}
  {SLOT: refresh="turn"}                    same block, replaced every turn,
                                            truncated at its declared budget

──────────────────────────────────── role: user    ← T4
  {WAKE_REASON_OR_USER_MESSAGE}
  {AGENT_NOTE_IF_SELF_SCHEDULED}
```

Reading it top to bottom: everything above the T2/T3 line is either stable or
append-only, so it is one long cacheable prefix. Everything below is rebuilt
every turn on purpose. T3 and T4 are adjacent `user` messages and providers that
merge same-role messages will fuse them — which is fine, and is why T3 must stay
a single block rather than several separately-placed slots.

Contrast the same turn today, where the room view is written *into* T2:

```
  system:    {BASE} {PERSONA} {CONTEXT} {CORE_MEMORY} {SKILL_CATALOG}
  user:      Room {ROOM}. You are {AGENT}. Today is {DATE}.   ← framing
             Purpose: {PURPOSE}
             Recent conversation: {LAST_10}                   ← a view, frozen
  assistant: {REPLY}
  user:      Room {ROOM}. You are {AGENT}. Today is {DATE}.   ← byte-identical
             Purpose: {PURPOSE}
             Recent conversation: {SAME_LAST_10}
  assistant: {REPLY}
             … ×23 …
  user:      [System: current context…] {CLOCK} {MEMORY}
```

The model receives 23 renderings of one moment and cannot tell they are not 23
events. The framing is re-paid each time and never becomes stale-able, because
nothing in T2 is ever rewritten.

### The constraint that limits T3's shape

`applyHistoryCacheBreakpoint` in the Anthropic provider targets
`messages.length - 2`, which **assumes exactly one volatile trailing message.**
So T3 cannot ship as several separately-placed slots without moving the
breakpoint into the volatile region — buying a 1.25× cache *write* every turn
that nothing ever reads. Tools are a separate wire field with their own
breakpoint ahead of the system prompt, and are re-resolved per round, so T0 is
in one sense more volatile *within* a turn than T2 is.

### What the tiers cost today, on one real agent

A 13-tool assistant agent in that deployment:

| Tier | Block | Tokens | Counted? |
|---|---|---|---|
| T0 | base + persona | ~970 | yes |
| T0 | **tool schemas (13)** | **3,852** | **no** |
| T1 | global context files | ~5,000 | yes |
| T2 | session history | ≤ ~103,000 | this *is* the budget |
| T3 | live state + recall | ~950 | yes (tail) |
| T4 | the check-in prompt | ~1,100 | lands in history |

Fixed overhead before a word of conversation: **~9,800 tokens** (13 tools),
**~16,800** (42 tools). The loop computes `historyBudget = maxHistoryTokens -
systemPromptTokens - tailTokens` and sends tool schemas on top uncounted — ~10%
overshoot for a 42-tool agent. Nothing overflows on a 200k window; it is a cost
and fallback-rung problem, since each rung re-fits using the same wrong
arithmetic against a tighter ceiling.

## How plugins and users contribute

A plugin author who wants to add three lines of context should not have to learn
any of the above. Today they do, and the seam actively punishes them.

### What is wrong with the current seam

`SystemPromptOverride` already supports custom layers — `custom: [{name,
content, file}]` — but placement works against the author:

```ts
const order = override?.order ?? DEFAULT_LAYER_ORDER;   // built-ins only
```

A custom layer renders **only if it appears in `order`**, and `order` means
"names not listed are omitted." So adding one layer means writing out all seven
built-in names in the correct order, plus yours. Get the list wrong and you
silently delete a built-in. And because `resolveTailLayers` returns `[]` when
`order` is set without `tail`, the act of adding your layer **also silently
drags the volatile layers into the system prompt or drops the clock entirely.**

The cost of adding three lines is understanding the whole architecture, and the
penalty for not understanding it is invisible.

### The fix: declare behaviour, not placement

A contributor answers **one question — does this change between turns?** — and
core derives everything else.

```ts
registerContextSlot({
  id: "on-call",
  refresh: "turn",          // "reload" → T1, in the system prompt (cacheable)
                            // "turn"   → T3, in the tail (outside the cache)
  budgetTokens: 200,        // core truncates and says so; no guessing
  agents: ["*"],            // same shape as tool allowlists
  render(ctx) {             // return null to render nothing this turn
    return `${WHO_IS_ON_CALL}`;
  },
});
```

And for a user, in config, with no code:

```yaml
prompt:
  slots:
    - id: house-rules
      refresh: reload       # → T1
      file: ~/house-rules.md
    - id: standup
      refresh: turn         # → T3
      budgetTokens: 150
```

Nobody types "T1" or "T3". Nobody names the built-in layers. Nobody thinks about
cache breakpoints. `order`/`tail` survive as the power tool for a deployment
that genuinely wants to restructure the prompt, but **the common case becomes
additive** — registering a slot never requires enumerating existing ones.

### What core owns, so contributors don't

| Concern | Who decides |
|---|---|
| Which tier | derived from `refresh` |
| Where in the request | core |
| Order among slots | core (declared `priority`, stable tie-break) |
| Staying inside the budget | core truncates at `budgetTokens`, and **says** it truncated |
| Keeping T3 one contiguous block | core — contributors cannot place anything |
| A slot that throws or hangs | core omits it, warns once, turn proceeds |

That last row matters: `buildChatLiveState` already degrades section-by-section
in a `try/catch` and returns what it has. That behaviour should be the
framework's, not re-implemented per contributor.

### Adding is not the same act as replacing

A slot cannot append to the record. That is not a restriction on what plugins may
do — it is a statement about which *verb* `registerContextSlot` is.

The instinct "I want to add some information for the agent to see" is a request
for a **view**, and every duplication bug in this document came from that
instinct being served by a write into the append-only record. So the additive
path — the one a contributor reaches for without reading this document — hands
back a slot that renders fresh and replaces itself.

A plugin that believes it can compose the record *better* is doing something
else entirely, and gets a different, deliberate seam.

### Replacing a stage: composers

Anything core decides, a plugin can take over. Three levels, escalating in scope
and in how deliberate the declaration is:

| Verb | Registry | Scope |
|---|---|---|
| **add** | `registerContextSlot` | one block, core places it |
| **replace a stage** | `registerHistoryComposer` and peers | one tier's whole strategy |
| **replace everything** | `registerPromptAssembler` | the entire request |

```ts
registerHistoryComposer({
  id: "{COMPOSER_ID}",
  compose(ctx): Message[] {
    // ctx gives everything needed to decide, so the composer never
    // has to re-derive it:
    //   ctx.stored        full persisted history
    //   ctx.budgetTokens  what is left after T0/T1/T3/T4 and tool schemas
    //   ctx.tiers         rendered tiers + their token costs
    //   ctx.model         window, and whether this is a fallback rung
    return {YOUR_MESSAGE_ARRAY};
  },
});
```

Selected the same way every other backend in this codebase is — an open string
id and an opaque options bag, so a third-party composer is configured exactly
like the built-in one:

```yaml
agent:
  historyComposer: {COMPOSER_ID}
  historyComposerOptions: { {ANYTHING_THE_COMPOSER_DEFINES} }
```

The built-in trim-and-optionally-summarise behaviour becomes `id: "default"`,
registered through this same registry with no privileges a plugin lacks. Core
must not hold a hardcoded list of known composer ids.

A composer owns **policy**: what to keep, what to drop, what to summarise,
whether to dedup, how to order, whether to rewrite at all. Core keeps only the
handful of **protocol** invariants that exist because the wire requires them,
not because of taste:

- tool-call / tool-result pairing survives — providers reject orphans outright
- at least one `user` message is present
- the result fits the budget; if it does not, core re-trims and warns loudly
  naming the composer, rather than failing the turn

Everything else is the composer's call, including being wrong. A composer that
produces worse context than the default is a composer the operator can switch
away from, which is the point.

The same shape applies to the other tiers — a deployment that wants a different
standing-knowledge strategy or a different room view registers there instead of
patching core.

### Making it configurable means making it visible

None of this is usable while the assembled request is invisible. A `tai prompt
inspect --agent {AGENT}` that prints the request by tier, with per-slot token
counts and what got truncated, is part of the seam rather than a nicety —
otherwise a user tuning `budgetTokens` is editing blind, which is how
`context.warnTokens` ended up configured above the size it was meant to catch.

## The six questions, answered

**1. Rooms: N most recent per room, or across all rooms?**
**Per-room floor plus a shared token budget**, applied to *both* wake paths.
Batched wakes already do roughly this (5/room, 1,200 tokens) but as module
constants; the single-room path uses a flat count (`maxBacklog: 30`) with no
token budget at all. A per-room floor stops a busy room starving the quiet room
where the agent is actually needed; a shared budget stops N rooms multiplying the
bill. Subscribed rooms with nothing new should render one "nothing new" line —
absence should be legible, not inferred.

**2. Update in place, or concatenate?**
In place. The skill case is clearest: loading skill B leaves skill A's full body
in history, and because `ActiveSkillState` is rebuilt per turn while history is
not, a body routinely sits in the prompt with no skill active. Move the body to
T3 so the second load replaces the first and deactivation actually removes the
text. Same for repeated `read`s. Never show both: two versions of one thing is
worse than either alone, because the model must guess which is current with
nothing to guess from.

**3. Auto-compaction with the agent committing to memory first?**
Yes — **but not until compaction is reversible.** `compactSession` runs a hard
`DELETE FROM messages`; it writes a `[Conversation Summary]`, but keeps no
archive of the originals, no tombstone, no event. `rewind` already does the
opposite here: stamps `rewound_batch`, filters on read, stays undoable.
Compaction should adopt that first. Automating a destructive irreversible
operation is the wrong order of work. Then: at ~80% of budget, run a checkpoint
turn where the agent still holds its memory tools and is asked what must
survive.

**4. What auto-loads vs. what the agent fetches?**
Split on **cost-to-carry vs. cost-of-a-miss**. Auto-load what is small, always
relevant, expensive to miss: identity, standing preferences, the clock, what is
in flight, what is new. Require a call for what is large, sometimes relevant,
cheap to retrieve: documents, KB, skill bodies, room scrollback.

Inverted today in two places:
- Context files are **uncapped**. A per-agent `skipGlobalContext` exists and
  works, but one agent in the deployment uses it, so every other agent pays
  ~5,000 tokens a turn — including agents whose job has nothing to do with the
  research notes sitting in the global context directory. The only guard is a
  warning at `context.warnTokens`, configured above the actual size, **so it
  never fires.** An opt-out that one agent in twenty-nine uses is a default
  pointing the wrong way.
- Notes, facts and pinned preferences are **not agent-scoped**. `notes` has an
  `agent` column the injection path never filters on; `facts` has none at all.
  Any agent with `injectMemory` reads every other agent's notes and narrates
  them as its own.

**5. Embeddings for automatic retrieval?**
Already wired, but the relevance tier's query is the **raw incoming message** —
for a room wake, a generated prompt that is mostly framing. We are embedding our
own boilerplate. Build the query from the salient part: the new messages, the
agent's own note. Keep the silent keyword fallback. (The pinned tier issues no
query, so it is unaffected.)

**6. How is new information indicated?**
It isn't. `room_subscriptions.cursor` already knows the boundary and is unused
for this. Render a `——— new since your last turn ———` divider. One header is
also actively dishonest: the busy-room fallback re-fetches the newest page
ignoring the cursor and still labels it "New messages:".

## What this would break

Taken from an adversarial design review; these are the real costs.

1. **Room sessions become monologues.** Persisting the rendered prompt is
   currently the *only* way inbound room speech enters the record. Remove it
   naively and the session holds replies with no stimuli — which breaks
   `summarizeSession`/`sweepIdleSessions` (they mint memory notes, and would
   mint them from one-sided transcripts), the session-summarizer that feeds core
   memory, `/api/sessions/:id/messages`, the UI, and Discord `/context` counts.
   **Mitigation:** keep a terse record of what arrived; drop only the framing.
2. **`rewind` inverts.** It currently moves the cursor *because* the record is
   frozen. Make the transcript a view and the cursor becomes the only lever —
   and `/room rewind` deliberately moves one room's cursor under `shared` scope.
3. **Cursor accounting loses its anchor.** "Shown is read" is decided at
   prompt-build time by a wake. A tail view re-rendered on every turn — including
   a chat turn in the same shared session — either advances cursors on non-wakes
   or re-shows seen messages, with the failure now invisible because it never
   lands in the record.
4. **`shared` scope loses cross-room recall.** A view is bounded; older
   exchanges become reachable only through a tool the model won't call, because
   it won't know it forgot.

## Missing from all of this: provenance

The six questions and my first draft both ignored it. `renderTranscriptLine`
emits `speaker: body` with no kind marker, even though `IdentityResolver`
already knows whether a speaker is the owner, an agent or a stranger, and
already uses that to decide wake and pause policy. The distinction is available
and is discarded at render time.

Authorship may be a more load-bearing axis than volatility. Volatility decides
placement and cache; authorship decides trust. The tier model handles the first
and is silent on the second, which means a composer or slot author has nothing
to key a trust decision on even if they want one. Carrying speaker kind into the
rendered transcript is the prerequisite for any of that.

Specifics are tracked separately rather than here.

## Sequencing

Reordered after review. Each step ships alone.

1. **Fix `resolveTailLayers` returning `[]` when `order` is set without `tail`.**
   One function. Today that config silently either drags the clock into the
   system prompt (cache dead every turn) or drops the clock entirely.
2. **Fix the two `cursor: null` call sites.** One file, one subsystem,
   **~89% of the measured duplication**, independently measurable. This is the
   whole win and it needs none of the rest of this document.
3. **Make compaction reversible** (tombstone, as `rewind` does). Independent,
   and a precondition for anything automatic.
4. **Legibility** — new/seen divider, honest headers, a marker when history was
   dropped. Cheap, local, mostly strings.
5. **Instrumentation** — widen `ChatResponse.usage` with **optional** cache
   read/write fields, populated by providers that know. Today Anthropic sums
   cache reads into `input`, so a perfect hit and a cold read record identically
   and no layout change can be measured.
6. **The slot registry** — the additive seam, so contributing a block stops
   requiring knowledge of the whole prompt.
7. **The composer registry** — lift the built-in history strategy out into
   `id: "default"` behind `registerHistoryComposer`, so replacing it is a
   config line rather than a fork. Worth doing early in spirit and late in
   order: the interface is only honest once steps 1–5 have established what a
   composer actually needs to be handed.
8. **Then, and only then, the tier restructuring itself.**

**Tier-1 hazard, flagged by the review and accepted:** do *not* build a core
assembler that knows about rooms, skills and memory. That is a single-deployment
opinion in the most sacred package. The seam already exists — layers plus
`order`/`tail`. Extend it into the registries described in **How plugins and
users contribute**, and let core own allocation, ordering and the wire
invariants while knowing nothing about who fills the slots or which composer is
selected.

Note that step 1 is a prerequisite for that section, not just a cache fix: the
`order`-without-`tail` behaviour is what makes the current seam unsafe to use
additively.

## Still open

- Whether room scrollback becomes `room(action="history")` — it should, if the
  transcript stops being frozen.
- Per-agent `maxHistoryTokens` (global-only today).
- `capToolOutput` caps at write time and never re-caps on fallback to a smaller
  rung — it only drops whole messages.
- `estimateTokens` excludes `reasoning`, so the DB grows unmeasured.
- `Message.content` is `string | null`; a string-rendering assembler in core
  forecloses multimodal.
