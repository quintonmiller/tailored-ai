---
"@tailored-ai/core": patch
---

Screenshots from both browser tools now reach the model as images.

`BrowserMediatorTool` read its `MediaStore` from a constructor field that only
tests ever set — the factory builds it from config, and the store does not exist
until the runtime does — so the branch attaching the picture was never taken in a
real deployment. It now falls back to `ToolContext.mediaStore`, which is where
the live store has been arriving all along.

The built-in `browser` tool's `screenshot` action wrote a PNG to disk and
returned the path as text. It still writes the file and still reports the path,
and now also attaches the image when a media store is available.

Deployments with no media store are unaffected: both tools return exactly the
text they returned before.
