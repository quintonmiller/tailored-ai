---
"@tailored-ai/core": patch
---

A tool call can be followed, and an approval leaves a record.

Two gaps from comparing TAI's hook surface to Claude Code's (#573). Both are
additive — no behaviour changes, only things that were happening invisibly
become visible.

**`toolUseId` and `cwd` on the tool events.** `agent.pre_tool_use` and
`agent.post_tool_use` carried a tool name and nothing tying them together, so
two `exec` calls in one turn were indistinguishable to a subscriber and the most
natural question there is — did the call I approved do what it said it would? —
could not be asked. Both now carry the provider's own call id, and the approval
events carry the same one. `cwd` comes along at the same site, because a hook
otherwise has to guess where the call runs.

**The approval path emits.** `requestApprovalWithTimeout` used to run start to
finish without the bus hearing anything, so a deployment could not log its own
approvals, notice an agent hitting the same one repeatedly, or see that it was
blocked on one nobody had answered. Two broadcasts now bracket it:
`approval.requested` before the approver is asked, and `approval.settled` after.

`settled` fires for every call that needed approval, and its `outcome` has three
values rather than two. `unattended` means the call needed a person on a path
that has none — cron, a room wake, the task watcher — and whether it then ran is
`permissions.noHandlerAction`, whose effect was previously visible only as a
one-time warning in a log rather than per call. A record covering only the
approvals somebody answered would have been silent about exactly the calls
nobody saw, which is the audit half of #545.

`timedOut` is carried separately from the outcome for the same reason: with
`timeoutAction: auto_approve`, a call nobody looked at returns `approved` and
reads exactly like a considered yes. Recovering that from the reason string
would be parsing our own prose, so `requestApprovalWithTimeout` now returns the
fact alongside the response.
