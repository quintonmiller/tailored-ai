import { describe, expect, it } from "vitest";
import { GitHubTaskBackend } from "../tasks/github.js";

interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  user?: { login: string };
  assignees?: Array<{ login: string }>;
  labels: string[];
  created_at: string;
  updated_at: string;
}

interface CommentRow {
  id: number;
  body: string;
  user?: { login: string };
  created_at: string;
}

/**
 * Tiny in-memory GitHub stub. Implements only the Octokit endpoints the
 * backend actually calls. Returns shapes structurally compatible with the
 * real Octokit responses (`{ data: ... }`).
 */
interface LabelRow {
  name: string;
  color: string;
  description?: string;
}

class FakeOctokit {
  issues = new Map<number, IssueRow>();
  comments = new Map<number, CommentRow[]>();
  labels = new Map<string, LabelRow>();
  nextNumber = 1;
  nextCommentId = 1000;
  calls: string[] = [];

  rest = {
    issues: {
      create: async (p: { title: string; body?: string; labels?: string[]; assignees?: string[] }) => {
        this.calls.push("create");
        const issue: IssueRow = {
          number: this.nextNumber++,
          title: p.title,
          body: p.body ?? "",
          state: "open",
          user: { login: "creator" },
          assignees: p.assignees?.map((a) => ({ login: a })) ?? [],
          labels: p.labels ?? [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        this.issues.set(issue.number, issue);
        return { data: issue };
      },

      get: async (p: { issue_number: number }) => {
        this.calls.push(`get:${p.issue_number}`);
        const issue = this.issues.get(p.issue_number);
        if (!issue) {
          const err = new Error("Not Found") as Error & { status?: number };
          err.status = 404;
          throw err;
        }
        return { data: issue };
      },

      update: async (p: {
        issue_number: number;
        title?: string;
        body?: string;
        state?: "open" | "closed";
        labels?: string[];
        assignees?: string[];
      }) => {
        this.calls.push(`update:${p.issue_number}`);
        const issue = this.issues.get(p.issue_number);
        if (!issue) {
          const err = new Error("Not Found") as Error & { status?: number };
          err.status = 404;
          throw err;
        }
        if (p.title !== undefined) issue.title = p.title;
        if (p.body !== undefined) issue.body = p.body;
        if (p.state !== undefined) issue.state = p.state;
        if (p.labels !== undefined) issue.labels = p.labels;
        if (p.assignees !== undefined) issue.assignees = p.assignees.map((a) => ({ login: a }));
        issue.updated_at = new Date().toISOString();
        return { data: issue };
      },

      createComment: async (p: { issue_number: number; body: string }) => {
        const list = this.comments.get(p.issue_number) ?? [];
        const c: CommentRow = {
          id: this.nextCommentId++,
          body: p.body,
          user: { login: "commenter" },
          created_at: new Date().toISOString(),
        };
        list.push(c);
        this.comments.set(p.issue_number, list);
        return { data: c };
      },

      listComments: async (p: { issue_number: number }) => {
        return { data: this.comments.get(p.issue_number) ?? [] };
      },

      listLabelsForRepo: async () => {
        this.calls.push("listLabelsForRepo");
        return { data: [...this.labels.values()] };
      },

      createLabel: async (p: { name: string; color: string; description?: string }) => {
        this.calls.push(`createLabel:${p.name}`);
        if (this.labels.has(p.name)) {
          const err = new Error("already_exists") as Error & { status?: number };
          err.status = 422;
          throw err;
        }
        const row: LabelRow = { name: p.name, color: p.color, description: p.description };
        this.labels.set(p.name, row);
        return { data: row };
      },

      listForRepo: async (p: { state?: string; labels?: string; assignee?: string }) => {
        let issues = [...this.issues.values()];
        if (p.state && p.state !== "all") issues = issues.filter((i) => i.state === p.state);
        if (p.labels) {
          const required = p.labels.split(",");
          issues = issues.filter((i) => required.every((l) => i.labels.includes(l)));
        }
        if (p.assignee) issues = issues.filter((i) => i.assignees?.some((a) => a.login === p.assignee));
        return { data: issues };
      },
    },
  };
}

function build(): { backend: GitHubTaskBackend; oct: FakeOctokit } {
  const oct = new FakeOctokit();
  const backend = new GitHubTaskBackend({
    repo: "acme/widgets",
    token: "fake",
    octokit: oct as unknown as import("@octokit/rest").Octokit,
  });
  return { backend, oct };
}

describe("GitHubTaskBackend constructor", () => {
  it("rejects malformed repo string", () => {
    expect(() => new GitHubTaskBackend({ repo: "not-a-slash", token: "x" })).toThrow(/owner\/repo/);
  });
});

describe("GitHubTaskBackend status mapping", () => {
  it("declares its status enum", () => {
    const { backend } = build();
    expect(backend.statuses).toEqual({
      backlog: "backlog",
      inProgress: "in_progress",
      blocked: "blocked",
      done: "done",
    });
  });

  it("treats only 'done' as terminal", () => {
    const { backend } = build();
    expect(backend.isDone("done")).toBe(true);
    expect(backend.isDone("backlog")).toBe(false);
    expect(backend.isDone("in_progress")).toBe(false);
  });
});

describe("GitHubTaskBackend.create + get", () => {
  it("creates an open issue with status:backlog label and round-trips via get()", async () => {
    const { backend, oct } = build();
    const created = await backend.create({
      title: "Fix login",
      description: "Bug in auth",
      tags: ["bug", "ui"],
      status: "backlog",
      assignee: "alice",
    });
    expect(created.id).toMatch(/^gh-\d+$/);
    expect(created.title).toBe("Fix login");
    expect(created.status).toBe("backlog");
    expect(created.tags).toEqual(["bug", "ui"]);
    expect(created.assignee).toBe("alice");

    const fetched = await backend.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe("Fix login");
    expect(fetched?.comments).toEqual([]);

    // Status label is hidden from tags in the normalized Task shape.
    const issueLabels = oct.issues.get(1)?.labels ?? [];
    expect(issueLabels).toContain("status:backlog");
  });

  it("get() returns undefined for missing issues without throwing", async () => {
    const { backend } = build();
    expect(await backend.get("gh-9999")).toBeUndefined();
  });

  it("accepts bare numeric ids and #N forms in get()", async () => {
    const { backend } = build();
    await backend.create({ title: "T1" });
    expect(await backend.get("1")).toBeDefined();
    expect(await backend.get("#1")).toBeDefined();
    expect(await backend.get("gh-1")).toBeDefined();
  });
});

describe("GitHubTaskBackend agent-role assignees", () => {
  it("routes a coder assignment to an agent:coder label, not GH assignees", async () => {
    // Regression: TAI assigns code-shaped tasks to `assignee: "coder"`.
    // GitHub's assignees API 422s on unknown logins. The backend now
    // sends agent-role names through an `agent:<name>` label instead.
    const { backend, oct } = build();
    const t = await backend.create({
      title: "Implement login",
      assignee: "coder",
      status: "backlog",
    });
    const issue = oct.issues.get(1)!;
    expect(issue.assignees).toEqual([]);
    expect(issue.labels).toContain("agent:coder");
    // Round-trip: get() returns assignee="coder" via the label.
    expect(t.assignee).toBe("coder");
    const fetched = await backend.get(t.id);
    expect(fetched?.assignee).toBe("coder");
    // The label is hidden from the public tags list.
    expect(fetched?.tags).not.toContain("agent:coder");
  });

  it("still sends real GitHub usernames through the assignees API", async () => {
    const { backend, oct } = build();
    await backend.create({ title: "T", assignee: "alice" });
    expect(oct.issues.get(1)?.assignees?.map((a) => a.login)).toEqual(["alice"]);
    expect(oct.issues.get(1)?.labels).not.toContain("agent:alice");
  });

  it("reassigning from coder to a human swaps the label for a GH assignee", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T", assignee: "coder", status: "backlog" });
    expect(oct.issues.get(1)?.labels).toContain("agent:coder");
    await backend.update(t.id, { assignee: "alice" });
    const issue = oct.issues.get(1)!;
    expect(issue.assignees?.map((a) => a.login)).toEqual(["alice"]);
    expect(issue.labels).not.toContain("agent:coder");
  });

  it("filters query results by agent-role label when filter.assignee is a role", async () => {
    const { backend } = build();
    await backend.create({ title: "A", assignee: "coder", status: "backlog" });
    await backend.create({ title: "B", assignee: "reviewer", status: "backlog" });
    const r = await backend.query({ assignee: "coder", status: "backlog" });
    expect(r.tasks.map((t) => t.title)).toEqual(["A"]);
  });

  it("custom agentRoles option extends the default set", async () => {
    const oct = new FakeOctokit();
    const backend = new GitHubTaskBackend({
      repo: "owner/repo",
      token: "t",
      // biome-ignore lint/suspicious/noExplicitAny: stub.
      octokit: oct as any,
      agentRoles: ["coder", "reviewer", "my-custom-agent"],
    });
    await backend.create({ title: "T", assignee: "my-custom-agent" });
    expect(oct.issues.get(1)?.labels).toContain("agent:my-custom-agent");
    expect(oct.issues.get(1)?.assignees).toEqual([]);
  });
});

describe("GitHubTaskBackend.update", () => {
  it("updating status to done closes the issue", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1", status: "in_progress" });
    const updated = await backend.update(t.id, { status: "done" });
    expect(updated?.status).toBe("done");
    expect(oct.issues.get(1)?.state).toBe("closed");
  });

  it("updating tags replaces user labels but preserves status:* and reason:*", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1", tags: ["old"], status: "blocked" });
    await backend.update(t.id, { blocked_reason: "budget" });
    await backend.update(t.id, { tags: ["new1", "new2"] });
    const labels = oct.issues.get(1)?.labels ?? [];
    expect(labels).toContain("new1");
    expect(labels).toContain("new2");
    expect(labels).not.toContain("old");
    expect(labels).toContain("status:blocked");
    expect(labels).toContain("reason:budget");
  });
});

describe("GitHubTaskBackend.comment", () => {
  it("preserves agentName via [agent: name] prefix and strips it on get()", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1" });
    await backend.comment(t.id, "looking at it", "researcher");

    // Raw body in storage carries the prefix so it survives the GH user attribution.
    const stored = oct.comments.get(1)?.[0]?.body;
    expect(stored).toBe("[agent: researcher] looking at it");

    const fetched = await backend.get(t.id);
    expect(fetched?.comments?.length).toBe(1);
    expect(fetched?.comments?.[0].author).toBe("researcher");
    expect(fetched?.comments?.[0].content).toBe("looking at it");
  });

  it("falls back to GH commenter when no agentName is provided", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1" });
    await backend.comment(t.id, "plain comment");

    expect(oct.comments.get(1)?.[0]?.body).toBe("plain comment");
    const fetched = await backend.get(t.id);
    expect(fetched?.comments?.[0].author).toBe("commenter");
    expect(fetched?.comments?.[0].content).toBe("plain comment");
  });

  it("does not prefix when author is not a safe agent-name shape", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1" });
    // Spaces would break the regex round-trip; back off to plain.
    await backend.comment(t.id, "hi", "Some Person");
    expect(oct.comments.get(1)?.[0]?.body).toBe("hi");
  });

  it("strips a pre-existing [agent: name] prefix on read even if the comment was not posted by us", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1" });
    // Simulate a comment authored externally with the same prefix shape.
    oct.comments.set(1, [
      {
        id: 9999,
        body: "[agent: coder] manual entry",
        user: { login: "external" },
        created_at: new Date().toISOString(),
      },
    ]);
    const fetched = await backend.get(t.id);
    expect(fetched?.comments?.[0].author).toBe("coder");
    expect(fetched?.comments?.[0].content).toBe("manual entry");
  });
});

describe("GitHubTaskBackend.bootstrap", () => {
  it("creates the four status:* labels and reason:budget when missing", async () => {
    const { backend, oct } = build();
    const r = await backend.bootstrap();
    expect(r.created).toEqual([
      "status:backlog",
      "status:in_progress",
      "status:blocked",
      "status:in_review",
      "reason:budget",
    ]);
    expect(oct.labels.has("status:backlog")).toBe(true);
    expect(oct.labels.get("status:in_progress")?.color).toBe("1d76db");
  });

  it("is idempotent — re-running creates nothing new", async () => {
    const { backend, oct } = build();
    await backend.bootstrap();
    oct.calls.length = 0;
    const r = await backend.bootstrap();
    expect(r.created).toEqual([]);
    expect(oct.calls.filter((c) => c.startsWith("createLabel:"))).toEqual([]);
  });

  it("preserves pre-existing labels (only fills the gaps)", async () => {
    const { backend, oct } = build();
    oct.labels.set("status:backlog", { name: "status:backlog", color: "abcdef" });
    const r = await backend.bootstrap();
    expect(r.created).toEqual(["status:in_progress", "status:blocked", "status:in_review", "reason:budget"]);
    // Pre-existing label color was not overwritten.
    expect(oct.labels.get("status:backlog")?.color).toBe("abcdef");
  });

  it("swallows 422 'already exists' races during createLabel", async () => {
    const { backend, oct } = build();
    // Force createLabel to look like a race: label appears between list and create.
    const orig = oct.rest.issues.createLabel;
    let firstCall = true;
    oct.rest.issues.createLabel = async (p) => {
      if (firstCall) {
        firstCall = false;
        const err = new Error("already_exists") as Error & { status?: number };
        err.status = 422;
        throw err;
      }
      return orig.call(oct.rest.issues, p);
    };
    await expect(backend.bootstrap()).resolves.toEqual({
      created: ["status:in_progress", "status:blocked", "status:in_review", "reason:budget"],
    });
  });
});

describe("GitHubTaskBackend autopilot helpers", () => {
  it("nextBacklogTask picks the lowest-numbered backlog issue assigned to one of the agent names", async () => {
    const { backend } = build();
    await backend.create({ title: "A", assignee: "researcher", status: "backlog" });
    await backend.create({ title: "B", assignee: "coder", status: "backlog" });
    await backend.create({ title: "C", assignee: "researcher", status: "in_progress" });

    const next = await backend.nextBacklogTask(["researcher"]);
    expect(next?.title).toBe("A");

    const noMatch = await backend.nextBacklogTask(["nobody"]);
    expect(noMatch).toBeUndefined();
  });

  it("claimBacklog only succeeds when the issue is currently backlog", async () => {
    const { backend, oct } = build();
    const t = await backend.create({ title: "T1", assignee: "a", status: "backlog" });
    const claimed = await backend.claimBacklog(t.id);
    expect(claimed?.status).toBe("in_progress");
    expect(oct.issues.get(1)?.labels).toContain("status:in_progress");

    // Second claim is a no-op.
    expect(await backend.claimBacklog(t.id)).toBeUndefined();
  });

  it("unblockBudgetTasks only restores issues with status:blocked + reason:budget", async () => {
    const { backend, oct } = build();
    const a = await backend.create({ title: "A", status: "blocked" });
    await backend.update(a.id, { blocked_reason: "budget" });
    const b = await backend.create({ title: "B", status: "blocked" });
    await backend.update(b.id, { blocked_reason: "manual" });

    const restored = await backend.unblockBudgetTasks();
    expect(restored).toBe(1);

    expect((await backend.get(a.id))?.status).toBe("backlog");
    expect(oct.issues.get(1)?.labels).not.toContain("reason:budget");
    expect((await backend.get(b.id))?.status).toBe("blocked");
  });
});
