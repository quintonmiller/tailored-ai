import { execFile } from "node:child_process";
import type {
  Task,
  TaskBackend,
  TaskComment,
  TaskCreateInput,
  TaskFilter,
  TaskQueryResult,
  TaskStatusMap,
  TaskUpdateInput,
} from "./interface.js";
import { assigneeNames, matchesAssignee } from "./interface.js";

/**
 * Beads (https://github.com/steveyegge/beads) task backend. Shells out to
 * the `bd` CLI.
 *
 * Status mapping (normalized → beads):
 *   backlog       → open
 *   in_progress   → in_progress
 *   blocked       → blocked
 *   done          → closed
 *
 * Notes / known limitations
 * --------------------------
 * - `bd update` is narrow (priority, claim, external-ref); title and
 *   description edits go through `bd edit`. We pipe descriptions in via
 *   `bd edit --description-stdin`.
 * - Status transitions go through `bd close`, `bd reopen`, and
 *   `bd set-state --reason`. We always pass a reason, falling back to a
 *   generic one.
 * - Comments: `bd comment add` is the documented surface; on read we
 *   surface raw comments from `--json` if present.
 * - Beads has no per-issue delete in the public CLI. `delete()` closes
 *   the issue with reason "deleted" and reports success.
 * - There's no surfaced etag/version. `claimBacklog` uses `bd update --claim`
 *   for atomic ownership (the documented race-safe primitive).
 * - Beads uses Dolt as its store, not markdown — `bd init` must have been
 *   run before this backend will work.
 */

const STATUSES: TaskStatusMap = {
  backlog: "backlog",
  inProgress: "in_progress",
  blocked: "blocked",
  done: "done",
};

const DEFAULT_REASON = "task backend update";

export type BeadsRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface BeadsBackendOptions {
  /** Path to the beads .beads dir (passed via --db). Optional. */
  db?: string;
  /** beads CLI binary name. Default "bd". */
  bin?: string;
  /** Default issue type when creating tasks. Default "task". */
  type?: string;
  /** Inject a runner for tests. */
  runner?: BeadsRunner;
}

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status: string;
  type?: string;
  priority?: number;
  owner?: string | null;
  labels?: string[];
  created_at?: string;
  updated_at?: string;
  comments?: Array<{ id?: string | number; author?: string; body?: string; created_at?: string }>;
  blocked_reason?: string | null;
}

export class BeadsTaskBackend implements TaskBackend {
  readonly name = "beads";
  readonly statuses = STATUSES;
  readonly extraStatuses = ["deferred"] as const;

  private bin: string;
  private db?: string;
  private type: string;
  private run: BeadsRunner;

  constructor(opts: BeadsBackendOptions = {}) {
    this.bin = opts.bin ?? "bd";
    this.db = opts.db;
    this.type = opts.type ?? "task";
    this.run = opts.runner ?? defaultRunner(this.bin);
  }

  isDone(status: string): boolean {
    return status === "done";
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const args = ["create", input.title, "-t", this.type, "--json"];
    if (input.description) args.push("-d", input.description);
    if (input.tags && input.tags.length > 0) args.push("-l", input.tags.join(","));

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      throw new Error(`bd create failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const issue = parseIssue(r.stdout);

    // Post-create: set assignee via claim, status if not the default.
    if (input.assignee) {
      await this.runArgs(["update", issue.id, "--claim", "--actor", input.assignee, "--json"]);
    }
    if (input.status && input.status !== "backlog") {
      await this.transitionStatus(issue.id, input.status, undefined);
    }

    const fresh = await this.fetch(issue.id);
    return toTask(fresh ?? issue);
  }

  async get(id: string): Promise<Task | undefined> {
    const issue = await this.fetch(id);
    if (!issue) return undefined;
    return toTask(issue);
  }

  async update(id: string, patch: TaskUpdateInput): Promise<Task | undefined> {
    const current = await this.fetch(id);
    if (!current) return undefined;

    if (patch.title !== undefined || patch.description !== undefined) {
      const args = ["edit", id, "--json"];
      if (patch.title !== undefined) args.push("--title", patch.title);
      if (patch.description !== undefined) args.push("--description", patch.description);
      const r = await this.runArgs(args);
      if (r.exitCode !== 0 && !isNotFound(r)) {
        throw new Error(`bd edit failed: ${(r.stderr || r.stdout).trim()}`);
      }
    }

    if (patch.tags !== undefined) {
      const existing = new Set(current.labels ?? []);
      const wanted = new Set(patch.tags);
      for (const l of existing) {
        if (!wanted.has(l)) await this.runArgs(["label", "remove", id, l, "--json"]);
      }
      for (const l of wanted) {
        if (!existing.has(l)) await this.runArgs(["label", "add", id, l, "--json"]);
      }
    }

    if (patch.assignee !== undefined) {
      if (patch.assignee) {
        await this.runArgs(["update", id, "--claim", "--actor", patch.assignee, "--json"]);
      }
      // No documented "unassign" primitive; leaving owner in place is safer
      // than guessing.
    }

    if (patch.status !== undefined) {
      await this.transitionStatus(id, patch.status, patch.blocked_reason ?? undefined);
    } else if (patch.blocked_reason !== undefined && current.status === "blocked") {
      // Update the reason without changing status.
      await this.transitionStatus(id, "blocked", patch.blocked_reason ?? undefined);
    }

    const fresh = await this.fetch(id);
    return fresh ? toTask(fresh) : undefined;
  }

  /**
   * Beads has no per-issue delete in the public CLI. Closes the issue with
   * reason "deleted" instead, mirroring how the GitHub backend handles it.
   */
  async delete(id: string): Promise<boolean> {
    const r = await this.runArgs(["close", id, "--reason", "deleted", "--json"]);
    if (r.exitCode === 0) return true;
    if (isNotFound(r)) return false;
    throw new Error(`bd close (delete) failed: ${(r.stderr || r.stdout).trim()}`);
  }

  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    const args = ["comment", "add", id, content, "--json"];
    if (author) args.push("--actor", author);
    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      if (isNotFound(r)) return undefined;
      throw new Error(`bd comment add failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const created_at = new Date().toISOString();
    return {
      id: tryParseCommentId(r.stdout) ?? created_at,
      task_id: id,
      author: author ?? "",
      content,
      created_at,
    };
  }

  async query(filter?: TaskFilter): Promise<TaskQueryResult> {
    const args = ["list", "--json"];

    if (filter?.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const s of list) {
        const native = toBeadsStatus(s);
        if (native) args.push("--status", native);
      }
    }
    // beads takes a single `--assignee`, with no way to say "nobody" or "any of
    // these". Push it down only when it is exactly one name — otherwise let the
    // list come back wide and narrow it below. Narrowing after the fact is
    // always safe; a filter silently dropped is not.
    const wantedAssignees = assigneeNames(filter?.assignee);
    const canPushDown = wantedAssignees.length === 1 && !Array.isArray(filter?.assignee);
    if (canPushDown) args.push("--assignee", wantedAssignees[0]);
    if (filter?.tags && filter.tags.length > 0) args.push("--label", filter.tags.join(","));
    if (filter?.search) args.push("--title-contains", filter.search);
    if (filter?.updatedAfter) args.push("--updated-after", filter.updatedAfter);

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      throw new Error(`bd list failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const issues = JSON.parse(r.stdout || "[]") as BeadsIssue[];
    let tasks = issues.map(toTask);

    // Unconditional, even when the filter was pushed down: it costs nothing and
    // it means the answer is right whatever `bd list` decided to do with it.
    if (filter?.assignee !== undefined) tasks = tasks.filter((t) => matchesAssignee(t.assignee, filter.assignee));

    if (filter?.search) {
      const needle = filter.search.toLowerCase();
      tasks = tasks.filter(
        (t) => t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle),
      );
    }

    const total = tasks.length;
    if (filter?.offset) tasks = tasks.slice(filter.offset);
    if (filter?.limit !== undefined) tasks = tasks.slice(0, filter.limit);

    return { tasks, total };
  }

  async nextBacklogTask(assignees: string[]): Promise<Task | undefined> {
    if (assignees.length === 0) return undefined;
    const r = await this.runArgs(["ready", "--json", "--limit", "50"]);
    if (r.exitCode !== 0) {
      throw new Error(`bd ready failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const issues = JSON.parse(r.stdout || "[]") as BeadsIssue[];
    const set = new Set(assignees);
    for (const issue of issues) {
      if (issue.status !== "open") continue;
      if (issue.owner && set.has(issue.owner)) return toTask(issue);
    }
    return undefined;
  }

  async claimBacklog(id: string): Promise<Task | undefined> {
    const current = await this.fetch(id);
    if (!current) return undefined;
    if (current.status !== "open") return undefined;

    // `bd update --claim` is the documented atomic-claim primitive. We then
    // transition to in_progress to match the autopilot's contract.
    const claim = await this.runArgs(["update", id, "--claim", "--json"]);
    if (claim.exitCode !== 0) {
      if (isNotFound(claim)) return undefined;
      // Race lost (someone else claimed first). Don't throw — just signal.
      return undefined;
    }
    await this.transitionStatus(id, "in_progress", "claimed by autopilot");
    const fresh = await this.fetch(id);
    return fresh ? toTask(fresh) : undefined;
  }

  async unblockBudgetTasks(): Promise<number> {
    const r = await this.runArgs(["list", "--status", "blocked", "--label", "budget", "--json"]);
    if (r.exitCode !== 0) return 0;
    const issues = JSON.parse(r.stdout || "[]") as BeadsIssue[];

    let restored = 0;
    for (const issue of issues) {
      // Re-filter (defensive: the CLI may interpret label sets as OR).
      if (!(issue.labels ?? []).includes("budget")) continue;
      const ok = await this.transitionStatus(issue.id, "backlog", "budget restored");
      if (ok) restored++;
    }
    return restored;
  }

  // ---- internal helpers ----

  private async fetch(id: string): Promise<BeadsIssue | undefined> {
    const r = await this.runArgs(["show", id, "--json"]);
    if (r.exitCode !== 0) return undefined;
    try {
      const parsed = JSON.parse(r.stdout) as BeadsIssue | BeadsIssue[];
      // `bd show` may return an array when given multiple ids, or a single
      // object for a single id.
      const single = Array.isArray(parsed) ? parsed[0] : parsed;
      return single?.id ? single : undefined;
    } catch {
      return undefined;
    }
  }

  private async transitionStatus(id: string, normalized: string, reason: string | undefined): Promise<boolean> {
    const native = toBeadsStatus(normalized);
    if (!native) return false;
    const reasonText = reason ?? DEFAULT_REASON;

    if (native === "closed") {
      const r = await this.runArgs(["close", id, "--reason", reasonText, "--json"]);
      return r.exitCode === 0;
    }
    if (native === "open") {
      // From closed → open uses reopen; from any other → open uses set-state.
      const reopen = await this.runArgs(["reopen", id, "--reason", reasonText, "--json"]);
      if (reopen.exitCode === 0) return true;
    }
    const r = await this.runArgs(["set-state", id, native, "--reason", reasonText, "--json"]);
    return r.exitCode === 0;
  }

  private async runArgs(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const prefix = this.db ? ["--db", this.db] : [];
    return this.run([...prefix, ...args]);
  }
}

// ---- helpers ----

function toBeadsStatus(normalized: string): string | undefined {
  switch (normalized) {
    case "backlog":
      return "open";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "done":
      return "closed";
    case "deferred":
      return "deferred";
    default:
      return undefined;
  }
}

function fromBeadsStatus(native: string): string {
  switch (native) {
    case "open":
      return "backlog";
    case "in_progress":
      return "in_progress";
    case "blocked":
      return "blocked";
    case "closed":
      return "done";
    case "deferred":
      return "deferred";
    default:
      return native;
  }
}

function parseIssue(stdout: string): BeadsIssue {
  return JSON.parse(stdout) as BeadsIssue;
}

function tryParseCommentId(stdout: string): string | number | undefined {
  try {
    const parsed = JSON.parse(stdout) as { id?: string | number };
    return parsed?.id;
  } catch {
    return undefined;
  }
}

function isNotFound(r: { stdout: string; stderr: string }): boolean {
  return /not found|no such issue|does not exist/i.test(r.stderr || r.stdout);
}

function toTask(issue: BeadsIssue): Task {
  const now = new Date().toISOString();
  return {
    id: issue.id,
    title: issue.title,
    description: issue.description ?? "",
    status: fromBeadsStatus(issue.status),
    author: "",
    tags: (issue.labels ?? []).filter((l) => l !== "budget" || true), // keep all labels
    assignee: issue.owner ?? null,
    rank: 0,
    blocked_reason: issue.blocked_reason ?? null,
    project_id: null,
    created_at: issue.created_at ?? now,
    updated_at: issue.updated_at ?? now,
    comments: issue.comments
      ? issue.comments.map((c) => ({
          id: c.id ?? "",
          task_id: issue.id,
          author: c.author ?? "",
          content: c.body ?? "",
          created_at: c.created_at ?? now,
        }))
      : undefined,
  };
}

function defaultRunner(bin: string): BeadsRunner {
  return (args: string[]) =>
    new Promise((resolveOut) => {
      execFile(bin, args, { maxBuffer: 8 * 1024 * 1024 }, (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          const code =
            "code" in err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolveOut({ exitCode: code, stdout, stderr: stderr || (err as Error).message });
          return;
        }
        resolveOut({ exitCode: 0, stdout, stderr });
      });
    });
}
