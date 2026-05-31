import { describe, expect, it } from "vitest";
import { type BeansRunner, BeansTaskBackend } from "../tasks/beans.js";

interface BeanRow {
  id: string;
  title: string;
  status: string;
  type: string;
  priority?: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  body?: string;
  etag?: string;
}

/**
 * Tiny in-memory beans CLI stub. Implements only the subcommands the backend
 * exercises, with arg-shape parsing that mirrors the real CLI's flag set
 * closely enough for the backend's purposes.
 */
class FakeBeans {
  beans = new Map<string, BeanRow>();
  nextId = 1;
  calls: string[][] = [];

  runner: BeansRunner = async (args) => {
    this.calls.push([...args]);
    // Strip --beans-path <path> if present.
    if (args[0] === "--beans-path") args = args.slice(2);
    const [cmd, ...rest] = args;
    if (cmd === "create") return this.create(rest);
    if (cmd === "show") return this.show(rest);
    if (cmd === "update") return this.update(rest);
    if (cmd === "delete") return this.delete(rest);
    if (cmd === "list") return this.list(rest);
    return { exitCode: 1, stdout: "", stderr: `unknown command: ${cmd}` };
  };

  private create(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const title = rest[0];
    const flags = parseFlags(rest.slice(1));
    const id = `test-${String(this.nextId++).padStart(4, "0")}`;
    const row: BeanRow = {
      id,
      title,
      status: flags.string["-s"] ?? "todo",
      type: flags.string["-t"] ?? "task",
      priority: flags.string["-p"],
      tags: flags.array["--tag"] ?? [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      body: flags.string["-d"] ?? "",
      etag: hashEtag(id, "0"),
    };
    this.beans.set(id, row);
    return { exitCode: 0, stdout: JSON.stringify(row), stderr: "" };
  }

  private show(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const row = this.beans.get(id);
    if (!row) return { exitCode: 1, stdout: "", stderr: "not found" };
    return { exitCode: 0, stdout: JSON.stringify(row), stderr: "" };
  }

  private update(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    const row = this.beans.get(id);
    if (!row) return { exitCode: 1, stdout: "", stderr: "not found" };
    const flags = parseFlags(rest.slice(1));

    if (flags.string["--if-match"] && flags.string["--if-match"] !== row.etag) {
      return { exitCode: 2, stdout: "", stderr: "etag mismatch (precondition failed)" };
    }

    if (flags.string["--title"]) row.title = flags.string["--title"];
    if (flags.string["-d"] !== undefined) row.body = flags.string["-d"];
    if (flags.string["-s"]) row.status = flags.string["-s"];
    if (flags.string["--body-append"]) row.body = (row.body ?? "") + flags.string["--body-append"];

    const tagsToRemove = new Set(flags.array["--remove-tag"] ?? []);
    const tagsToAdd = flags.array["--tag"] ?? [];
    row.tags = [...row.tags.filter((t) => !tagsToRemove.has(t)), ...tagsToAdd.filter((t) => !row.tags.includes(t))];

    row.updated_at = new Date().toISOString();
    row.etag = hashEtag(id, row.updated_at);
    return { exitCode: 0, stdout: JSON.stringify(row), stderr: "" };
  }

  private delete(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const id = rest[0];
    if (!this.beans.delete(id)) return { exitCode: 1, stdout: "", stderr: "not found" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  private list(rest: string[]): { exitCode: number; stdout: string; stderr: string } {
    const flags = parseFlags(rest);
    let beans = [...this.beans.values()];
    const statuses = flags.array["-s"];
    if (statuses && statuses.length > 0) beans = beans.filter((b) => statuses.includes(b.status));
    const tagFilter = flags.array["--tag"];
    if (tagFilter && tagFilter.length > 0) {
      // OR semantics, matching real beans CLI.
      beans = beans.filter((b) => tagFilter.some((t) => b.tags.includes(t)));
    }
    if ("--ready" in flags.bool) {
      beans = beans.filter((b) => !["in-progress", "completed", "scrapped", "draft"].includes(b.status));
    }
    return { exitCode: 0, stdout: JSON.stringify(beans), stderr: "" };
  }
}

interface ParsedFlags {
  string: Record<string, string | undefined>;
  array: Record<string, string[] | undefined>;
  bool: Record<string, boolean>;
}

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = { string: {}, array: {}, bool: {} };
  const arrayFlags = new Set(["--tag", "--remove-tag", "-s", "-p"]);
  // For list, `-s` is array; for create/update, `-s` is string. We handle this by
  // populating BOTH on `-s` so the calling code can pick what it wants.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--full" || a === "--ready" || a === "--yes") {
      out.bool[a] = true;
      continue;
    }
    if (a.startsWith("-") && i + 1 < args.length && !args[i + 1].startsWith("-")) {
      const v = args[i + 1];
      if (arrayFlags.has(a)) {
        (out.array[a] ??= []).push(v);
      }
      out.string[a] = v;
      i++;
    }
  }
  return out;
}

function hashEtag(id: string, salt: string): string {
  let h = 0;
  const s = `${id}|${salt}`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `etag-${(h >>> 0).toString(16)}`;
}

function build(): { backend: BeansTaskBackend; fake: FakeBeans } {
  const fake = new FakeBeans();
  const backend = new BeansTaskBackend({ runner: fake.runner });
  return { backend, fake };
}

describe("BeansTaskBackend status mapping", () => {
  it("declares the normalized status enum and beans-native extras", () => {
    const { backend } = build();
    expect(backend.statuses).toEqual({
      backlog: "backlog",
      inProgress: "in_progress",
      blocked: "blocked",
      done: "done",
    });
    expect(backend.extraStatuses).toEqual(["draft", "scrapped"]);
  });

  it("maps backlog↔todo, in_progress↔in-progress, done↔completed", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1", status: "backlog" });
    expect(fake.beans.get(t.id)?.status).toBe("todo");
    expect(t.status).toBe("backlog");

    const t2 = await backend.create({ title: "T2", status: "in_progress" });
    expect(fake.beans.get(t2.id)?.status).toBe("in-progress");
    expect(t2.status).toBe("in_progress");

    const updated = await backend.update(t.id, { status: "done" });
    expect(fake.beans.get(t.id)?.status).toBe("completed");
    expect(updated?.status).toBe("done");
  });

  it("maps blocked → todo + status:blocked tag, with reason on a separate tag", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1", status: "blocked" });
    expect(fake.beans.get(t.id)?.status).toBe("todo");
    expect(fake.beans.get(t.id)?.tags).toContain("status:blocked");
    expect(t.status).toBe("blocked");

    const updated = await backend.update(t.id, { blocked_reason: "budget" });
    expect(fake.beans.get(t.id)?.tags).toContain("reason:budget");
    expect(updated?.blocked_reason).toBe("budget");
  });
});

describe("BeansTaskBackend.create + get", () => {
  it("round-trips title, description, tags, and assignee", async () => {
    const { backend, fake } = build();
    const created = await backend.create({
      title: "Fix login",
      description: "Auth bug",
      tags: ["ui", "bug"],
      assignee: "researcher",
    });
    expect(created.title).toBe("Fix login");
    expect(created.description).toBe("Auth bug");
    expect(created.tags).toEqual(["ui", "bug"]);
    expect(created.assignee).toBe("researcher");

    // Assignee is stored as a managed tag, hidden from `tags`.
    expect(fake.beans.get(created.id)?.tags).toContain("assignee:researcher");

    const fetched = await backend.get(created.id);
    expect(fetched?.title).toBe("Fix login");
    expect(fetched?.assignee).toBe("researcher");
    expect(fetched?.tags).toEqual(["ui", "bug"]);
  });

  it("get() returns undefined for missing beans", async () => {
    const { backend } = build();
    expect(await backend.get("nope-9999")).toBeUndefined();
  });
});

describe("BeansTaskBackend.update", () => {
  it("replaces user tags but preserves managed assignee/status:* tags", async () => {
    const { backend, fake } = build();
    const t = await backend.create({
      title: "T1",
      tags: ["old"],
      assignee: "alice",
      status: "blocked",
    });
    await backend.update(t.id, { tags: ["new1", "new2"] });
    const stored = fake.beans.get(t.id)?.tags ?? [];
    expect(stored).toContain("new1");
    expect(stored).toContain("new2");
    expect(stored).not.toContain("old");
    expect(stored).toContain("assignee:alice");
    expect(stored).toContain("status:blocked");
  });
});

describe("BeansTaskBackend.comment", () => {
  it("appends a parseable block to body and round-trips via get()", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1", description: "Original body." });
    const c = await backend.comment(t.id, "looking at it", "researcher");
    expect(c?.author).toBe("researcher");
    expect(c?.content).toBe("looking at it");

    const stored = fake.beans.get(t.id)?.body ?? "";
    expect(stored).toContain("<!-- beans-comment");
    expect(stored).toContain("looking at it");

    const fetched = await backend.get(t.id);
    expect(fetched?.description).toBe("Original body.");
    expect(fetched?.comments?.length).toBe(1);
    expect(fetched?.comments?.[0].content).toBe("looking at it");
    expect(fetched?.comments?.[0].author).toBe("researcher");
  });
});

describe("BeansTaskBackend autopilot helpers", () => {
  it("nextBacklogTask picks the first --ready bean assigned to one of the agents", async () => {
    const { backend } = build();
    await backend.create({ title: "A", assignee: "researcher", status: "backlog" });
    await backend.create({ title: "B", assignee: "coder", status: "backlog" });
    await backend.create({ title: "C", assignee: "researcher", status: "in_progress" });

    const next = await backend.nextBacklogTask(["researcher"]);
    expect(next?.title).toBe("A");

    expect(await backend.nextBacklogTask(["nobody"])).toBeUndefined();
  });

  it("claimBacklog moves backlog → in-progress and is a no-op on second call", async () => {
    const { backend, fake } = build();
    const t = await backend.create({ title: "T1", assignee: "a", status: "backlog" });
    const claimed = await backend.claimBacklog(t.id);
    expect(claimed?.status).toBe("in_progress");
    expect(fake.beans.get(t.id)?.status).toBe("in-progress");

    expect(await backend.claimBacklog(t.id)).toBeUndefined();
  });

  it("unblockBudgetTasks restores beans tagged status:blocked + reason:budget back to backlog", async () => {
    const { backend, fake } = build();
    const a = await backend.create({ title: "A", status: "blocked" });
    await backend.update(a.id, { blocked_reason: "budget" });
    const b = await backend.create({ title: "B", status: "blocked" });
    await backend.update(b.id, { blocked_reason: "manual" });

    const restored = await backend.unblockBudgetTasks();
    expect(restored).toBe(1);

    const aRow = fake.beans.get(a.id);
    expect(aRow?.tags).not.toContain("status:blocked");
    expect(aRow?.tags).not.toContain("reason:budget");

    const bRow = fake.beans.get(b.id);
    expect(bRow?.tags).toContain("status:blocked");
    expect(bRow?.tags).toContain("reason:manual");
  });
});

describe("BeansTaskBackend.delete", () => {
  it("removes the bean and reports false for missing ids", async () => {
    const { backend } = build();
    const t = await backend.create({ title: "T1" });
    expect(await backend.delete(t.id)).toBe(true);
    expect(await backend.delete("missing-9999")).toBe(false);
  });
});

describe("BeansTaskBackend.query", () => {
  it("filters by normalized status, including blocked-via-tag", async () => {
    const { backend } = build();
    await backend.create({ title: "A", status: "backlog" });
    await backend.create({ title: "B", status: "blocked" });
    await backend.create({ title: "C", status: "in_progress" });

    const blocked = await backend.query({ status: "blocked" });
    expect(blocked.tasks.map((t) => t.title)).toEqual(["B"]);

    const backlog = await backend.query({ status: "backlog" });
    expect(backlog.tasks.map((t) => t.title)).toEqual(["A"]);
  });
});
