---
"@tailored-ai/core": patch
"@tailored-ai/channel-slack": patch
---

Let a deployment prefer a link over an attachment

`media.delivery` picks how a surface delivers media it *could* attach. `auto`
(the default) keeps today's behaviour: attach whatever fits, link past the cap.
`link` prefers a link whenever one resolves, which is what you want for
something durable — a generated podcast is more useful as a URL you can open on
a phone and keep than as a chat attachment that has to be downloaded again.

The preference is only ever a preference. A link that cannot be produced — no
store URL, or a surface with no link support — falls back to attaching, so the
setting can never turn a deliverable file into a bare placeholder. Honoured by
both Discord and Slack, since a setting that works on one surface and silently
does nothing on the other is worse than no setting.
