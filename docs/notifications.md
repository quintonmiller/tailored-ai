# Notifications — repeat suppression

The agent speaks for two different reasons, and only one of them is a problem
when it repeats.

- **You asked.** A chat reply, a direct answer, a tool result. Ask the same
  question ten times and you should get ten answers. These never touch the gate.
- **It decided.** A cron summary, a blocked-task nudge, a digest, `notify_owner`
  from a background tick, an autopilot run or a woken turn (a subscription, or a
  turn a plugin started with `runtime.wakeAgent`). Nobody asked for these at the
  moment they fire, so a repeat is pure noise.

`NotificationGate` (`packages/core/src/notifications/dedup.ts`) sits in front of
the second kind only. It also tells the runtime's event bus about each of those
messages, so a plugin or a config hook can count them, log them, or hold one
back. See [What the gate tells the bus](#what-the-gate-tells-the-bus).

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
  `POST /api/cron/:name/run` — bypasses it. That run isn't recorded, so the
  repeat window doesn't move, and it isn't announced on the bus.
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

## What the gate tells the bus

The gate built by the runtime announces every message that reaches it on the
runtime's event bus, as two events:

- **`notification.outgoing`** is a waterfall. It runs before the repeat check,
  so it sees every message, repeats included. A subscriber that sets `deny`
  holds the message back: nothing is sent, and the gate logs it the way it logs
  a repeat, with the reason in place of the verdict.

  ```text
  [notify] suppressed cron:weather -> 1234 (The owner muted this kind of message.)
  ```

  If an agent's `notify_owner` call or room post is held back, the agent gets
  the reason as the tool's answer, so write the reason for the agent and say
  what to do instead. A held-back message isn't written to `notification_log`.
  A held room post also keeps that turn's closing reply out of the room: the
  watcher posts that reply through no gate, so it would otherwise undo the
  hold, often with the same message in other words.

- **`notification.sent`** is a broadcast. It fires after the transport has
  taken the message. It never fires for a repeat, a held-back message, or a
  send that threw, so counting these counts messages that actually went out.

Both carry the same fields:

| field | |
|---|---|
| `source` | the stream the gate counts repeats within, such as `cron:weather` or `room:planner` |
| `kind` | what sort of message it is ([below](#what-a-kind-is)) |
| `agent` | the agent sending it, when an agent is |
| `channel` | the outbound channel's id, or a room's backend |
| `target` | a user id for a DM, a channel or room id for a post |
| `preview` | the first 200 characters |

`notification.sent` adds two more:

- `logId` is the `notification_log` row the send was recorded on. Later sends
  of the same fact to the same place share it. It's missing if the log couldn't
  be written.
- `at` is when the message went out, in SQLite's `datetime('now')` form (UTC).

Both events name an agent, so a hook declared under `agents.<name>` fires for
that agent's messages only.

The events fail open, like the rest of the gate. A plugin listener that throws
is skipped, and so is a bus that throws, and the message still goes out. A
config hook can fail closed instead ([below](#holding-a-kind-back)). A gate
built without a bus works exactly as it did before these events existed, and
so does `PASSTHROUGH_GATE`.

The gate waits for `notification.outgoing` to finish before it sends, as core
waits for any waterfall. A slow subscriber delays the message, and one that
never returns holds it up.

A message a `notification.outgoing` subscriber sends while it runs, such as a
copy to an audit room, isn't run through `notification.outgoing` again. It still
goes through the repeat check and is announced on `notification.sent`. Without
that, the copy would run the subscriber again, and that copy would too, before
anything was sent.

### What a kind is

A kind is coarse on purpose. There's one per sort of message, not one per
fact, so a kind is something you'd mute ("stop sending me upkeep nudges") or
count per week. The dedup `key` is still the fine-grained identity of the fact.

| sender | kind |
|---|---|
| a cron job's delivery | `cron:<job name>` |
| a blocked or failed task (`task.needs_human`) | `task-blocked` |
| a digest (`digest.ready`) | `digest` |
| an `ask_user` question (`question.asked`) | `question` |
| `notify_owner` in a woken turn | `notify:<what woke it>`, such as `notify:upkeep` or `notify:subscription` |
| `notify_owner` in an autopilot or exploratory run | `notify` |
| a post through the `room` tool | `room` |
| a `builtin:error-room` report | `error-room` |

A sender that doesn't name a kind gets its `source` with the agent's name taken
off the end, so `room:planner` from `planner` is the kind `room`.

Every post an agent makes with the `room` tool passes the gate, including an
answer to someone in the room, so the kind `room` covers both. Some messages
don't pass the gate, so they never show up on the bus: a cron run you started
yourself, a workflow `channel_message` step's message to the owner, and the
reply the room watcher posts for an agent at the end of its turn.

### Holding a kind back

A plugin mutes a kind by refusing it on the waterfall:

```ts
const muted = new Set(["cron:weather"]);

const plugin: Plugin = (ctx) => {
  const sub = ctx.events.onWaterfall("notification.outgoing", async (msg, next) =>
    muted.has(msg.kind) ? { ...msg, deny: "The owner muted this kind of message." } : next(msg),
  );
  return () => sub.dispose();
};
```

A config hook can refuse too, and any hook that refuses on
`notification.outgoing` holds the message back. A `script` hook refuses
whenever it exits non-zero or times out (after 120 seconds by default), with its
stderr as the reason, and `onError: continue` doesn't change that. `onError`
only covers a handler that throws, such as a `tool` hook whose tool fails, which
refuses unless the hook says `onError: continue`. A `script` hook whose command
can't be started at all is skipped, and the message goes out.

So put a hook that only watches on `notification.sent`, a broadcast that can't
hold anything back. A watching script on `notification.outgoing` holds back
every message the moment it breaks.

### Logging every unprompted message

`hooks.on` reaches both events. With `hooks.allowScripts: true`, a `script` hook
gets the payload as `TAI_*` environment variables:

```yaml
hooks:
  allowScripts: true
  on:
    notification.sent:
      - type: script
        options:
          command: ./hooks/log-notification.sh
```

```sh
#!/bin/sh
# ./hooks/log-notification.sh
echo "$TAI_AT $TAI_KIND ${TAI_AGENT:-} -> $TAI_TARGET: $TAI_PREVIEW" >> notifications.log
```

Be careful with a hook or subscription on `notification.sent` that sends a
message itself. If that message passes the gate, it's announced too, and the
hook fires again.

## Adding a proactive sender

Route it through the gate and give it a stable `source`, a `kind`, and the
`agent` sending it if there is one. Use `resolveGate` so a host that wired no
gate still delivers:

```ts
import { resolveGate } from "@tailored-ai/core";

await resolveGate(() => runtime.getNotificationGate?.()).deliver(
  { source: "my-plugin:alert", kind: "my-plugin:alert", channel: out.id, target: ownerId,
    content: message, key: `alert:${alertId}` },
  () => out.sendDM(ownerId, message),
  (msg) => console.log(msg),
);
```

If your sender is answering something the user just asked for, don't use the
gate at all.
