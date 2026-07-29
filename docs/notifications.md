# Notifications — repeat suppression

The agent speaks for two different reasons, and only one of them is a problem
when it repeats.

- **You asked.** A chat reply, a direct answer, a tool result. Ask the same
  question ten times and you should get ten answers. These never touch the gate.
- **It decided.** A cron summary, a blocked-task nudge, a digest, `notify_owner`
  from a background tick. Nobody asked for these at the moment they fire, so a
  repeat is pure noise.

`NotificationGate` (`packages/core/src/notifications/dedup.ts`) sits in front of
the second kind only.

## Why it exists

A deployment with a dead Gmail token sent 320 DMs in 10 days with only 41
distinct bodies — one repeated 113 times. Nothing in core asked "have I already
said this?", so the same hallucinated summary went out every 30 minutes for a
month. Replaying those messages through the gate delivers 13 instead of 306.

## What counts as "already said"

Checked in order, scoped to `(source, channel, recipient)` inside a rolling
window:

1. **Caller key** — `key: "task:ptask_9:blocked"`. Preferred whenever the caller
   knows the identity of the underlying fact, because it keeps matching however
   the model rewords the sentence.
2. **Exact body** after normalizing case, whitespace, and markdown emphasis.
3. **Similarity** — word-set (Jaccard) overlap above `similarityThreshold`.
   A model asked to summarize unchanged state rarely emits identical bytes; it
   rephrases. Exact matching alone catches almost none of it.

Word-set overlap is length-relative — in a 40-word message, swapping a single
word still scores about 0.95 — so four guards keep the similarity tier from
eating real news. Any one of them means "deliver":

- **Numbers veto.** If the numbers differ, the messages are never matched. A
  price, a count, a listing id, or a date changing is usually the entire point.
- **Polarity veto.** If words like `failed` / `successfully` / `not` / `blocked`
  / `open` / `closed` differ, they are never matched. "The backup completed
  successfully" and "…completed unsuccessfully" are 0.95 similar and opposite.
- **New-information veto.** The candidate may contain at most `maxNewWords`
  words the previous message lacked. Jaccard is symmetric, so an unchanged
  digest with one new line appended still scores high — and that line is the
  news.
- **Short messages are exact-only.** Below `minWordsForSimilarity`, set overlap
  is too coarse to trust.

## Configuration

```yaml
notifications:
  dedup:
    enabled: true              # default true
    windowHours: 24            # after this, the same message is news again
    similarityThreshold: 0.92  # 1 disables the similarity tier (exact only)
    minWordsForSimilarity: 12  # shorter messages are compared exactly
    maxNewWords: 3             # more new words than this and it's news
```

## Behavior notes

- **Anything you asked for is never suppressed.** Chat replies don't touch the
  gate at all, and a run you triggered yourself — the UI's "Run now",
  `POST /api/cron/:name/run` — bypasses it while still recording the send.
- **Fails open.** If the gate is missing, or its database is locked or
  mid-migration, the message still goes out. A duplicate is an annoyance; a
  dropped notification is a missed thing you needed to know.
- **A send that throws is not recorded**, so a transport failure doesn't
  suppress the retry.
- Suppressed repeats bump `suppressed_count` on the existing `notification_log`
  row rather than inserting, so the table stays small and readable:

  ```sql
  SELECT source, sent_count, suppressed_count, preview FROM notification_log
  ORDER BY suppressed_count DESC LIMIT 20;
  ```

## Adding a proactive sender

Route it through the gate and give it a stable `source`. Use `resolveGate` so a
host that wired no gate still delivers:

```ts
import { resolveGate } from "@tailored-ai/core";

await resolveGate(() => runtime.getNotificationGate?.()).deliver(
  { source: "my-plugin:alert", channel: out.id, target: ownerId, content: message,
    key: `alert:${alertId}` },
  () => out.sendDM(ownerId, message),
  (msg) => console.log(msg),
);
```

If your sender is answering something the user just asked for, don't use the
gate at all.
