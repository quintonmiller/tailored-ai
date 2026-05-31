import { describe, expect, it } from "vitest";
import { type BeadsRunner, BeadsTaskBackend } from "../tasks/beads.js";

interface IssueRow {
  id: string;
  title: string;
  description: string;
  status: string;
  type: string;
  priority?: number;
  owner?: string | null;
  labels: string[];
  blocked_reason?: string | null;
  comments: Array<{ id: string; author: string; body: string; created_at: string }>;
  created_at: string;
  updated_at: string;
}

class FakeBeads {
  issues = new Map<string, IssueRow>();
  nextId = 1;
  calls: string[][] = [];

  runner: BeadsRunner = async (args) => {
    this.calls.push([...args]);
    if (args[0] === "--db") args = args.slice(2);
    const [cmd, sub, ...rest] = args;
    if (cmd === "create") return this.create([sub, ...rest]);
    if (cmd === "show") return this.show([sub, ...rest]);
    if (cmd === "list") return this.list([sub, ...rest]);
    if (cmd === "ready") return this.ready([sub, ...rest]);
    if (cmd === "update") return this.update([sub, ...rest]);
    if (cmd === "edit") return this.edit([sub, ...rest]);
    if (cmd === "close") return this.close([sub, ...rest]);
    if (cmd === "reopen") return this.reopen([sub, ...rest]);
    if (cmd === "set-state") return this.setState([sub, ...rest]);
    if (cmd === "comment" && sub === "add") return this.commentAdd(rest);
    if (cmd === "label" && (sub === "add" || sub === "remove")) return this.label(sub, rest);
    return { exitCode: 1, stdout: "", stderr: `unknown command: ${cmd}` };
  };

  private create(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const title = rest[0];
    const flags = parseFlags(rest.slice(1));
    const id = `bd-${String(this.nextId++).padStart(4, "0")}`;
    const labels = (flags.string["-l"] ?? "").split(",").filter(Boolean);
    const issue: IssueRow = {
      id,
      title,
      description: flags.string["-d"] ?? "",
      status: "open",
      type: flags.string["-t"] ?? "task",
      labels,
      comments: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.issues.set(id, issue);
    return ok(issue);
  }

  private show(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    return ok(issue);
  }

  private list(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const flags = parseFlags(rest);
    let issues = [...this.issues.values()];
    const wantStatuses = flags.array["--status"];
    if (wantStatuses && wantStatuses.length > 0) {
      issues = issues.filter((i) => wantStatuses.includes(i.status));
    }
    const wantAssignee = flags.string["--assignee"];
    if (wantAssignee) issues = issues.filter((i) => i.owner === wantAssignee);
    const wantLabel = flags.string["--label"];
    if (wantLabel) {
      const labels = wantLabel.split(",");
      issues = issues.filter((i) => labels.every((l) => i.labels.includes(l)));
    }
    return ok(issues);
  }

  private ready(_rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    // Beads "ready" returns unblocked + open issues.
    const issues = [...this.issues.values()].filter((i) => i.status === "open");
    return ok(issues);
  }

  private update(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const flags = parseFlags(rest.slice(1));
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    if ("--claim" in flags.bool) {
      issue.owner = flags.string["--actor"] ?? "current-user";
    }
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }

  private edit(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const flags = parseFlags(rest.slice(1));
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    if (flags.string["--title"]) issue.title = flags.string["--title"];
    if (flags.string["--description"] !== undefined) issue.description = flags.string["--description"];
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }

  private close(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    issue.status = "closed";
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }

  private reopen(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    if (issue.status !== "closed") return { exitCode: 1, stdout: "", stderr: "issue is not closed" };
    issue.status = "open";
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }

  private setState(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const newState = rest[1];
    const flags = parseFlags(rest.slice(2));
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    issue.status = newState;
    if (flags.string["--reason"] && newState === "blocked") {
      issue.blocked_reason = flags.string["--reason"];
    }
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }

  private commentAdd(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const body = rest[1];
    const flags = parseFlags(rest.slice(2));
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    const comment = {
      id: `c-${issue.comments.length + 1}`,
      author: flags.string["--actor"] ?? "",
      body,
      created_at: new Date().toISOString(),
    };
    issue.comments.push(comment);
    return { exitCode: 0, stdout: JSON.stringify(comment), stderr: "" };
  }

  private label(action: string, rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const label = rest[1];
    const issue = this.issues.get(id);
    if (!issue) return notFound();
    if (action === "add" && !issue.labels.includes(label)) issue.labels.push(label);
    if (action === "remove") issue.labels = issue.labels.filter((l) => l !== label);
    issue.updated_at = new Date().toISOString();
    return ok(issue);
  }
}

interface ParsedFlags {
  string: Record<string, string | undefined>;
  array: Record<string, string[] | undefined>;
  bool: Record<string, boolean>;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { string: {}, array: {}, bool: {} };
  const arrayFlags = new Set(["--status", "--label"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) continue;
    if (a === "--json" || a === "--claim") {
      out.bool[a] = true;
      continue;
    }
    if (i + 1 < args.length) {
      const v = args[i + 1];
      if (arrayFlags.has(a)) (out.array[a] ??= []).push(v);
      out.string[a] = v;
      i++;
    }
  }
  return out;
}

function ok(payload: unknown): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
}

function notFound(): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 1, stdout: "", stderr: "not found" };
}

function build(): { backend: BeadsTaskBackend; fake: FakeBeads } {
  const fake = new FakeBeads();
  const backend = new BeadsTaskBackend({ runner: fake.runner });
  return { backend, fake };
}

describe("BeadsTaskBackend status mapping", () => {
  it("declares its normalized status enum and 'deferred' as an extra", () => {
    const { backend } = build();
    expect(backend.statuses).toEqual({
      backlog: "backlog",
      inProgress: "in_progress",
      blocked: "blocked",
      done: "done",
    });
    expect(backend.extraStatuses).toEqual(["deferred"]);
  });

  it("treats only 'done' as terminal", () => {
    const { backend } = build();
    expect(backend.isDone("done")).toBe(true);
    expect(backend.isDone("blocked")).toBe(false);
  });

  it("maps backlog↔open, in_progress, blocked, done↔closed natively", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1" });
    expect(fake.issues.get(t.id)?.status).toBe("open");
    expect(t.status).toBe("backlog");

    await backend.update(t.id, { status: "in_progress" });
    expect(fake.issues.get(t.id)?.status).toBe("in_progress");

    await backend.update(t.id, { status: "blocked", blocked_reason: "budget" });
    expect(fake.issues.get(t.id)?.status).toBe("blocked");
    expect(fake.issues.get(t.id)?.blocked_reason).toBe("budget");

    const done = await backend.update(t.id, { status: "done" });
    expect(fake.issues.get(t.id)?.status).toBe("closed");
    expect(done?.status).toBe("done");
  });
});

describe("BeadsTaskBackend.create + get", () => {
  it("round-trips title, description, tags, and assignee", async () => {
    const { backend, fake } = build();
    const created = await backend.create({
      title: "Fix auth",
      description: "broken",
      tags: ["bug", "auth"],
      assignee: "researcher",
    });
    expect(created.title).toBe("Fix auth");
    expect(created.description).toBe("broken");
    expect(created.tags).toEqual(["bug", "auth"]);
    expect(created.assignee).toBe("researcher");
    expect(fake.issues.get(created.id)?.owner).toBe("researcher");
  });

  it("get returns undefined for missing ids", async () => {
    const { backend } = build();
    expect(await backend.get("bd-9999")).toBeUndefined();
  });
});

describe("BeadsTaskBackend.update", () => {
  it("uses bd edit for title/description and bd label for labels", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1", tags: ["old"] });
    await backend.update(t.id, { title: "T1-renamed", tags: ["new1", "new2"] });
    const issue = fake.issues.get(t.id);
    expect(issue?.title).toBe("T1-renamed");
    expect(issue?.labels).toEqual(["new1", "new2"]);
  });
});

describe("BeadsTaskBackend.delete", () => {
  it("closes the issue with reason 'deleted'", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1" });
    expect(await backend.delete(t.id)).toBe(true);
    expect(fake.issues.get(t.id)?.status).toBe("closed");
  });

  it("returns false for missing ids", async () => {
    const { backend } = build();
    expect(await backend.delete("bd-9999")).toBe(false);
  });
});

describe("BeadsTaskBackend.comment", () => {
  it("posts a comment via bd comment add and surfaces it via get()", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1" });
    const c = await backend.comment(t.id, "looking at it", "alice");
    expect(c?.author).toBe("alice");
    expect(c?.content).toBe("looking at it");

    expect(fake.issues.get(t.id)?.comments[0].body).toBe("looking at it");

    const fetched = await backend.get(t.id);
    expect(fetched?.comments?.length).toBe(1);
    expect(fetched?.comments?.[0].content).toBe("looking at it");
  });
});

describe("BeadsTaskBackend autopilot helpers", () => {
  it("nextBacklogTask picks the first ready issue assigned to one of the agents", async () => {
    const { backend } = build();
    const a = await backend.create({ title: "A", assignee: "researcher" });
    await backend.create({ title: "B", assignee: "coder" });

    const next = await backend.nextBacklogTask(["researcher"]);
    expect(next?.id).toBe(a.id);

    expect(await backend.nextBacklogTask(["nobody"])).toBeUndefined();
  });

  it("claimBacklog claims via bd update --claim then transitions to in_progress", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1" });
    const claimed = await backend.claimBacklog(t.id);
    expect(claimed?.status).toBe("in_progress");
    expect(fake.issues.get(t.id)?.status).toBe("in_progress");

    // Second claim is a no-op.
    expect(await backend.claimBacklog(t.id)).toBeUndefined();
  });

  it("unblockBudgetTasks restores blocked + budget-labeled issues to open", async () => {
    const { backend, fake } = build();
    const a = await backend.create({ title: "A", tags: ["budget"] });
    await backend.update(a.id, { status: "blocked", blocked_reason: "budget" });
    const b = await backend.create({ title: "B" });
    await backend.update(b.id, { status: "blocked", blocked_reason: "manual" });

    const restored = await backend.unblockBudgetTasks();
    expect(restored).toBe(1);

    expect(fake.issues.get(a.id)?.status).toBe("open");
    expect(fake.issues.get(b.id)?.status).toBe("blocked");
  });
});
