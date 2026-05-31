# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) to
version and publish the public `@tailored-ai/*` packages together.

Five packages publish: `browser-mediator`, `core`, `server`, `cli`,
`trusted-actions`. They are configured as a **fixed** group — they always
bump together. `@tailored-ai/ui` and `@tailored-ai/site` are private and
never publish.

## One-time setup

### 1. npm scope + token

```bash
# Log in (just once on your dev machine).
npm login

# If the @tailored-ai scope does not exist yet, create it as a free org
# at https://www.npmjs.com/org/create — or use a personal scope and
# rename all packages to @<username>/* before the first publish.

# Create a granular automation token scoped to @tailored-ai/*:
#   https://www.npmjs.com/settings/<you>/tokens/new
#     - Token type: Granular Access
#     - Packages and scopes: select "@tailored-ai"
#     - Permissions: read + write
#     - Expiration: 90 days (rotate regularly)
```

### 2. GitHub repo secret

```
Settings → Secrets and variables → Actions → New repository secret
  Name:  NPM_TOKEN
  Value: <the granular token>
```

### 3. Branch protection

```
Settings → Branches → main → "Require status checks"
  Require:  CI / build-and-test
  Require:  branches up to date before merging
```

## Cutting a release

The flow is **PR-driven** — you don't run publish locally.

1. **Write a changeset** with every code-changing PR:
   ```bash
   pnpm changeset
   ```
   Pick the bump (patch/minor/major) and write one paragraph. Commit the
   resulting `.changeset/*.md` file alongside the PR.

2. **Merge PRs** to `main` as normal. The release workflow opens (or
   updates) a single "chore: version packages" PR that bumps versions in
   every `package.json`, regenerates `CHANGELOG.md`s, and deletes the
   consumed `.changeset/*.md` files.

3. **Merge the version PR** when you're ready to ship. The release
   workflow runs again, this time taking the publish branch, and runs
   `pnpm publish -r --access public` for every changed package. Provenance
   is enabled — npm displays the GitHub Actions run that built each
   tarball.

4. **Tag** (the changesets action does this automatically).

## Verifying a tarball before publish

For paranoia or first publishes, pack a candidate locally:

```bash
cd packages/core
pnpm pack --pack-destination /tmp/pack-check
tar -tzf /tmp/pack-check/tailored-ai-core-*.tgz
```

The tarball should contain only `dist/`, `package.json`, `README.md`,
`LICENSE`. Anything in `local/`, `data/`, `src/`, `node_modules/`, or a
`.test.ts` file leaking is a bug — fix the `files` allow-list.

## Rolling back a bad publish

npm permits **deprecating** a version, not deleting it. If you publish
something broken:

```bash
npm deprecate @tailored-ai/core@0.1.0 "Use 0.1.1 instead — fixes broken X."
```

Then publish a fix as a normal patch.
