/**
 * Pluggable repo backend abstraction — Slice 4 of the platform vision
 * (`docs/platform-vision.md`).
 *
 * Today TAI's coder commits to a per-task branch in an isolated worktree
 * and stops; pushing the branch and opening a pull/merge request is done
 * either by the agent shelling `gh` per prompt instructions, or by the
 * user by hand. That bakes a GitHub + PR assumption into prompt text and
 * leaves the "push + open a proposal on approve" step un-mechanized — the
 * exact "plumbing lives in the prompt" problem the platform vision wants
 * to dissolve.
 *
 * `RepoBackend` is the seam. Core (or a default plugin) calls
 * `pushBranch` / `openProposal` / `getProposalState` / `mergeProposal` /
 * `closeProposal`; the default `gh` implementation wraps the GitHub CLI,
 * and GitLab / Gitea / Bitbucket / trunk-based-no-PR workflows become
 * swappable plugins registered via `registerRepoBackendFactory`.
 *
 * "Proposal" is the forge-neutral word for a GitHub pull request, a
 * GitLab merge request, a Gerrit change, etc. — a request to integrate a
 * branch that can be reviewed, approved, merged, or closed.
 */

/** Lifecycle state of a proposal, normalized across forges. */
export type ProposalState = "open" | "draft" | "merged" | "closed";

/** A pull/merge request as seen by a backend, normalized. */
export interface Proposal {
  /**
   * Backend-native identifier used for follow-up calls (get/merge/close).
   * For GitHub this is the PR number as a string; other backends may use
   * an internal id or URL.
   */
  id: string;
  /** Numeric PR/MR number when the forge has one. */
  number?: number;
  /** Web URL for humans, when available. */
  url?: string;
  /** Head branch the proposal integrates. */
  branch: string;
  /** Target branch the proposal merges into. */
  base: string;
  title: string;
  state: ProposalState;
  /** Logins/identities that have approved. Empty when none or unknown. */
  approvedBy: string[];
}

export interface PushBranchInput {
  /** Path to the host git repo or worktree the branch lives in. */
  repoPath: string;
  /** Branch to push. */
  branch: string;
  /** Remote name. Defaults to the backend's configured remote ("origin"). */
  remote?: string;
  /** Force-push (with lease). Default false. */
  force?: boolean;
}

export interface PushResult {
  remote: string;
  branch: string;
  /** True when the push transferred refs. */
  pushed: boolean;
  /** True when the remote already had the branch at this sha. */
  upToDate: boolean;
}

export interface OpenProposalInput {
  /** Path to the host git repo or worktree. */
  repoPath: string;
  /** Head branch (must already exist on the remote — push first). */
  branch: string;
  title: string;
  /** Target branch. Defaults to the backend's configured base ("main"). */
  base?: string;
  body?: string;
  /** Open as a draft when the forge supports it. Default false. */
  draft?: boolean;
  /** Task id for event correlation (carried on repo.proposal.opened). */
  taskId?: string;
}

/** Locates an existing proposal for follow-up operations. */
export interface ProposalRef {
  /** Path to the host git repo or worktree (the forge is resolved from it). */
  repoPath: string;
  /** Backend-native proposal id (e.g. PR number as a string). */
  id: string;
}

export interface MergeProposalInput extends ProposalRef {
  /** Merge strategy. Default "merge". */
  method?: "merge" | "squash" | "rebase";
  /** Delete the head branch after a successful merge. Default false. */
  deleteBranch?: boolean;
  /** Task id for event correlation (carried on repo.proposal.merged). */
  taskId?: string;
}

/**
 * A forge integration: push branches and manage proposals. Implementations
 * register a factory via `registerRepoBackendFactory`; the default is
 * `github` (wraps the `gh` CLI). All methods are async and may shell out or
 * hit a network API.
 */
export interface RepoBackend {
  /** Backend identifier, e.g. "github", "gitlab". */
  readonly name: string;

  /** Push a branch to the remote. Idempotent — a no-op push reports upToDate. */
  pushBranch(input: PushBranchInput): Promise<PushResult>;

  /** Open a proposal for an already-pushed branch. */
  openProposal(input: OpenProposalInput): Promise<Proposal>;

  /** Fetch a proposal's current state, or undefined if it doesn't exist. */
  getProposalState(ref: ProposalRef): Promise<Proposal | undefined>;

  /** Merge a proposal. Returns the post-merge proposal state. */
  mergeProposal(input: MergeProposalInput): Promise<Proposal>;

  /** Close a proposal without merging. */
  closeProposal(ref: ProposalRef): Promise<void>;
}
