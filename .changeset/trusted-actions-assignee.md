---
"@tailored-ai/trusted-actions": patch
---

Stop hardcoding an assignee when approving a capability task

Approving a capability from the PWA set `assignee` to a fixed username, and
filed its comments and tasks under a fixed author. Both were one deployment's
values baked into a published package: anyone else installing it assigned work
to a user their tracker has never heard of, which most trackers drop silently.

The assignee now comes from `TA_APPROVAL_ASSIGNEE`, and when that is unset the
field is left alone rather than guessed. Attribution on comments and filed
tasks is now `trusted-actions-pwa`, which names the surface that created them
instead of a person.
