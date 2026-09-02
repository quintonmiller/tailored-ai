---
"@tailored-ai/speech": patch
---

Keep the plugin's runtime dependency on core at zero, so it loads against a
plugin home pinned to an older core.

`speak.ts` imported `mediaPart` and `textPart` from `@tailored-ai/core` as
values. Those arrived with the media work, so against any earlier core the
plugin failed at import with `does not provide an export named 'mediaPart'` —
before registering anything. The tool never appears and it looks like the
plugin was never configured.

Core's plugin contract is type-only by design (`PluginMeta`'s own doc says
plugins keep zero runtime dependency on core). The two constructors are two
fields wide and now live in `content.ts`, with a test that compares them
against core's real ones so drift fails here rather than silently emitting a
part core will not read.
