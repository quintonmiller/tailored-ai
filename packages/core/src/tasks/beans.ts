import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * Beans (https://github.com/hmans/beans) task backend.
 *
 * Shells out to the `beans` CLI to read/write markdown-backed beans.
 *
 * Status mapping (normalized → beans):
 *   backlog       → status=todo
 *   in_progress   → status=in-progress
 *   blocked       → status=todo + tag "status:blocked" (+ optional reason:* tag)
 *   done          → status=completed
 *
 * Beans-native statuses `draft` and `scrapped` are surfaced verbatim via
 * extraStatuses so callers can use them.
 *
 * Other mappings:
 *   assignee      → tag "assignee:<name>" (filtered out of `tags` on read)
 *   blocked_reason→ tag "reason:<value>"
 *   author        → empty (beans has no native author concept)
 *   rank          → 0 (beans natural ordering used for nextBacklogTask)
 *   comments      → appended to body inside <!-- beans-comment ... --> markers
 *                   so they survive a round-trip; stripped from `description`
 *                   on read.
 */

const STATUSES: TaskStatusMap = {
  backlog: "backlog",
  inProgress: "in_progress",
  blocked: "blocked",
  done: "done",
};

const ASSIGNEE_PREFIX = "assignee:";
const STATUS_BLOCKED_TAG = "status:blocked";
const REASON_PREFIX = "reason:";

export type BeansRunner = (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface BeansBackendOptions {
  /** Path to the beans data directory; passed via --beans-path. Optional. */
  path?: string;
  /** beans CLI binary name. Default "beans". */
  bin?: string;
  /** Default bean type when creating tasks. Default "task". */
  type?: string;
  /** Inject a runner for tests. */
  runner?: BeansRunner;
}

interface BeansBeanRow {
  id: string;
  slug?: string;
  path?: string;
  title: string;
  status: string;
  type: string;
  priority?: string;
  tags?: string[];
  created_at: string;
  updated_at: string;
  parent?: string;
  blocked_by?: string[];
  etag?: string;
  body?: string;
}

export class BeansTaskBackend implements TaskBackend {
  readonly name = "beans";
  readonly statuses = STATUSES;
  readonly extraStatuses = ["draft", "scrapped"] as const;

  private bin: string;
  private path?: string;
  private type: string;
  private run: BeansRunner;

  constructor(opts: BeansBackendOptions = {}) {
    this.bin = opts.bin ?? "beans";
    this.path = opts.path;
    this.type = opts.type ?? "task";
    this.run = opts.runner ?? defaultRunner(this.bin);
  }

  isDone(status: string): boolean {
    return status === "done";
  }

  // ---- CRUD ----

  async create(input: TaskCreateInput): Promise<Task> {
    const args = ["create", input.title, "-t", this.type, "--json"];
    if (input.description) args.push("-d", input.description);

    const beansStatus = toBeansStatus(input.status);
    if (beansStatus) args.push("-s", beansStatus);

    const tags = composeTags({
      userTags: input.tags ?? [],
      assignee: input.assignee ?? null,
      status: input.status,
      blockedReason: null,
    });
    for (const t of tags) args.push("--tag", t);

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      throw new Error(`beans create failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const bean = parseBean(r.stdout);
    return toTask(bean);
  }

  async get(id: string): Promise<Task | undefined> {
    const bean = await this.fetch(id, true);
    if (!bean) return undefined;
    return toTask(bean);
  }

  async update(id: string, patch: TaskUpdateInput): Promise<Task | undefined> {
    const current = await this.fetch(id, false);
    if (!current) return undefined;

    const args = ["update", id, "--json"];
    if (patch.title !== undefined) args.push("--title", patch.title);
    if (patch.description !== undefined) args.push("-d", patch.description);

    const newStatus = patch.status;
    if (newStatus !== undefined) {
      const beansStatus = toBeansStatus(newStatus);
      if (beansStatus) args.push("-s", beansStatus);
    }

    const existingTags = current.tags ?? [];
    const existingUserTags = existingTags.filter((t) => !isManagedTag(t));
    const existingAssignee = readAssigneeFromTags(existingTags);
    const existingReason = readBlockedReasonFromTags(existingTags);
    const existingNormStatus = readStatusFromBean(current);

    const finalUserTags = patch.tags ?? existingUserTags;
    const finalAssignee = patch.assignee !== undefined ? patch.assignee : existingAssignee;
    const finalReason = patch.blocked_reason !== undefined ? patch.blocked_reason : existingReason;
    const finalStatus = newStatus ?? existingNormStatus;

    const finalTags = composeTags({
      userTags: finalUserTags,
      assignee: finalAssignee,
      status: finalStatus,
      blockedReason: finalReason ?? null,
    });

    // Remove tags no longer present.
    const finalSet = new Set(finalTags);
    for (const t of existingTags) {
      if (!finalSet.has(t)) args.push("--remove-tag", t);
    }
    // Add tags newly present.
    const existingSet = new Set(existingTags);
    for (const t of finalTags) {
      if (!existingSet.has(t)) args.push("--tag", t);
    }

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      if (isNotFound(r)) return undefined;
      throw new Error(`beans update failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return toTask(parseBean(r.stdout));
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.runArgs(["delete", id, "--yes"]);
    if (r.exitCode === 0) return true;
    if (isNotFound(r)) return false;
    throw new Error(`beans delete failed: ${(r.stderr || r.stdout).trim()}`);
  }

  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    const current = await this.fetch(id, false);
    if (!current) return undefined;
    const cid = randomUUID();
    const at = new Date().toISOString();
    const block = formatCommentBlock({ id: cid, author: author ?? "", at, content });

    const r = await this.runArgs(["update", id, "--body-append", block, "--json"]);
    if (r.exitCode !== 0) {
      if (isNotFound(r)) return undefined;
      throw new Error(`beans comment failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return {
      id: cid,
      task_id: id,
      author: author ?? "",
      content,
      created_at: at,
    };
  }

  async query(filter?: TaskFilter): Promise<TaskQueryResult> {
    const args = ["list", "--json", "--full"];

    if (filter?.status) {
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      const beansStatuses = new Set<string>();
      for (const s of list) {
        const mapped = toBeansStatus(s);
        if (mapped) beansStatuses.add(mapped);
      }
      for (const bs of beansStatuses) {
        args.push("-s", bs);
      }
    }

    if (filter?.tags) {
      for (const t of filter.tags) args.push("--tag", t);
    }

    if (filter?.search) args.push("-S", filter.search);

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      throw new Error(`beans list failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const beans = JSON.parse(r.stdout || "[]") as BeansBeanRow[];

    let tasks = beans.map((b) => toTask(b));

    // Post-filter for things beans CLI can't express directly.
    if (filter?.assignee) {
      tasks = tasks.filter((t) => t.assignee === filter.assignee);
    }
    if (filter?.status) {
      // beans -s may have over-matched (a "todo" bean might be backlog OR blocked
      // depending on tags). Re-filter on normalized status.
      const list = Array.isArray(filter.status) ? filter.status : [filter.status];
      const wanted = new Set(list);
      tasks = tasks.filter((t) => wanted.has(t.status));
    }
    if (filter?.updatedAfter) {
      tasks = tasks.filter((t) => t.updated_at >= (filter.updatedAfter as string));
    }
    if (filter?.project_id !== undefined) {
      tasks = tasks.filter((t) => t.project_id === filter.project_id);
    }

    if (filter?.orderBy === "updated_at") {
      tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }

    const total = tasks.length;
    if (filter?.offset) tasks = tasks.slice(filter.offset);
    if (filter?.limit !== undefined) tasks = tasks.slice(0, filter.limit);

    return { tasks, total };
  }

  // ---- Autopilot helpers ----

  async nextBacklogTask(assignees: string[]): Promise<Task | undefined> {
    if (assignees.length === 0) return undefined;
    const args = ["list", "--json", "--full", "--ready", "--sort", "created"];
    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      throw new Error(`beans list --ready failed: ${(r.stderr || r.stdout).trim()}`);
    }
    const beans = JSON.parse(r.stdout || "[]") as BeansBeanRow[];
    const set = new Set(assignees);
    for (const bean of beans) {
      const t = toTask(bean);
      if (t.status !== "backlog") continue;
      if (t.assignee && set.has(t.assignee)) return t;
    }
    return undefined;
  }

  async claimBacklog(id: string): Promise<Task | undefined> {
    const current = await this.fetch(id, false);
    if (!current) return undefined;
    if (readStatusFromBean(current) !== "backlog") return undefined;

    const args = ["update", id, "-s", "in-progress", "--json"];
    if (current.etag) args.push("--if-match", current.etag);

    const r = await this.runArgs(args);
    if (r.exitCode !== 0) {
      // etag mismatch ⇒ already claimed elsewhere.
      if (/etag|conflict|precondition/i.test(r.stderr)) return undefined;
      if (isNotFound(r)) return undefined;
      throw new Error(`beans claimBacklog failed: ${(r.stderr || r.stdout).trim()}`);
    }
    return toTask(parseBean(r.stdout));
  }

  async unblockBudgetTasks(): Promise<number> {
    const args = ["list", "--json", "--full", "--tag", `${REASON_PREFIX}budget`, "--tag", STATUS_BLOCKED_TAG];
    const r = await this.runArgs(args);
    if (r.exitCode !== 0) return 0;
    const beans = JSON.parse(r.stdout || "[]") as BeansBeanRow[];

    let restored = 0;
    for (const bean of beans) {
      const tags = bean.tags ?? [];
      // Both tags must be present (beans uses OR for --tag, so re-filter).
      if (!tags.includes(STATUS_BLOCKED_TAG)) continue;
      if (!tags.includes(`${REASON_PREFIX}budget`)) continue;

      const upd = await this.runArgs([
        "update",
        bean.id,
        "--remove-tag",
        STATUS_BLOCKED_TAG,
        "--remove-tag",
        `${REASON_PREFIX}budget`,
        "--json",
      ]);
      if (upd.exitCode === 0) restored++;
    }
    return restored;
  }

  // ---- internal helpers ----

  private async fetch(id: string, full: boolean): Promise<BeansBeanRow | undefined> {
    const args = ["show", id, "--json"];
    if (full) args.push("--full");
    const r = await this.runArgs(args);
    if (r.exitCode !== 0) return undefined;
    try {
      const out = JSON.parse(r.stdout) as BeansBeanRow;
      return out?.id ? out : undefined;
    } catch {
      return undefined;
    }
  }

  private async runArgs(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.run(this.path ? ["--beans-path", this.path, ...args] : args);
  }
}

// ---- module-level helpers ----

function toBeansStatus(normalized: string | undefined): string | undefined {
  if (!normalized) return undefined;
  switch (normalized) {
    case "backlog":
      return "todo";
    case "in_progress":
      return "in-progress";
    case "blocked":
      return "todo";
    case "done":
      return "completed";
    case "draft":
      return "draft";
    case "scrapped":
      return "scrapped";
    default:
      return undefined;
  }
}

function readStatusFromBean(bean: BeansBeanRow): string {
  const tags = bean.tags ?? [];
  switch (bean.status) {
    case "todo":
      return tags.includes(STATUS_BLOCKED_TAG) ? "blocked" : "backlog";
    case "in-progress":
      return "in_progress";
    case "completed":
      return "done";
    case "draft":
      return "draft";
    case "scrapped":
      return "scrapped";
    default:
      return bean.status;
  }
}

function isManagedTag(tag: string): boolean {
  return tag.startsWith(ASSIGNEE_PREFIX) || tag === STATUS_BLOCKED_TAG || tag.startsWith(REASON_PREFIX);
}

function readAssigneeFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith(ASSIGNEE_PREFIX)) return t.slice(ASSIGNEE_PREFIX.length);
  }
  return null;
}

function readBlockedReasonFromTags(tags: string[]): string | null {
  for (const t of tags) {
    if (t.startsWith(REASON_PREFIX)) return t.slice(REASON_PREFIX.length);
  }
  return null;
}

function composeTags(opts: {
  userTags: string[];
  assignee: string | null;
  status: string | undefined;
  blockedReason: string | null;
}): string[] {
  const tags = opts.userTags.filter((t) => !isManagedTag(t));
  if (opts.assignee) tags.push(`${ASSIGNEE_PREFIX}${opts.assignee}`);
  if (opts.status === "blocked") tags.push(STATUS_BLOCKED_TAG);
  if (opts.blockedReason) tags.push(`${REASON_PREFIX}${opts.blockedReason}`);
  return tags;
}

function parseBean(stdout: string): BeansBeanRow {
  return JSON.parse(stdout) as BeansBeanRow;
}

function isNotFound(r: { exitCode: number; stderr: string; stdout: string }): boolean {
  return /not found|no such bean/i.test(r.stderr || r.stdout);
}

const COMMENT_BLOCK_RE =
  /\n*<!-- beans-comment id="([^"]+)" author="([^"]*)" at="([^"]+)" -->\n([\s\S]*?)\n<!-- \/beans-comment -->/g;

function formatCommentBlock(c: { id: string; author: string; at: string; content: string }): string {
  return `\n\n<!-- beans-comment id="${c.id}" author="${escapeAttr(c.author)}" at="${c.at}" -->\n${c.content}\n<!-- /beans-comment -->`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "");
}

function extractCommentsFromBody(body: string): { description: string; comments: TaskComment[] } {
  const comments: TaskComment[] = [];
  let m: RegExpExecArray | null;
  COMMENT_BLOCK_RE.lastIndex = 0;
  while ((m = COMMENT_BLOCK_RE.exec(body)) !== null) {
    comments.push({
      id: m[1],
      task_id: "",
      author: m[2],
      created_at: m[3],
      content: m[4],
    });
  }
  const description = body.replace(COMMENT_BLOCK_RE, "").replace(/\n+$/, "");
  return { description, comments };
}

function toTask(bean: BeansBeanRow): Task {
  const tags = bean.tags ?? [];
  const userTags = tags.filter((t) => !isManagedTag(t));
  const assignee = readAssigneeFromTags(tags);
  const blockedReason = readBlockedReasonFromTags(tags);
  const status = readStatusFromBean(bean);

  const rawBody = bean.body ?? "";
  const { description, comments } = extractCommentsFromBody(rawBody);
  for (const c of comments) c.task_id = bean.id;

  return {
    id: bean.id,
    title: bean.title,
    description: description.replace(/^\n+/, ""),
    status,
    author: "",
    tags: userTags,
    assignee,
    rank: 0,
    blocked_reason: blockedReason,
    project_id: null,
    created_at: bean.created_at,
    updated_at: bean.updated_at,
    comments: bean.body !== undefined ? comments : undefined,
  };
}

function defaultRunner(bin: string): BeansRunner {
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
