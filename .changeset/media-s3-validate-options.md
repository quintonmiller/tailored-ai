---
"@tailored-ai/media-s3": patch
---

Validate the config the runtime actually delivers

`validateConfig` read `media.bucket` / `media.region` / `media.accessKeyId` from
the top of the `media` block, but the store factory is handed `media.options`
verbatim — core hoists only `dir`, `maxBytes` and `urlBase` from the top level.
A correctly configured deployment was therefore told, on every boot:

    media.store is s3 but media.bucket is empty
    media.store is s3 but no credentials resolved; every media write will fail

while writes worked perfectly. A validator that cries wolf is worse than no
validator, because it trains you to skim the startup log — and this one buried a
real warning under three false ones.

It now reads `options` first and falls back to the top level, since that is
where this plugin's own docs used to put these keys and silently ignoring a
setting copied from the README is the other half of the same failure. The doc
comment is corrected to show the nesting the runtime honours.
