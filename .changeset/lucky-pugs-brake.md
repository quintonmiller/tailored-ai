---
"@tailored-ai/browser-mediator": patch
"@tailored-ai/core": patch
---

Stop shipping build tooling in the self-host image.

`pnpm deploy --prod` drops `devDependencies` but keeps `peerDependencies`
marked `optional`, so vitest, `md-to-pdf` and Playwright reached the runtime
image along with `typescript`, `vite`, `rollup`, two `esbuild` binaries, two
`lightningcss` binaries and `puppeteer-core` — about 150 MB nothing could
import. `@tailored-ai/browser-mediator` also declared `playwright` as a hard
runtime dependency while only ever importing it lazily, contradicting its own
README.

`playwright` and `md-to-pdf` are no longer peer dependencies of
`@tailored-ai/core`, and `playwright` is now an optional peer dependency of
`@tailored-ai/browser-mediator` rather than a dependency. Both were already
lazily imported behind an actionable "not installed" message, so no feature
changes: the `browser` and `md_to_pdf` tools return that message instead of
Playwright's "Executable doesn't exist" path error.

The image drops from 880 MB to 669 MB. MCP, PDF extraction and OCR are
untouched.
