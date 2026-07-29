---
"@tailored-ai/core": patch
---

Stop telling agents things that are not true

Three places where a comment, a doc, or a string shown to the model described
behaviour the code does not have. Each one had already cost something.

- **`load_skill` no longer says `— scoped to: <path>`.** `activeSkill.rootPath`
  is set and read by nothing; `read`/`exec` confine against
  `workingDirectoryBoundary`, which is unrelated. The header told the model it
  was confined when it was not, and disclosed the install path to do it. The
  field stays, honestly documented — it is what a real enforcement would need
  (#287).

- **`docs/skills.md` no longer claims `progressive` is the default.** The
  resolver falls back to `eager`, which then emits a deprecation warning: follow
  the doc, omit the key, get the path the doc says you are avoiding. The doc now
  says to write the key explicitly and notes that the CLI and UI already do.
  Fixed in the doc rather than the code — flipping a runtime default would
  silently change how live agents resolve skills.

- **`config.ts` no longer says the `ask_user` inbox is relative to the global
  context dir.** It is one level above, deliberately: `global/` is injected into
  every agent's prompt, and an inbox there broadcast a queue of questions to all
  of them, which reported months-old entries as live work. The comment invited
  someone to put it back.

Also adds a **Tool access** section to `docs/skills.md`, because `allowed-tools`
means opposite things in the two modes — it grants under `eager` and restricts
under `progressive` — and nothing said so.
