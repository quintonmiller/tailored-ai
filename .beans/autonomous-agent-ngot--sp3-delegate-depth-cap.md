---
# autonomous-agent-ngot
title: SP3 — delegate depth cap
status: in-progress
type: task
priority: normal
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T19:36:04Z
parent: autonomous-agent-17dl
---

# SP3 — delegate depth cap

Deferred — track here, do not start until supervisor + email-fetcher
are in regular use and we know whether nested delegations are common
enough to warrant guarding against fork-bomb cases.

## Why we want it eventually

Without a cap, `A → delegate(B) → delegate(A) → delegate(B) → …` is a
real failure mode for misconfigured agents. Cheap insurance: add a
small integer on the call chain and refuse beyond it.

Long-term direction (per epic resolved decisions) is *not* a hard cap.
It's queue + agent-side loop detection — agents notice in their session
history that they've already asked X about Y and skip the re-ask, the
way a human would. This bean is the stop-gap, not the destination.

## Implementation sketch

- Add `delegationDepth: number` to `ToolContext`. Default `0`.
- `DelegateTool.execute` reads the incoming depth, refuses if
  `>= MAX_DEPTH` (start at 3), passes `depth + 1` to the sub-agent's
  context via the loop's tool context construction path.
- Wire through `runAgentLoop` so it threads the depth onto each
  tool call's `ToolContext`. There's likely already a shape for this
  (sessionId, workingDirectory, agentName) — add one more field.
- Error message when the cap is hit should name the chain so it's
  debuggable.

## Acceptance

- A 4-level delegate chain (`supervisor → A → B → C → D`) refuses at
  level 3 with a clear error citing the chain.
- A 3-level chain succeeds.
- Sync + async (`async: true`) both honour the cap.
- Tests in `packages/core/src/__tests__/delegate-tool.test.ts` cover
  both branches.

## Out of scope

- Per-agent depth overrides — global cap is fine for v1.
- Loop detection — that's an agent-prompt concern, tracked under the
  epic's "Open items" rather than as code.
