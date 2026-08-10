# Publishing to npm

The release pipeline is automated. After the one-time setup below, shipping a
release is merging two PRs — the feature PR (with a changeset) and the
auto-generated "Version Packages" PR — and then dispatching the publish by
hand. Nothing publishes on a push.

## One-time setup

A repo admin runs these once. After that, no human action is needed per
release.

### 1. Mint an npm automation token

Sign in to npm with an account that owns the `@tailored-ai` scope. Open
[https://www.npmjs.com/settings/&lt;user&gt;/tokens](https://www.npmjs.com/settings/USERNAME/tokens)
and:

1. **Generate New Token → Granular Access Token** (recommended) or **Classic →
   Automation**.
2. **Granular settings:**
   - Expiration: 1 year (rotate on calendar)
   - Packages and scopes: select `@tailored-ai`, permission `Read and write`
   - Allowed IP ranges: leave empty (GitHub Actions runners use dynamic IPs)
3. Copy the token — npm only shows it once.

> ⚠️ Provenance (`publishConfig.provenance: true`) requires an automation token
> with `2FA: Authorization only` on the publisher account, not `2FA: Auth &
> writes`. Classic tokens with full 2FA enforcement will fail at publish time
> with `OTP required`.

### 2. Save the token as a GitHub repo secret

```bash
gh secret set NPM_TOKEN --body 'npm_xxxxxxxx' --repo quintonmiller/tailored-ai
```

Or via the UI: **Settings → Secrets and variables → Actions → New repository
secret** named `NPM_TOKEN`.

### 3. (Recommended) Add a Personal Access Token for the release workflow

GitHub deliberately does not run `pull_request` workflows on PRs that were
opened by the default `GITHUB_TOKEN`. The version PR is opened by the
changesets action, so if it runs with `GITHUB_TOKEN` only, no CI workflow
fires on the PR — required-check gates never resolve, and auto-merge never
trips.

Workaround: open the PR using a Personal Access Token. The release workflow
prefers `RELEASE_PAT` and falls back to `GITHUB_TOKEN`, so this is opt-in.

1. **github.com → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token.**
2. Resource owner: `quintonmiller` (or org). Repository access: only
   `tailored-ai`.
3. Repository permissions:
   - Contents: Read and write
   - Pull requests: Read and write
   - Workflows: Read and write
4. Save the token, then on the repo:

   ```bash
   gh secret set RELEASE_PAT --body 'github_pat_...' --repo quintonmiller/tailored-ai
   ```

Alternative if you don't want a PAT: leave the secret unset, and instead
either (a) push an empty commit to the version PR to retrigger CI manually,
or (b) flip **Settings → Actions → "Allow GitHub Actions to create and
approve pull requests"** on — that flag relaxes some bot-PR restrictions but
not all of them. The PAT path is strictly less fiddly.

### 4. Enable auto-merge on the repo

**Settings → General → Pull Requests → Allow auto-merge.**

This lets `.github/workflows/auto-merge-version-pr.yml` flip the changesets PR
into auto-merge mode. Without this, that workflow's `gh pr merge --auto` call
fails and the version PR sits waiting for a manual merge.

### 5. Add `build-and-test` as a required check on `main`

**Settings → Branches → Branch protection rules → main → Require status checks
to pass → `build-and-test`.**

This is what gates auto-merge. Without a required check, auto-merge merges
immediately on every push to the version PR, which defeats the safety net.

## Per-release flow

Publishing is a **deliberate act** — it never happens automatically on a push
to `main`. The flow:

1. **Open a feature PR** with a changeset file under `.changeset/`. Generate
   with `pnpm changeset`. **Mark every bump `patch`** while pre-1.0 (see the
   versioning rule below).
2. **Merge the feature PR to `main`.** This triggers the `version` job in
   `.github/workflows/release.yml`, which **opens or updates the "Version
   Packages" PR** (branch `changeset-release/main`). It does **not** publish.
3. **Review and merge the Version Packages PR yourself.** It is **not**
   auto-merged by default — look at the proposed `package.json` bumps first
   (confirm they're `0.1.x → 0.1.(x+1)`, **not** an unintended `1.0.0`). To
   restore the old auto-merge-on-green behaviour for a routine 0.x bump, add
   the `release:auto-merge` label to the PR.
4. **Publish manually.** Go to **Actions ▸ Release ▸ Run workflow** (from
   `main`), or run `gh workflow run Release --ref main`. Publishing then
   verifies every publishable package reached the registry, and tags a commit
   and a GitHub Release per package.

   > **The dispatch is the gate. There is no approval pause after it.**
   > The `npm-publish` environment names the maintainer as a required
   > reviewer, but `prevent_self_review` is off — so when the person
   > dispatching is also the reviewer, GitHub has nobody left to ask and the
   > job starts immediately. Observed on the 0.1.10 publish, and accepted on
   > 2026-08-09 as how this repo works (#487): with one maintainer, the
   > alternative is a gate that can never be passed. Treat running the
   > workflow as the moment of decision — the next thing that happens is an
   > irreversible publish.
   >
   > The reviewer rule is not decorative. It still holds whenever the
   > dispatcher is *not* the named reviewer, which is the case that would
   > matter if this repo ever gains a second contributor with write access.

The gates exist so a stray `major`/`minor` changeset — including one authored
by an unattended agent — cannot ship a release on its own. See the 2026-06-09
incident note under "Pre-1.0 versioning rule."

What actually holds today: nothing publishes on a push, the version PR is a
separate deliberate merge, `guard:pre-v1` refuses a non-`patch` changeset in
three places, and the publish needs a hand-run `workflow_dispatch`. That is one
human act at the end rather than the two originally designed — enough that an
unattended agent cannot ship a release, and worth knowing exactly, because the
difference used to be documented the other way round.

## Pre-1.0 versioning rule

Until we ship `1.0.0`, mark every changeset as `patch` regardless of whether
the change is technically a minor feature. Two reasons:

1. **Semver pre-1.0 minor _is_ breaking.** `^0.1.0` does not satisfy `0.2.0`
   — the caret is special-cased pre-1.0. Calling something `minor` leaks
   breaking changes onto consumers pinned with caret ranges.
2. **Changesets escalates peer dependents.** `@tailored-ai/channel-slack`
   and `@tailored-ai/google-tools` declare `@tailored-ai/core` as a peer
   dependency (correct plugin pattern). When `core` bumps `minor` while
   below 1.0, changesets bumps every peer dependent in the `fixed` group to
   `major` (the new version no longer satisfies the peer range), which
   ripples to all 7 packages and pushes the whole group to `1.0.0` before
   we're ready.

The `1.0.0` release will be coordinated when the public surface is stable
and we deliberately want to cut it. Until then, every release is
`0.1.x → 0.1.(x+1)`. `pnpm changeset add` lets you pick a bump type per
package; pick `patch` for all of them.

> **Incident — 2026-06-09.** Several changesets were marked `minor` (not
> `patch`). Pre-1.0, a `minor` on `core` escalates the whole `fixed` group to
> `major` (the peer-dependent mechanism above), so the Version Packages PR
> bumped everything to `1.0.0`, and the old auto-publish-on-push path shipped
> `1.0.0` to npm before anyone reviewed it. Fixes: every changeset is `patch`
> again, the Version Packages PR is no longer auto-merged by default, and npm
> publishing is now a manual `workflow_dispatch` job (above) rather than
> anything that fires on a push. If a Version
> Packages PR ever proposes `1.0.0`, a non-`patch` changeset slipped in —
> find it (`grep -rL '"@tailored-ai/.*": patch' .changeset/*.md`) and fix it
> before merging.

## Inspecting what would publish before merging

Run locally on the branch with the queued changesets:

```bash
pnpm changeset status --verbose
```

This prints the next version per package and which changesets feed it. Does
not modify any files.

To see the actual `package.json` diffs the version PR will produce, look at
the open PR titled "chore: version packages" in the GitHub UI. Reviewing the
generated `CHANGELOG.md` snippets there is the cheap last-look before a
release ships — and the only place the naming half of the neutral-cast rule
(`CLAUDE.md`) can still be caught, since those snippets become the published
CHANGELOG of every package and npm publishes cannot be withdrawn.

## Checking a release actually shipped

```bash
pnpm run verify:release
```

Reads every non-private `packages/*` package and asserts the registry has it at
the version this checkout claims, naming any that are missing. It reads the
workspace rather than a publish log, so it answers the same question from any
checkout, at any time — including "did last month's release really go out."

The publish job runs this too, unconditionally. A green publish job means the
registry was checked, not that a step decided to skip.

## Pausing or vetoing a release

There are two independent checkpoints, both manual by default:

- **The Version Packages PR** is not auto-merged — just don't merge it. To
  drop everything queued, close it (the next push regenerates it from the
  `.changeset/*.md` files; delete those to drop for good).
- **The npm publish** only runs when you manually trigger the `publish` job
  (Actions ▸ Release ▸ Run workflow). Not triggering it vetoes the release.
  Nothing ships from a push to `main`. The dispatch is the last reversible
  moment: the `npm-publish` environment does not stop to ask (#487, accepted),
  and a published version cannot be withdrawn.

## Manual / emergency publish

If the GitHub action is broken and you need to ship from a clean checkout:

```bash
# Pre-checks
pnpm install --frozen-lockfile
pnpm run build
pnpm run pack:check
pnpm run test

# Version bump from changesets
pnpm changeset version
git commit -am "chore: version packages (manual)"
git tag -a "$(jq -r .version packages/core/package.json)" -m "manual release"

# Auth (npm CLI session, OR set NPM_TOKEN in ~/.npmrc on a temp box)
npm whoami

# Publish (use --dry-run first if uncertain)
pnpm publish -r --access public --no-git-checks
```

## Rollback a bad publish — deprecate, don't unpublish

**`npm unpublish` does not work for this monorepo.** npm only allows unpublish
when nothing in the registry depends on the version, and our packages depend on
each other (`server`/`cli` depend on `core`; `channel-slack`/`google-tools`
peer-depend on `core`). So `npm unpublish @tailored-ai/core@1.0.0` returns:

```
npm error 405 ... You can no longer unpublish this package.
npm error Failed criteria: has dependent packages in the registry
```

This is permanent and independent of the 72-hour window or the unpublish
order — the inter-package dependency means the "no dependents" criterion can
never be met. **The only path is `npm deprecate` + re-pointing the `latest`
dist-tag** at the last good 0.x. This does not free the version number, so a
deprecated `1.0.0`/`1.0.1` is still spent — the eventual real V1 must be a
higher number.

### Authentication for the rollback (security-key 2FA)

The maintainer's npm account uses a WebAuthn **security key** for 2FA, which
the CLI cannot satisfy with `--otp` (there's no TOTP). Use an **npm automation
token** or **granular access token** instead — both bypass 2FA for CLI writes:

1. npmjs.com ▸ Access Tokens ▸ **Generate New Token**.
2. **Granular Access Token** (recommended): Read and write, scope
   `@tailored-ai`, short expiry. (Or **Classic ▸ Automation**.)
3. Run the script below with the token in `NPM_TOKEN` — it never touches
   `~/.npmrc`:

```bash
NPM_TOKEN=npm_xxx bash scripts/npm-deprecate-1x.sh
```

`scripts/npm-deprecate-1x.sh` deprecates every `1.0.x` across the fixed group
and re-points `latest` to the last good 0.x, then prints the resulting
dist-tags. Editable list of bad versions / target at the top of the script.

### Prevention

Going forward, a bad group-wide bump can't ship unattended:

- `pnpm run guard:pre-v1` runs in CI (`ci.yml`) and in the release `version`
  job — it fails if any publishable version is `>= 1.0.0` or any changeset
  isn't `patch`.
- Publishing is `workflow_dispatch`-only and gated on the `npm-publish`
  environment (see above).

Tags created by `createGithubReleases: true` can be deleted from the GitHub
Releases page if you also want to remove the tag.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Release workflow runs but version PR never appears | `GITHUB_TOKEN` lacks `pull-requests: write` | `permissions:` block in `release.yml` already grants it — check repo Settings → Actions → Workflow permissions allows the actions to create PRs |
| Version PR exists but CI doesn't run on it (build-and-test stuck on "Expected — Waiting for status to be reported") | `actions/checkout` not using `RELEASE_PAT`, so the changesets action's `git push` to `changeset-release/main` is committed by `github-actions[bot]` and GitHub suppresses workflow triggers on bot-sourced events | Verify `actions/checkout` in `release.yml` has `token: ${{ secrets.RELEASE_PAT || secrets.GITHUB_TOKEN }}`. As a one-shot unblock, push an empty commit to `changeset-release/main` from a real user account: `git checkout changeset-release/main && git commit --allow-empty -m 'nudge ci' && git push` |
| Version PR merged but `release.yml` doesn't fire (no publish, no GitHub releases) | `auto-merge-version-pr.yml` enables auto-merge using `GITHUB_TOKEN`, so GitHub credits the eventual merge to the bot. The resulting push to `main` is treated as GITHUB_TOKEN-sourced and the publish workflow is suppressed | Verify the `gh pr merge` step in `auto-merge-version-pr.yml` sets `GH_TOKEN: ${{ secrets.RELEASE_PAT \|\| secrets.GITHUB_TOKEN }}`. One-shot unblock: trigger the publish manually — `gh workflow run Release --ref main`. `workflow_dispatch` is exempt from the bot-suppression rule |
| Publish step fails: `OTP required` | npm token has full-write 2FA enforced | Regenerate as automation token with "Authorization only" 2FA, or as a granular token (which never prompts for OTP) |
| Publish step fails: `403 Forbidden` | npm token doesn't own `@tailored-ai` scope | Use a token from the scope owner's account |
| Auto-merge workflow fails: `auto-merge is not allowed` | Repo auto-merge not enabled | Settings → General → "Allow auto-merge" |
| Post-publish verify fails: package not found | npm registry replication delay (rare) or partial publish | Re-run the workflow (`Actions → Release → Re-run failed jobs`) — `pnpm publish` is idempotent on already-published versions |
| `pack:check` fails locally before merge | Stale or missing `dist/` | `pnpm -r run clean && pnpm run build && pnpm run pack:check` |
