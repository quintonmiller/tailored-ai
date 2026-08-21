# @tailored-ai/arcade

A local site and database for what the game jam builds, and the scores a person
gives it. Private, and with **no dependency on `@tailored-ai/core`** — this is
not a framework feature, it is a thing the benchmark writes to.

```bash
pnpm run arcade                                  # site :4321, games :4322
pnpm run arcade -- list --drafts
pnpm run arcade:import <workshops-dir> --min-rounds 10
```

Data lives in `~/.tai-arcade` (or `$ARCADE_HOME`), outside the repo on purpose:
`packages/evals/results/` sits in a worktree that gets deleted, and the value of
this accrues over months.

| file | |
|---|---|
| `src/categories.ts` | the five review categories — **the only copy**; the jam brief and the artifact scorecard both read it |
| `src/store.ts` | SQLite: entries, media, reviews. The write scope an agent gets is five columns wide |
| `src/publish.ts` | copy a finished run in: files, screenshots, build reel, `.zip` |
| `src/server.ts` | JSON API + static site, and a **second server on another origin** for the games |
| `src/zip.ts` | a zip writer, because a download button is not worth a dependency |
| `web/` | the site: no build step, no framework |

Games are model-written code executed in the reviewer's browser, so they are
served from their own port with `connect-src 'none'`. Same origin as the API, a
game could post its own five-star review. See
[docs/arcade.md](../../docs/arcade.md) for the rest of the reasoning, the agent
tools, and what this cannot tell you.
