---
"@tailored-ai/media-r2": patch
"@tailored-ai/media-s3": patch
---

New package: Cloudflare R2 as a media store.

`@tailored-ai/media-s3` already reaches R2 given the right `endpoint`, but three
settings have to be exactly right, none are discoverable, and a wrong one fails
with `SignatureDoesNotMatch`, which names none of them: the account endpoint
shape, the `auto` signing region, and path-style addressing. This fills them in,
leaving `accountId` as the only new thing to know — the same reason
`provider-deepseek` sits beside `provider-openai`.

Adds one thing S3 has no equivalent of: `publicBaseUrl`, for a bucket exposed on
`r2.dev` or a custom domain, so links are permanent rather than expiring.
`validateConfig` states plainly that this makes objects unauthenticated and
non-expiring; the default stays presigned and private.

`media-s3` now exports `bridgeToCore`, `CoreBridge` and `extensionFor` so a
sibling store can share the version check rather than duplicating it.
