---
# autonomous-agent-q4r2
title: HO2 — vLLM 400 "No user query found in messages"
status: backlog
type: bug
priority: high
created_at: 2026-05-19T04:27:37Z
updated_at: 2026-05-19T04:27:37Z
---

# HO2 — vLLM 400 "No user query found in messages"

`xrun_406135fc` (2026-05-19 02:59) failed with:

```
vLLM API error 400: {"error":{"message":"No user query found in messages.","type":...}}
```

It happened after the supervisor read two large files in a single
assistant turn (`packages/core/src/agent/loop.ts` ~26KB and
`packages/core/src/exploratory/worker.ts` ~20KB), so the next
turn's prompt grew sharply. Hypothesis: `compactHistory()` trimmed
the seed `user` message but kept the orphan tool responses, so
qwen3's chat template ended up rendering an assistant/tool-led
conversation with no leading user role — vLLM rejects that.

## Repro

1. Start a session with a normal user query.
2. Have the agent make two `read` calls in one assistant turn that
   each return >15KB.
3. Trigger one more round; observe the 400.

(In practice: tail the latest message dump from session
`9f9afced-2aa9-4eed-92d8-e1b97a712636` — that's the exact session
that hit this.)

## Fix direction

Inside `packages/core/src/agent/loop.ts` `compactHistory()` (or
wherever the trim happens):

- Before sending to the provider, sanity-check that the trimmed
  prompt's first non-system message has `role: "user"`. If not,
  either:
  - re-include the original seed `user` message (preferred — keep
    its content but truncate to a short header like
    `"[original task: ...]"` so it always survives), or
  - synthesise a minimal pinned `user` message that summarises the
    tick goal.
- Add a unit test in `loop.ts`' tests with a fixture where the
  natural trim would drop the user message; assert that the post-
  trim history still leads with `user`.

## Acceptance

- Replaying the same condition (two large tool results pushing the
  budget over limit) no longer produces a 400 — instead the user
  message is preserved (possibly truncated) at the head of the
  prompt.
- Test fixture lives in `packages/core/src/__tests__/loop-compaction.test.ts`
  (or wherever compaction tests live).
- No regression on normal compaction behaviour (other tests pass).

## Out of scope

- Other vLLM template failures unrelated to user-message dropout.
- Tuning the tool-result size cap — that's a separate optimisation;
  this bean just guarantees the prompt is well-formed regardless.
