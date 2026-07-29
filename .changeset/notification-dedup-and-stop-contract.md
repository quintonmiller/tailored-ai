---
"@tailored-ai/core": patch
---

Stop the agent repeating itself, and stop misreading a budget cap as a stall.

**Repeat suppression for unsolicited messages.** New `NotificationGate` (core seam,
`notifications.dedup` config) gates every proactive send — cron deliveries,
owner-notifier events, and `notify_owner` fired from a background tick — against a
`notification_log` table. A message is suppressed when it matches something already
sent to the same recipient inside the window, either byte-for-byte, by a
caller-supplied key (`task:<id>:blocked`, which survives rewording), or by word-set
similarity for restatements of unchanged state. Because word-set overlap is
length-relative, three vetoes protect real news from the similarity tier: differing
numbers ("$312" → "$412"), differing polarity ("completed successfully" →
"unsuccessfully"), and any message adding more than `maxNewWords` new words (an
unchanged digest with one new line appended scores ~0.95, and that line is the point).

Anything the user asked for is never suppressed: chat replies bypass the gate
entirely, and a user-triggered run ("Run now", `POST /api/cron/:name/run`) delivers
unconditionally. Fails open — if the gate is unavailable, or its database is locked or
mid-migration, the message still goes out.

Replayed against a real deployment's 10 days of cron output, this delivers 13 messages
where 306 went out before.

**beforeRun hooks now fail closed.** `executeHooks` returns `failed`, and a hook that
throws, is missing, or returns `success: false` stops the remaining hooks instead of
being logged and swallowed. Cron then aborts the run; chat, delegate, and task-watcher
still run the agent, so a hook failure can never leave the user talking to a silent
assistant. Previously a dead Gmail token made the hook error every 30 minutes while the
prompt still said "Below are my recent emails" — so the model invented an inbox and
DM'd it. Opt out per hook with `onError: "continue"`.

**Structural loop-stop reporting.** `AgentLoopOptions.onStop` reports why a run ended
(`complete` / `sleep` / `aborted` / `max-rounds` / `repeated-calls`) instead of making
callers string-match `"[Agent stopped: ...]"`. The loop *returns* that string on abort
rather than throwing, so the exploratory worker's catch never ran and every
budget-capped tick was recorded as a stall — and wrote an identical self-feedback note
each time. Aborts are now classified as `budget` (or a no-op on shutdown), and stall
notes dedup into one counted note with a TTL and an importance below the sweep
keep-threshold, so self-feedback can expire instead of outliving real memory.

**Cron `NO_ACTION` is matched anchored**, not as a substring — a response merely
mentioning the token no longer silently suppresses a real summary.
