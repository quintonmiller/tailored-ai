# Publishing to npm

The release pipeline is automated. After the one-time setup below, shipping a
release is just merging two PRs: the feature PR (with a changeset) and the
auto-generated "Version Packages" PR.

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

1. **Open a feature PR** with a changeset file under `.changeset/`. Generate
   with `pnpm changeset`.
2. **Merge the feature PR to `main`.** This triggers
   `.github/workflows/release.yml`, which runs the changesets action.
   - The action finds the new `.changeset/*.md` files and either:
     - **Opens or updates the "Version Packages" PR** (branch
       `changeset-release/main`) bumping versions and consolidating changelogs,
       or
     - **Publishes to npm** if a "Version Packages" PR was just merged.
3. **`auto-merge-version-pr.yml` flips the version PR into auto-merge mode.**
   GitHub waits for `build-and-test` to go green, then squash-merges.
4. **Merge of the version PR to `main` re-triggers `release.yml`.** This time
   the changesets action sees no pending `.changeset/*.md` files, runs
   `pnpm publish -r`, and tags a GitHub Release per package (via
   `createGithubReleases: true`).
5. **Post-publish verification.** A workflow step does `npm view PKG@VERSION`
   on each published package — fails the run loudly if any tarball didn't
   reach the registry.

End state per release: new package versions on the npm registry, tagged
GitHub releases per package with the changelog body, no human in the loop
after the feature PR merges.

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
release ships.

## Pausing or vetoing a release

The version PR is the only checkpoint between a merged changeset and a real
npm publish. To pause:

- **Disable auto-merge on the version PR** (PR page → "Disable auto-merge").
  The PR stays open until a human merges it.
- **Close the version PR** if you want to drop everything queued. The next
  push to `main` regenerates it from the still-present `.changeset/*.md`
  files. To truly drop, delete the changeset files too.

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

## Rollback / unpublish

npm allows unpublish within 72 hours of publish for non-replacement reasons.
After that, the path is deprecation, not removal:

```bash
# Within 72 hours of a bad publish
npm unpublish @tailored-ai/core@1.0.0

# Older than 72 hours — mark broken, ship a fix forward
npm deprecate '@tailored-ai/core@1.0.0' 'broken release, use 1.0.1+'
```

Tags created by `createGithubReleases: true` can be deleted from the GitHub
Releases page if you also want to remove the tag.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Release workflow runs but version PR never appears | `GITHUB_TOKEN` lacks `pull-requests: write` | `permissions:` block in `release.yml` already grants it — check repo Settings → Actions → Workflow permissions allows the actions to create PRs |
| Version PR exists but CI doesn't run on it | GitHub blocks workflow triggers from PRs opened by `GITHUB_TOKEN` | Settings → Actions → "Allow GitHub Actions to create and approve pull requests" + push an empty commit to retrigger |
| Publish step fails: `OTP required` | npm token has full-write 2FA enforced | Regenerate as automation token with "Authorization only" 2FA, or as a granular token (which never prompts for OTP) |
| Publish step fails: `403 Forbidden` | npm token doesn't own `@tailored-ai` scope | Use a token from the scope owner's account |
| Auto-merge workflow fails: `auto-merge is not allowed` | Repo auto-merge not enabled | Settings → General → "Allow auto-merge" |
| Post-publish verify fails: package not found | npm registry replication delay (rare) or partial publish | Re-run the workflow (`Actions → Release → Re-run failed jobs`) — `pnpm publish` is idempotent on already-published versions |
| `pack:check` fails locally before merge | Stale or missing `dist/` | `pnpm -r run clean && pnpm run build && pnpm run pack:check` |
