/**
 * GhRepoBackend tests — Slice 4 of the platform vision. Drive the backend
 * through an injected `CmdRunner` so no real `gh`/`git` or network is
 * touched: assert the exact argv we shell out, the Proposal mapping, and
 * the repo.proposal.* events.
 */
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../../events.js";
import { type CmdRunner, GhRepoBackend, mapPrJson } from "../github.js";

/** Build a runner that returns canned stdout/stderr and records calls. */
function fakeRunner(responses: Partial<Record<string, { stdout?: string; stderr?: string } | (() => never)>> = {}): {
  runner: CmdRunner;
  calls: Array<{ bin: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  const runner: CmdRunner = async (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts?.cwd });
    const key = `${bin} ${args[0]}${args[1] ? ` ${args[1]}` : ""}`;
    const r = responses[key] ?? responses[`${bin} ${args[0]}`];
    if (typeof r === "function") r();
    return { stdout: r?.stdout ?? "", stderr: r?.stderr ?? "" };
  };
  return { runner, calls };
}

const PR_JSON = JSON.stringify({
  number: 42,
  state: "OPEN",
  url: "https://github.com/o/r/pull/42",
  title: "Add thing",
  headRefName: "ptask_x",
  baseRefName: "main",
  isDraft: false,
  reviews: [
    { author: { login: "alice" }, state: "APPROVED" },
    { author: { login: "bob" }, state: "COMMENTED" },
    { author: { login: "alice" }, state: "APPROVED" },
  ],
});

describe("GhRepoBackend.pushBranch", () => {
  it("pushes branch:branch to the configured remote and reports pushed", async () => {
    const { runner, calls } = fakeRunner({ "git push": { stderr: "" } });
    const be = new GhRepoBackend({ runner });
    const r = await be.pushBranch({ repoPath: "/repo", branch: "ptask_x" });
    expect(r).toEqual({ remote: "origin", branch: "ptask_x", pushed: true, upToDate: false });
    expect(calls[0]).toEqual({ bin: "git", args: ["push", "origin", "ptask_x:ptask_x"], cwd: "/repo" });
  });

  it("detects an up-to-date push from stderr", async () => {
    const { runner } = fakeRunner({ "git push": { stderr: "Everything up-to-date" } });
    const be = new GhRepoBackend({ runner });
    const r = await be.pushBranch({ repoPath: "/repo", branch: "b" });
    expect(r.pushed).toBe(false);
    expect(r.upToDate).toBe(true);
  });

  it("adds --force-with-lease and honors a custom remote", async () => {
    const { runner, calls } = fakeRunner({ "git push": {} });
    const be = new GhRepoBackend({ runner, remote: "upstream" });
    await be.pushBranch({ repoPath: "/repo", branch: "b", force: true });
    expect(calls[0].args).toEqual(["push", "--force-with-lease", "upstream", "b:b"]);
  });
});

describe("GhRepoBackend.openProposal", () => {
  it("creates the PR, reads it back, and emits repo.proposal.opened", async () => {
    const { runner, calls } = fakeRunner({
      "gh pr create": { stdout: "https://github.com/o/r/pull/42\n" },
      "gh pr view": { stdout: PR_JSON },
    });
    const events = new TypedEventBus();
    const opened = vi.fn();
    events.on("repo.proposal.opened", opened);
    const be = new GhRepoBackend({ runner, events, repo: "o/r" });

    const p = await be.openProposal({ repoPath: "/repo", branch: "ptask_x", title: "Add thing", taskId: "ptask_x" });

    const create = calls.find((c) => c.args[0] === "pr" && c.args[1] === "create");
    expect(create?.args).toEqual([
      "pr",
      "create",
      "--head",
      "ptask_x",
      "--base",
      "main",
      "--title",
      "Add thing",
      "--body",
      "",
      "-R",
      "o/r",
    ]);
    expect(p.id).toBe("42");
    expect(p.number).toBe(42);
    expect(p.state).toBe("open");
    expect(p.approvedBy).toEqual(["alice"]);
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "42", number: 42, branch: "ptask_x", base: "main", taskId: "ptask_x" }),
    );
  });

  it("passes --draft and a custom base/body", async () => {
    const { runner, calls } = fakeRunner({
      "gh pr create": { stdout: "url" },
      "gh pr view": { stdout: PR_JSON },
    });
    const be = new GhRepoBackend({ runner });
    await be.openProposal({ repoPath: "/repo", branch: "b", title: "T", base: "develop", body: "hi", draft: true });
    const create = calls.find((c) => c.args[1] === "create");
    expect(create?.args).toContain("--draft");
    expect(create?.args.slice(create.args.indexOf("--base"), create.args.indexOf("--base") + 2)).toEqual([
      "--base",
      "develop",
    ]);
    expect(create?.args.slice(create.args.indexOf("--body"), create.args.indexOf("--body") + 2)).toEqual([
      "--body",
      "hi",
    ]);
  });

  it("throws when the PR can't be read back after create", async () => {
    const { runner } = fakeRunner({
      "gh pr create": { stdout: "url" },
      "gh pr view": () => {
        throw new Error("no PR");
      },
    });
    const be = new GhRepoBackend({ runner });
    await expect(be.openProposal({ repoPath: "/repo", branch: "b", title: "T" })).rejects.toThrow(
      /could not read it back/,
    );
  });
});

describe("GhRepoBackend.getProposalState", () => {
  it("maps gh JSON onto a normalized Proposal", async () => {
    const { runner, calls } = fakeRunner({ "gh pr view": { stdout: PR_JSON } });
    const be = new GhRepoBackend({ runner });
    const p = await be.getProposalState({ repoPath: "/repo", id: "42" });
    expect(p?.state).toBe("open");
    expect(p?.title).toBe("Add thing");
    expect(p?.url).toBe("https://github.com/o/r/pull/42");
    expect(calls[0].args).toEqual([
      "pr",
      "view",
      "42",
      "--json",
      "number,state,url,title,headRefName,baseRefName,isDraft,reviews",
    ]);
  });

  it("returns undefined when gh exits non-zero (no PR)", async () => {
    const { runner } = fakeRunner({
      "gh pr view": () => {
        throw new Error("no PR found");
      },
    });
    const be = new GhRepoBackend({ runner });
    expect(await be.getProposalState({ repoPath: "/repo", id: "999" })).toBeUndefined();
  });
});

describe("GhRepoBackend.mergeProposal", () => {
  it("merges with the chosen method and emits repo.proposal.merged", async () => {
    const merged = JSON.stringify({ number: 42, state: "MERGED", headRefName: "ptask_x", baseRefName: "main" });
    const { runner, calls } = fakeRunner({ "gh pr merge": {}, "gh pr view": { stdout: merged } });
    const events = new TypedEventBus();
    const onMerged = vi.fn();
    events.on("repo.proposal.merged", onMerged);
    const be = new GhRepoBackend({ runner, events });

    const p = await be.mergeProposal({
      repoPath: "/repo",
      id: "42",
      method: "squash",
      deleteBranch: true,
      taskId: "t1",
    });

    const merge = calls.find((c) => c.args[1] === "merge");
    expect(merge?.args).toEqual(["pr", "merge", "42", "--squash", "--delete-branch"]);
    expect(p.state).toBe("merged");
    expect(onMerged).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: "42", branch: "ptask_x", taskId: "t1" }),
    );
  });
});

describe("GhRepoBackend.closeProposal", () => {
  it("closes the PR and emits repo.proposal.closed", async () => {
    const closed = JSON.stringify({ number: 42, state: "CLOSED", headRefName: "ptask_x" });
    const { runner, calls } = fakeRunner({ "gh pr close": {}, "gh pr view": { stdout: closed } });
    const events = new TypedEventBus();
    const onClosed = vi.fn();
    events.on("repo.proposal.closed", onClosed);
    const be = new GhRepoBackend({ runner, events });

    await be.closeProposal({ repoPath: "/repo", id: "42" });
    expect(calls[0].args).toEqual(["pr", "close", "42"]);
    expect(onClosed).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "42", branch: "ptask_x" }));
  });
});

describe("mapPrJson", () => {
  it("treats an open draft as draft", () => {
    expect(mapPrJson({ number: 1, state: "OPEN", isDraft: true }).state).toBe("draft");
  });
  it("dedupes approver logins and ignores non-approvals", () => {
    const p = mapPrJson({
      number: 1,
      reviews: [
        { author: { login: "a" }, state: "APPROVED" },
        { author: { login: "a" }, state: "APPROVED" },
        { author: { login: "b" }, state: "CHANGES_REQUESTED" },
      ],
    });
    expect(p.approvedBy).toEqual(["a"]);
  });
  it("maps MERGED and CLOSED states", () => {
    expect(mapPrJson({ state: "MERGED" }).state).toBe("merged");
    expect(mapPrJson({ state: "CLOSED" }).state).toBe("closed");
  });
});
