# Repo backend

The repo backend is the forge seam: a small contract for **pushing a branch
and managing a proposal** (a pull request, merge request, Gerrit change —
the forge-neutral term is *proposal*). It's Slice 4 of the
[platform vision](./platform-vision.md).

## Why it exists

Today the coder commits to a per-task branch inside an isolated worktree and
stops. Pushing the branch and opening a PR happens one of two ways: the agent
shells `gh` because the dispatch prompt told it to, or you do it by hand. Both
bake a GitHub-and-PR assumption into prompt text, and neither lets core
mechanize "push the branch and open a proposal when the reviewer approves."

`RepoBackend` moves those operations behind an interface. The default
implementation wraps the `gh` CLI; GitLab, Gitea, Bitbucket, or a
trunk-based-no-PR workflow become plugins that register their own backend.

## The contract

```ts
interface RepoBackend {
  readonly name: string;
  pushBranch(input: PushBranchInput): Promise<PushResult>;
  openProposal(input: OpenProposalInput): Promise<Proposal>;
  getProposalState(ref: ProposalRef): Promise<Proposal | undefined>;
  mergeProposal(input: MergeProposalInput): Promise<Proposal>;
  closeProposal(ref: ProposalRef): Promise<void>;
}
```

A `Proposal` is normalized across forges:

```ts
interface Proposal {
  id: string;            // backend-native id (PR number as a string for GitHub)
  number?: number;
  url?: string;
  branch: string;        // head
  base: string;          // target
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  approvedBy: string[];  // approver logins
}
```

Every method takes a `repoPath` (the host repo or worktree) so a single backend
can serve many checkouts — the forge is resolved from that directory's remote.

## Configuration

Opt-in. With no `repo.backend` set, `createRepoBackend` returns `undefined` and
core neither pushes nor opens proposals — today's behavior is unchanged.

`backend` is any id registered in the repo-backend registry — built-ins and
third-party plugins are resolved the same way, and backend-specific settings go
in the opaque `options` bag rather than a per-backend block in core. Core knows
nothing about any particular forge's schema; the selected backend reads `options`
itself.

```yaml
repo:
  backend: github        # any registered backend id (built-in default: "github"); "none"/unset disables
  defaultBase: main      # target branch for new proposals (git-generic)
  remote: origin         # remote for pushes (git-generic)
  options:               # backend-specific, opaque to core — the github backend reads:
    repo: owner/name     #   falls back to tasks.github.repo, then gh's inferred remote
    token: ${GH_TOKEN}   #   falls back to tasks.github.token, then ambient `gh auth`
```

## Events

When the default backend is given the runtime event bus, mutating calls emit:

- `repo.proposal.opened` — after `openProposal`
- `repo.proposal.merged` — after `mergeProposal`
- `repo.proposal.closed` — after `closeProposal`

Two inbound events are declared but not yet emitted by core (a forge webhook
bridge lands later): `repo.proposal.reviewed` and `repo.check.completed`. The
vision's "auto-merge on green CI" plugin subscribes to the latter.

## Writing a backend

Implement `RepoBackend` and register a factory. Tests and plugins resolve it
through the same registry the default uses.

```ts
import { registerRepoBackendFactory, type RepoBackend } from "@tailored-ai/core";

const gitlab: RepoBackend = {
  name: "gitlab",
  async pushBranch(input) {/* git push … */},
  async openProposal(input) {/* glab mr create … */},
  async getProposalState(ref) {/* glab mr view … */},
  async mergeProposal(input) {/* glab mr merge … */},
  async closeProposal(ref) {/* glab mr close … */},
};

export default (ctx) => {
  ctx.repoBackends.register("gitlab", () => gitlab);
};
```

Then set `repo.backend: gitlab`.

## Status

This slice lands the contract, the default `gh` implementation, the registry,
and the `repo.proposal.*` events — purely additive, no behavior change. Wiring
the reviewer-approve flow to call `pushBranch` + `openProposal` (replacing the
prompt-driven push) is the follow-up.
