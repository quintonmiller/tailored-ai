---
"@tailored-ai/media-s3": patch
---

Register the store through `ctx.mediaStores`, not core's exported
`registerMediaStoreFactory`.

A plugin resolves `@tailored-ai/core` from its own `node_modules`, which is a
different module instance — and so a different `Registry` object — from the one
the runtime uses. Calling the imported function put the factory in a registry
nobody reads.

The symptom was silence: the plugin loaded, the loader logged that it loaded,
`validateConfig` reported nothing, and the first attempt to store media failed
with "this deployment has no media store", which reads as though the store was
never configured. `ctx` is the runtime's own registry, which is the reason it is
handed to a plugin at all.

Also drops the last runtime import of core from the plugin entry point, leaving
it type-only.
