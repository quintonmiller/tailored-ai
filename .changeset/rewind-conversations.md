---
"@tailored-ai/core": patch
---

Add `/room rewind` — take a conversation back a few turns.

`/room reset` was the only way to undo anything, and it throws the whole
conversation away. That is right when a conversation is a total loss and wrong
every other time. Most conversations that go bad go bad at a point you can
name: one misread instruction compounded over six turns, one tool result that
poisons every later answer, two agents being polite at each other until the
turn cap stops them. What you want then is to drop the tail, not the history.

```
/room rewind agent:iris             # take back the last turn
/room rewind agent:iris turns:5     # take back five
/room rewind agent:iris turns:0     # put the last rewind back
```

Nothing is deleted. A rewound message keeps its row and gains a `rewound_at`
stamp; `getSessionMessages` skips stamped rows, so the model stops seeing them
while the transcript stays whole and the operation stays auditable. Deleting
would make "one turn too many" — the obvious mistake with a command like this
— unrecoverable.

Repeated rewinds compose, and each undo restores exactly one of them: rewinding
twice and undoing once lands one step back, not where you started. Because
history is re-read from the database every round, a rewind takes effect on the
agent's next turn with no restart.

The reply quotes the opening of the first message taken back. A rewind is
counted in turns and nobody remembers how many turns ago something was said, so
the count alone gives no way to tell a correct cut from an off-by-one. It also
reports session scope, for the reason `reset` learned to: an agent on a
`shared` scope has one conversation covering every room it is in, so "this
room" would be a quiet lie about the reach of the change.

The rewind number is a counter derived from the rows, not a timestamp. Undo has
to restore exactly one rewind, and two rewinds in the same millisecond share an
ISO string — which is not hypothetical: the timestamp version failed on the
first full test run, where two rewinds land in the same millisecond routinely.
Ordering that decides correctness should not depend on clock resolution.
