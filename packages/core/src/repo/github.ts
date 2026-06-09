/**
 * Default `RepoBackend` implementation — wraps the GitHub CLI (`gh`) and
 * `git`. Slice 4 of the platform vision (`docs/platform-vision.md`).
 *
 * Shells out through an injectable `CmdRunner` (defaults to
 * `execFile`), mirroring `GitResourceSource`'s `GitRunner` seam so tests
 * drive it without a real `gh` install or network. When an `EventBus` is
 * supplied, the mutating calls emit `repo.proposal.opened` / `.merged` /
 * `.closed` so observability + automation plugins can react.
 *
 * Auth: when `token` is set it's exported as `GH_TOKEN` for the child
 * process; otherwise the ambient `gh auth` / `GH_TOKEN` environment is
 * used. `repo` (owner/name) is passed via `-R` when set; otherwise `gh`
 * infers it from the cwd's remote.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EventBus } from "../events.js";
import type {
  MergeProposalInput,
  OpenProposalInput,
  Proposal,
  ProposalRef,
  ProposalState,
  PushBranchInput,
  PushResult,
  RepoBackend,
} from "./interface.js";

const execFileAsync = promisify(execFile);

export type CmdRunner = (
  bin: "git" | "gh",
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface GhRepoBackendOptions {
  /** owner/repo passed to `gh -R`. Optional — `gh` infers from the remote. */
  repo?: string;
  /** Exported as GH_TOKEN for the child process. Falls back to ambient auth. */
  token?: string;
  /** Default target branch for new proposals. Default "main". */
  defaultBase?: string;
  /** Default git remote for pushes. Default "origin". */
  remote?: string;
  /** When present, mutating calls emit repo.proposal.* events. */
  events?: EventBus;
  /** Override the command runner — primarily for tests. */
  runner?: CmdRunner;
}

/** Shape of `gh pr view --json …` we depend on. */
interface GhPrJson {
  number?: number;
  state?: string;
  url?: string;
  title?: string;
  headRefName?: string;
  baseRefName?: string;
  isDraft?: boolean;
  reviews?: Array<{ author?: { login?: string }; state?: string }>;
}

const PR_JSON_FIELDS = "number,state,url,title,headRefName,baseRefName,isDraft,reviews";

export class GhRepoBackend implements RepoBackend {
  readonly name = "github";
  private readonly repo?: string;
  private readonly defaultBase: string;
  private readonly remote: string;
  private readonly events?: EventBus;
  private readonly runner: CmdRunner;

  constructor(opts: GhRepoBackendOptions = {}) {
    this.repo = opts.repo;
    this.defaultBase = opts.defaultBase ?? "main";
    this.remote = opts.remote ?? "origin";
    this.events = opts.events;
    const token = opts.token;
    this.runner =
      opts.runner ??
      (async (bin, args, runOpts) => {
        const env = token ? { ...process.env, GH_TOKEN: token, ...runOpts?.env } : { ...process.env, ...runOpts?.env };
        const { stdout, stderr } = await execFileAsync(bin, args, {
          cwd: runOpts?.cwd,
          env,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout, stderr };
      });
  }

  /** Append `-R owner/repo` when a repo is configured. */
  private withRepo(args: string[]): string[] {
    return this.repo ? [...args, "-R", this.repo] : args;
  }

  async pushBranch(input: PushBranchInput): Promise<PushResult> {
    const remote = input.remote ?? this.remote;
    const args = ["push"];
    if (input.force) args.push("--force-with-lease");
    args.push(remote, `${input.branch}:${input.branch}`);
    const { stderr } = await this.runner("git", args, { cwd: input.repoPath });
    const upToDate = /everything up-to-date/i.test(stderr);
    return { remote, branch: input.branch, pushed: !upToDate, upToDate };
  }

  async openProposal(input: OpenProposalInput): Promise<Proposal> {
    const base = input.base ?? this.defaultBase;
    const args = ["pr", "create", "--head", input.branch, "--base", base, "--title", input.title];
    args.push("--body", input.body ?? "");
    if (input.draft) args.push("--draft");
    await this.runner("gh", this.withRepo(args), { cwd: input.repoPath });

    // `gh pr create` prints the URL but not structured fields; re-read the
    // branch's PR for a normalized snapshot.
    const proposal = await this.viewPr(input.repoPath, input.branch);
    if (!proposal) {
      throw new Error(`opened a proposal for ${input.branch} but could not read it back`);
    }
    this.events?.emit("repo.proposal.opened", {
      proposalId: proposal.id,
      number: proposal.number,
      url: proposal.url,
      branch: proposal.branch,
      base: proposal.base,
      taskId: input.taskId,
    });
    return proposal;
  }

  async getProposalState(ref: ProposalRef): Promise<Proposal | undefined> {
    return this.viewPr(ref.repoPath, ref.id);
  }

  async mergeProposal(input: MergeProposalInput): Promise<Proposal> {
    const method = input.method ?? "merge";
    const args = ["pr", "merge", input.id, `--${method}`];
    if (input.deleteBranch) args.push("--delete-branch");
    await this.runner("gh", this.withRepo(args), { cwd: input.repoPath });

    const proposal = (await this.viewPr(input.repoPath, input.id)) ?? {
      id: input.id,
      branch: "",
      base: this.defaultBase,
      title: "",
      state: "merged" as ProposalState,
      approvedBy: [],
    };
    this.events?.emit("repo.proposal.merged", {
      proposalId: proposal.id,
      number: proposal.number,
      branch: proposal.branch,
      taskId: input.taskId,
    });
    return proposal;
  }

  async closeProposal(ref: ProposalRef): Promise<void> {
    await this.runner("gh", this.withRepo(["pr", "close", ref.id]), { cwd: ref.repoPath });
    const proposal = await this.viewPr(ref.repoPath, ref.id);
    this.events?.emit("repo.proposal.closed", {
      proposalId: ref.id,
      number: proposal?.number,
      branch: proposal?.branch ?? "",
    });
  }

  /** Read a PR by number or head branch; undefined when it doesn't exist. */
  private async viewPr(repoPath: string, selector: string): Promise<Proposal | undefined> {
    try {
      const { stdout } = await this.runner("gh", this.withRepo(["pr", "view", selector, "--json", PR_JSON_FIELDS]), {
        cwd: repoPath,
      });
      return mapPrJson(JSON.parse(stdout) as GhPrJson);
    } catch {
      // gh exits non-zero when no PR matches the selector.
      return undefined;
    }
  }
}

/** Map gh's PR JSON onto the normalized `Proposal`. Exported for tests. */
export function mapPrJson(json: GhPrJson): Proposal {
  const approvedBy = Array.from(
    new Set(
      (json.reviews ?? [])
        .filter((r) => r.state === "APPROVED" && r.author?.login)
        .map((r) => r.author?.login as string),
    ),
  );
  return {
    id: json.number != null ? String(json.number) : "",
    number: json.number,
    url: json.url,
    branch: json.headRefName ?? "",
    base: json.baseRefName ?? "",
    title: json.title ?? "",
    state: mapState(json.state, json.isDraft),
    approvedBy,
  };
}

function mapState(state: string | undefined, isDraft: boolean | undefined): ProposalState {
  switch ((state ?? "").toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return isDraft ? "draft" : "open";
  }
}
