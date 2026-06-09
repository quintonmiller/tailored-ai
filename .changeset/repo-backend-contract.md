---
"@tailored-ai/core": patch
---

Add the `RepoBackend` contract + default `gh` implementation — Slice 4 of
the platform vision (`docs/platform-vision.md`, `docs/repo-backend.md`).

`RepoBackend` is the forge seam: `pushBranch`, `openProposal`,
`getProposalState`, `mergeProposal`, `closeProposal`, normalized around a
forge-neutral `Proposal` (PR / MR / change). The default `GhRepoBackend`
wraps the `gh` CLI through an injectable `CmdRunner`; GitLab / Gitea /
Bitbucket / trunk-based workflows register their own backend via
`registerRepoBackendFactory` (exposed to plugins as `ctx.repoBackends`).

Backend selection is **opt-in**: with no `repo.backend` configured,
`createRepoBackend` returns `undefined` and core neither pushes nor opens
proposals — today's behavior is unchanged. Setting `repo.backend: github`
lights up the default.

Built-ins are not privileged: `repo.backend` is a plain `string` resolved
through the registry, and backend-specific settings live in an opaque
`repo.options` bag the selected backend reads itself (the github backend
reads `options.repo` / `options.token`). Core carries no per-forge schema.

New `repo.*` events on the runtime bus: `repo.proposal.opened` /
`.merged` / `.closed` are emitted by the default backend; `.reviewed` and
`repo.check.completed` are declared placeholders for a future forge
webhook bridge. This is purely additive; migrating the reviewer-approve
flow to call the backend is a follow-up.
