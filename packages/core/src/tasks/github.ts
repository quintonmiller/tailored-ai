import { Octokit } from "@octokit/rest";
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

/**
 * GitHub Issues task backend.
 *
 * Mapping
 *   id          ↔ "gh-<issue.number>"
 *   status      ↔ derived from labels: "status:backlog" | "status:in_progress"
 *                  | "status:blocked" | "status:in_review"; closed → "done"
 *   tags        ↔ labels (excluding "status:*" and "reason:*")
 *   assignee    ↔ first assignee's login
 *   author      ↔ issue.user.login
 *   rank        ↔ issue.number (lower = older issue = higher priority)
 *   blocked_reason ↔ first "reason:*" label after the prefix
 *   project_id  ↔ always null (GH issues don't fit our project_id model)
 */

const STATUS_LABEL_PREFIX = "status:";
const REASON_LABEL_PREFIX = "reason:";

const STATUSES: TaskStatusMap = {
  backlog: "backlog",
  inProgress: "in_progress",
  blocked: "blocked",
  done: "done",
};

const STATUS_LABEL: Record<string, string> = {
  backlog: `${STATUS_LABEL_PREFIX}backlog`,
  in_progress: `${STATUS_LABEL_PREFIX}in_progress`,
  blocked: `${STATUS_LABEL_PREFIX}blocked`,
  in_review: `${STATUS_LABEL_PREFIX}in_review`,
};

export interface GitHubBackendOptions {
  /** "owner/repo" form. */
  repo: string;
  /** GitHub personal access token with repo scope. */
  token: string;
  /** Inject a pre-built Octokit instance (mainly for tests). */
  octokit?: Octokit;
}

interface IssueLike {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user?: { login: string } | null;
  assignees?: Array<{ login: string }> | null;
  labels?: Array<string | { name?: string }> | null;
  created_at: string;
  updated_at: string;
}

export class GitHubTaskBackend implements TaskBackend {
  readonly name = "github";
  readonly statuses = STATUSES;
  readonly extraStatuses = ["in_review"] as const;

  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(opts: GitHubBackendOptions) {
    const [owner, repo] = opts.repo.split("/");
    if (!owner || !repo) {
      throw new Error(`tasks.github.repo must be "owner/repo"; got "${opts.repo}"`);
    }
    this.owner = owner;
    this.repo = repo;
    this.octokit = opts.octokit ?? new Octokit({ auth: opts.token });
  }

  isDone(status: string): boolean {
    return status === "done";
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const labels = this.buildLabels(input.tags, input.status, undefined);
    const r = await this.octokit.rest.issues.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.description ?? "",
      labels,
      assignees: input.assignee ? [input.assignee] : undefined,
    });
    return this.toTask(r.data as IssueLike);
  }

  async get(id: string): Promise<Task | undefined> {
    const num = parseId(id);
    if (num === null) return undefined;
    try {
      const r = await this.octokit.rest.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: num,
      });
      const c = await this.octokit.rest.issues.listComments({
        owner: this.owner,
        repo: this.repo,
        issue_number: num,
      });
      const task = this.toTask(r.data as IssueLike);
      task.comments = c.data.map((cm) => ({
        id: cm.id,
        task_id: id,
        author: cm.user?.login ?? "",
        content: cm.body ?? "",
        created_at: cm.created_at,
      }));
      return task;
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async update(id: string, patch: TaskUpdateInput): Promise<Task | undefined> {
    const num = parseId(id);
    if (num === null) return undefined;
    const current = await this.octokit.rest.issues
      .get({ owner: this.owner, repo: this.repo, issue_number: num })
      .catch((err) => (isNotFound(err) ? undefined : Promise.reject(err)));
    if (!current) return undefined;

    const labels = this.mergeLabels(
      (current.data.labels ?? []) as Array<string | { name?: string }>,
      patch.tags,
      patch.status,
      patch.blocked_reason,
    );
    const params: {
      owner: string;
      repo: string;
      issue_number: number;
      title?: string;
      body?: string;
      state?: "open" | "closed";
      labels?: string[];
      assignees?: string[];
    } = {
      owner: this.owner,
      repo: this.repo,
      issue_number: num,
    };
    if (patch.title !== undefined) params.title = patch.title;
    if (patch.description !== undefined) params.body = patch.description;
    if (patch.status === "done") params.state = "closed";
    else if (patch.status !== undefined) params.state = "open";
    if (labels) params.labels = labels;
    if (patch.assignee !== undefined) params.assignees = patch.assignee ? [patch.assignee] : [];

    const r = await this.octokit.rest.issues.update(params);
    return this.toTask(r.data as IssueLike);
  }

  /** GitHub doesn't really delete issues; close instead and surface that. */
  async delete(id: string): Promise<boolean> {
    const num = parseId(id);
    if (num === null) return false;
    try {
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: num,
        state: "closed",
        state_reason: "not_planned",
      });
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    const num = parseId(id);
    if (num === null) return undefined;
    try {
      const r = await this.octokit.rest.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: num,
        body: content,
      });
      return {
        id: r.data.id,
        task_id: id,
        author: author ?? r.data.user?.login ?? "",
        content,
        created_at: r.data.created_at,
      };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async query(filter?: TaskFilter): Promise<TaskQueryResult> {
    const labels: string[] = [];
    if (filter?.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const s of list) {
        if (s in STATUS_LABEL) labels.push(STATUS_LABEL[s]);
      }
    }
    if (filter?.tags) labels.push(...filter.tags);

    // GitHub's state is open|closed|all; pick based on whether any requested status is "done".
    const wantsDone =
      filter?.status &&
      (Array.isArray(filter.status) ? filter.status.includes("done") : filter.status === "done");
    const wantsOpen =
      !filter?.status ||
      (Array.isArray(filter.status)
        ? filter.status.some((s) => s !== "done")
        : filter.status !== "done");

    const state: "open" | "closed" | "all" = wantsDone && wantsOpen ? "all" : wantsDone ? "closed" : "open";

    const r = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state,
      labels: labels.length > 0 ? labels.join(",") : undefined,
      assignee: filter?.assignee,
      since: filter?.updatedAfter,
      per_page: filter?.limit ?? 50,
      page: filter?.offset ? Math.floor(filter.offset / (filter.limit ?? 50)) + 1 : 1,
      sort: filter?.orderBy === "rank" ? "created" : "updated",
      direction: filter?.orderBy === "rank" ? "asc" : "desc",
    });

    // Filter out pull requests (the issues endpoint returns both).
    const issues = r.data.filter((i) => !("pull_request" in i && i.pull_request));
    let tasks = issues.map((i) => this.toTask(i as IssueLike));

    if (filter?.search) {
      const needle = filter.search.toLowerCase();
      tasks = tasks.filter((t) => t.title.toLowerCase().includes(needle) || t.description.toLowerCase().includes(needle));
    }

    return { tasks, total: tasks.length };
  }

  async nextBacklogTask(assignees: string[]): Promise<Task | undefined> {
    if (assignees.length === 0) return undefined;
    // Try each assignee in turn; first hit wins (lowest issue number under that assignee).
    for (const assignee of assignees) {
      const r = await this.octokit.rest.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "open",
        labels: STATUS_LABEL.backlog,
        assignee,
        per_page: 1,
        sort: "created",
        direction: "asc",
      });
      const issues = r.data.filter((i) => !("pull_request" in i && i.pull_request));
      if (issues.length > 0) return this.toTask(issues[0] as IssueLike);
    }
    return undefined;
  }

  async claimBacklog(id: string): Promise<Task | undefined> {
    const num = parseId(id);
    if (num === null) return undefined;
    const current = await this.octokit.rest.issues
      .get({ owner: this.owner, repo: this.repo, issue_number: num })
      .catch((err) => (isNotFound(err) ? undefined : Promise.reject(err)));
    if (!current) return undefined;

    const status = deriveStatus(current.data as IssueLike);
    if (status !== "backlog") return undefined; // already claimed elsewhere

    const labels = this.mergeLabels(
      (current.data.labels ?? []) as Array<string | { name?: string }>,
      undefined,
      "in_progress",
      undefined,
    );
    const r = await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: num,
      labels,
    });
    return this.toTask(r.data as IssueLike);
  }

  async unblockBudgetTasks(): Promise<number> {
    const r = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: "open",
      labels: `${STATUS_LABEL.blocked},${REASON_LABEL_PREFIX}budget`,
      per_page: 100,
    });
    const issues = r.data.filter((i) => !("pull_request" in i && i.pull_request));
    let restored = 0;
    for (const issue of issues) {
      const labels = this.mergeLabels(
        (issue.labels ?? []) as Array<string | { name?: string }>,
        undefined,
        "backlog",
        null,
      );
      // Drop the reason:budget label too.
      const final = labels?.filter((l) => l !== `${REASON_LABEL_PREFIX}budget`) ?? [];
      await this.octokit.rest.issues.update({
        owner: this.owner,
        repo: this.repo,
        issue_number: issue.number,
        labels: final,
      });
      restored++;
    }
    return restored;
  }

  // ---- helpers ----

  private toTask(issue: IssueLike): Task {
    const allLabels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
    const status = deriveStatus(issue);
    const blockedReason = deriveBlockedReason(allLabels);
    const tags = allLabels.filter(
      (l) => !l.startsWith(STATUS_LABEL_PREFIX) && !l.startsWith(REASON_LABEL_PREFIX) && l !== "",
    );
    return {
      id: `gh-${issue.number}`,
      title: issue.title,
      description: issue.body ?? "",
      status,
      author: issue.user?.login ?? "",
      tags,
      assignee: issue.assignees?.[0]?.login ?? null,
      rank: issue.number,
      blocked_reason: blockedReason,
      project_id: null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    };
  }

  private buildLabels(tags?: string[], status?: string, blockedReason?: string | null): string[] | undefined {
    const labels: string[] = tags ? [...tags] : [];
    if (status && status !== "done" && STATUS_LABEL[status]) {
      labels.push(STATUS_LABEL[status]);
    }
    if (blockedReason) labels.push(`${REASON_LABEL_PREFIX}${blockedReason}`);
    return labels.length > 0 ? labels : undefined;
  }

  /**
   * Merge an existing label set with patches.
   *  - tags: when defined, REPLACES the non-status, non-reason labels.
   *  - status: when defined, replaces the existing status:* label (or drops it for "done").
   *  - blockedReason: when defined (including null), replaces reason:* (null = drop).
   */
  private mergeLabels(
    existing: Array<string | { name?: string }>,
    tags: string[] | undefined,
    status: string | undefined,
    blockedReason: string | null | undefined,
  ): string[] | undefined {
    const allTouched = tags !== undefined || status !== undefined || blockedReason !== undefined;
    if (!allTouched) return undefined;

    const existingNames = existing.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
    const carriedTags = tags ?? existingNames.filter(
      (l) => !l.startsWith(STATUS_LABEL_PREFIX) && !l.startsWith(REASON_LABEL_PREFIX),
    );
    const result: string[] = [...carriedTags];

    if (status !== undefined) {
      if (status !== "done" && STATUS_LABEL[status]) {
        result.push(STATUS_LABEL[status]);
      }
    } else {
      const existingStatus = existingNames.find((l) => l.startsWith(STATUS_LABEL_PREFIX));
      if (existingStatus) result.push(existingStatus);
    }

    if (blockedReason !== undefined) {
      if (blockedReason) result.push(`${REASON_LABEL_PREFIX}${blockedReason}`);
    } else {
      const existingReason = existingNames.find((l) => l.startsWith(REASON_LABEL_PREFIX));
      if (existingReason) result.push(existingReason);
    }

    return result;
  }
}

function parseId(id: string): number | null {
  const m = /^(?:gh-|#)?(\d+)$/.exec(id.trim());
  return m ? Number.parseInt(m[1], 10) : null;
}

function deriveStatus(issue: IssueLike): string {
  if (issue.state === "closed") return "done";
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
  for (const l of labels) {
    if (l.startsWith(STATUS_LABEL_PREFIX)) return l.slice(STATUS_LABEL_PREFIX.length);
  }
  return "backlog";
}

function deriveBlockedReason(labels: string[]): string | null {
  for (const l of labels) {
    if (l.startsWith(REASON_LABEL_PREFIX)) return l.slice(REASON_LABEL_PREFIX.length);
  }
  return null;
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status: number }).status === 404;
}
