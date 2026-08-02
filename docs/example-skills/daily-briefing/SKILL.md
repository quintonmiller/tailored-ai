---
name: daily-briefing
description: Generates a morning briefing combining unread emails, upcoming calendar events, in_review tasks, and overnight recall notes. Use when the user says "what's on for today", "morning briefing", or at the top of a workday session.
version: 0.1.0
allowed-tools:
  - email_check
  - google_calendar
  - tasks
  - memory
---

# Daily briefing

When activated, produce a concise morning briefing. Walk these four sources in order and stop as soon as you have enough material for ~10 lines of output. Do not turn this into deep research — the goal is a one-screen overview, not a report.

## Sources

1. **Recent email** — call `email_check` with `mode: "unread"` and `limit: 10`. Mention the top 1-3 by sender + subject. Flag anything that looks like it needs a human reply.

2. **Today's calendar** — call `google_calendar` with `action: "list_events"` and the day's window. Show events in chronological order with start time and title. Note conflicts if any.

3. **Tasks at the user** — call `tasks` with `action: "list"` and filter for `status: "in_review"` AND `assignee: "Alex"`. These are PRs / decisions waiting on the human. If >5, mention the count and the 3 oldest.

4. **Overnight memory** — call `memory` with `action: "search"` and a recency-biased query for the last ~12 hours. Surface anything tagged `for-user`, `cleanup`, or marked urgent.

## Output format

```
Good morning. Today:
- Calendar: <N events> — first at <time>, <title>
- Email: <N unread> — top: <sender>/<subject>
- Awaiting you: <N tasks> in review — oldest is <task_id> (<title>)
- Notes from overnight: <one-line summary, or "nothing flagged">

Suggested first move: <one sentence>
```

## When NOT to fire

- After 11am local time — call this "afternoon briefing" or just skip the time-of-day framing.
- If the user is mid-conversation about an unrelated topic, do not interrupt with a briefing.
- If the user already opened the session with a specific question, answer that question; the briefing can come later.

## Cost guardrails

- Use at most 4 tool calls total. If any source returns nothing, omit that line — don't drill deeper.
- Don't recall more than once. Don't re-query email.
- If a tool errors, mention it in one short clause and move on. No retries.
