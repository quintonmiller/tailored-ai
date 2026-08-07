---
"@tailored-ai/core": patch
---

Compaction hides a conversation instead of deleting it.

`compactSession` ran `DELETE FROM messages` and wrote a model-authored summary
in the originals' place: no archive, no tombstone, no event. A summary that
dropped the one fact that mattered dropped it permanently, and there was nothing
to go back to. That shipped alongside `agent/rewind.ts`, which stamps
`rewound_batch` and filters on read specifically so a conversation survives
being wrong about it.

Compaction now uses the same mechanism. Rows keep their place and gain a
`compacted_batch` number, `getSessionMessages` skips them, and the summary row is
stamped with `compaction_summary_for` so undoing a compaction removes the summary
too rather than leaving one beside the conversation it summarised.

New: `undoCompaction(db, sessionId, batch?)` restores one compaction — the most
recent by default, so undoing twice walks back two steps — and
`listSessionCompactions(db, sessionId)` reports what is folded away. A
`session.compacted` event carries the session, the batch, and how many messages
were hidden, so a subscriber can archive, notify or audit.

Ordering is part of the contract and is tested: summarise first, hide second. A
provider that throws now leaves the session exactly as it was, rather than
hidden behind a summary that never arrived.

Two nullable columns are added to `messages` by a safe migration; existing rows
are untouched and nothing is retroactively hidden. Verified against a 262 MB
production database.

This is also the precondition for compacting automatically, which was not a
responsible thing to trigger on a threshold while it was irreversible.
