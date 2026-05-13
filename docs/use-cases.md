# TAI Use-Case Catalog

A comprehensive map of personal-operations use cases TAI is aimed at,
with status against the current implementation.

**Legend**
- ✅ **shipped** — workflow exists under `packages/cli/workflows/`
- 🟢 **just landed** — workflow shipped in this catalog pass
- 🟡 **buildable** — all primitives exist; needs a YAML that hasn't been written yet
- 🔴 **gap** — needs a new primitive (tool, trigger, or step type); tracked as a `ptask_*` bean

For 🟡 entries, a few hours of YAML is the only thing between you and shipping.

---

## Inbox & Communication

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 1 | Triage incoming email by category (newsletter / personal / bill / spam) | 🟢 | `email-triage.yaml` |
| 2 | Draft reply suggestions for common email patterns | 🟡 | needs YAML |
| 3 | Daily unread-inbox digest | 🟢 | `inbox-digest.yaml` |
| 4 | Important-email → Discord DM alert | 🟡 | needs YAML (use `email_message` trigger + condition + notify) |
| 5 | Auto-snooze low-priority email until weekend | 🟡 | needs YAML |

## Calendar & Scheduling

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 6 | Daily morning briefing (calendar + weather + news) | ✅ | `morning-briefing.yaml` |
| 7 | Meeting prep packet (attendees + recent emails + agenda) | ✅ | `meeting-prep.yaml` |
| 8 | Calendar conflict detection | 🟡 | needs YAML |
| 9 | Travel-time alert before a meeting in another location | 🟢 | `travel-time-alert.yaml` |
| 10 | Auto-block focus time on the calendar | 🟡 | needs YAML |

## Money & Bills

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 11 | Bill detection from email | ✅ | `bill-detector.yaml` |
| 12 | Receipt ingest (image / pdf → typed record) | ✅ | `receipt-ingest.yaml` (depends on PDF/OCR bean for full power) |
| 13 | Expense approval form + routing | ✅ | `expense-approval.yaml` |
| 14 | Monthly subscription audit (find recurring charges) | 🟢 | `subscription-audit.yaml` |
| 15 | Cancellation-reminder before a free-trial ends | 🟡 | needs YAML |
| 16 | Weekly spending summary | 🟡 | needs YAML |
| 17 | Stripe webhook relay | ✅ | `stripe-webhook-relay.yaml` |

## Documents & Paperwork

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 18 | PDF / image inbox → extract text → store as document | 🔴 | bean `ptask_2a5f439e` (PDF/OCR pipeline) |
| 19 | Statement archive (auto-file bank PDFs by month) | 🔴 | depends on #18 |
| 20 | Tax document collector (Q1–Q4 scoped) | 🔴 | depends on #18 |
| 21 | Document Q&A — ask "what's my warranty on X" | 🔴 | depends on #18 + embeddings (future bean) |
| 22 | Insurance / warranty expiry tracker | 🟡 | needs YAML once documents are indexed |

## News & Information

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 23 | Hacker News keyword watcher | ✅ | `hn-watcher.yaml` |
| 24 | RSS feed monitor (generic) | ✅ | trigger built; demo via `hn-watcher.yaml` |
| 25 | One-shot research brief on a topic | ✅ | `research-brief.yaml` |
| 26 | Weekly digest of personal activity | ✅ | `weekly-summary.yaml` |
| 27 | Weather morning alert (commute / outfit) | 🔴 | bean `ptask_a93a2ab5` (weather trigger) |
| 28 | Stock / crypto price-cross alerts | 🔴 | bean — new: needs a `finance_price` trigger or `http_request` cron |
| 29 | Daily news digest | ✅ | `abc.yaml` |

## Code & Development

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 30 | End-to-end agent coding pipeline (branch + agent + tests + merge) | ✅ | `coding-pipeline.yaml` |
| 31 | Dependency update PR (weekly) | 🟢 | `dependency-update.yaml` |
| 32 | Daily standup generator (recent commits + open tasks) | 🟢 | `daily-standup.yaml` |
| 33 | GitHub issue triage on webhook | 🟡 | needs YAML (use webhook trigger + agent_run) |
| 34 | Code review on push (lint + tests + agent comments) | 🟡 | needs YAML |
| 35 | Lint auto-fix PR | 🟡 | needs YAML |
| 36 | Release-notes generator | 🟡 | needs YAML |

## Tasks & Productivity

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 37 | Daily task summary (what changed) | 🟡 | needs YAML |
| 38 | Stale-task surfacer (weekly) | 🟢 | `stale-tasks.yaml` |
| 39 | Capture-to-task (webhook payload → new ptask with NLU) | 🟢 | `capture-to-task.yaml` |
| 40 | Pomodoro reminder | 🟡 | needs YAML (cron + notify) |
| 41 | Weekly review prompt + collected stats | ✅ | `weekly-summary.yaml` |

## Home & IoT

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 42 | Home Assistant event → workflow | 🔴 | bean `ptask_a93a2ab5` (sensor/HA trigger slice) |
| 43 | Door / motion alert when away | 🔴 | depends on #42 |
| 44 | Energy-usage digest | 🔴 | depends on #42 |

## Health

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 45 | Daily workout reminder | 🟡 | needs YAML (cron + notify) |
| 46 | Med-tracker with confirmation form | 🟡 | needs YAML (cron + form + notify) |
| 47 | Hydration ping | 🟡 | needs YAML |

## Travel

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 48 | Itinerary builder from a trip description | 🟡 | needs YAML |
| 49 | Boarding-pass tracker (email → calendar event) | 🟡 | needs YAML |
| 50 | Travel-time-to-airport alert | 🟡 | needs YAML (reuses `travel-time-alert.yaml` pattern) |

## Webhooks & Integrations

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 51 | Stripe events | ✅ | `stripe-webhook-relay.yaml` |
| 52 | GitHub webhook → workflow | 🟡 | needs YAML (use webhook trigger) |
| 53 | Slack-incoming → TAI bridge | 🟡 | needs YAML once Slack channel ships |
| 54 | IFTTT / Zapier inbound | 🟡 | needs YAML (use generic webhook trigger) |

## Meta — TAI managing TAI

| # | Use case | Status | Workflow / Bean |
|---|---|---|---|
| 55 | Agent creates/updates a workflow YAML | 🔴 | bean `ptask_1489015d` (workflow_admin tool) |
| 56 | Daily review of TAI's own activity + suggestions | 🟡 | needs YAML |
| 57 | Auto-clean stale workflow runs | 🟡 | needs YAML or scheduled tool_call |

---

## Bean Index (open gaps as of catalog write)

| Bean | Title | Unblocks use cases |
|---|---|---|
| `ptask_2a5f439e` | Document inbox + PDF/image extraction pipeline | 18, 19, 20, 21 |
| `ptask_a8fa3cc5` | Mobile / PWA capture surface | (cross-cutting — capture for many flows) |
| `ptask_a93a2ab5` | Trigger library expansion: weather, location, sensor | 27, 42, 43, 44 |
| `ptask_5e9a6aa6` | Hosted multi-user TAI service (epic) | platform expansion |
| `ptask_1489015d` | Agent tool: `workflow_admin` (CRUD on workflow YAML) | 55 + the entire "TAI evolves itself" pillar |
| _new — to be filed_ | Stock / finance price trigger | 28 |
| _new — to be filed_ | Home Assistant trigger | 42, 43, 44 (slice of `ptask_a93a2ab5`) |

## How to extend this catalog

Treat 🟡 entries as "you could ship this in an afternoon". 🔴 entries are
blocked on an unmerged primitive — if you find yourself wanting one, escalate
the corresponding bean.
