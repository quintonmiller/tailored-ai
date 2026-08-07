---
"@tailored-ai/core": patch
---

Compaction's wording, length and memory checkpoint are the deployment's call.

The built-in summariser asked for a summary "concisely", of "key facts,
decisions, and pending tasks", with no length cap at all. Measured against a real
1,432-message companion history that produced **88 tokens**. The identical line
with "in detail" produced **475** — and not by padding: six times the named
specifics, and quoted phrasing where the short one quoted none. One word was
discarding most of the history.

The noun list was the second half of the problem. "Facts, decisions and pending
tasks" is a project-status framing sitting in core, which is why five days of a
companion's history came back formatted as `Participants:` / `Key Events:`. A
deployment knows what its conversations are for.

New in `compaction` config and `CompactOptions`:

- `prompt` — what the summariser is asked for. The built-in default no longer
  says "concisely" and no longer enumerates work nouns.
- `maxTokens` — passed through to the provider. Previously nothing was, so the
  length of every summary was accidental rather than chosen.
- `memory: { agent }` — before anything is hidden, ask the model what must
  survive and write each line as a note scoped to that agent.

The checkpoint is the more durable half. A summary is one block every later turn
carries regardless of relevance; a note is retrieved when it matches the
conversation, so the history that comes back is the history that applies. It runs
before the originals are hidden, and a checkpoint that fails is logged while
compaction continues — refusing to compact would leave the session growing, which
is the problem being solved.

`session.compacted` gains `notesWritten`.
