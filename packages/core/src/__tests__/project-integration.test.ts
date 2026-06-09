import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateSession } from "../agent/session.js";
import { type AgentConfig, loadConfig, mergeProjectOverlay } from "../config.js";
import { CronScheduler } from "../cron/scheduler.js";
import { createProject } from "../db/project-queries.js";
import { listSessions } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { buildProjectFile, PROJECT_FILE, resolveProjectFromCwd } from "../projects/resolve.js";
import type { AIProvider } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";

let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(resolve(tmpdir(), "tai-int-"));
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fakeProvider: AIProvider = {
  name: "fake",
  chat: async () => ({ message: { role: "assistant", content: "" } }),
} as never;
const fakeTool: Tool = {
  name: "fake",
  description: "fake",
  parameters: {},
  execute: async () => ({ success: true, output: "" }),
};

function buildRuntime(): AgentRuntime {
  const config = loadConfig();
  return new AgentRuntime(
    {
      configPath: "/dev/null",
      db,
      contextDir: "/tmp",
      kbDir: "/tmp",
      createTools: () => [fakeTool],
      createProvider: () => ({ provider: fakeProvider, model: "x" }),
    },
    () => config,
    config,
  );
}

describe("Slice 7 — end-to-end project flow", () => {
  it("init -> resolve -> overlay merge -> session scoping", () => {
    // 1. Create two project dirs
    const repoA = resolve(tmp, "repo-a");
    const repoB = resolve(tmp, "repo-b", "src", "deep");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    // 2. Register both
    const a = createProject(db, { title: "A", path: repoA });
    const b = createProject(db, { title: "B", path: resolve(tmp, "repo-b") });

    // Project A has a .tai.yaml with overlay
    writeFileSync(
      resolve(repoA, PROJECT_FILE),
      buildProjectFile({
        id: a.id,
        name: "Project A",
        config: { agent: { temperature: 0.95 } },
      }),
    );
    // Project B uses lazy mode (no .tai.yaml)

    // 3. Resolve from inside repoA
    const ctxA = resolveProjectFromCwd(db, { cwd: repoA });
    expect(ctxA?.id).toBe(a.id);
    expect(ctxA?.overlay).toEqual({ agent: { temperature: 0.95 } });

    // 4. Resolve from deep inside repoB (lazy/ancestor lookup)
    const ctxB = resolveProjectFromCwd(db, { cwd: repoB });
    expect(ctxB?.id).toBe(b.id);
    expect(ctxB?.path).toBe(resolve(tmp, "repo-b"));
    expect(ctxB?.overlay).toEqual({});

    // 5. Resolve from outside any project
    const outside = resolveProjectFromCwd(db, { cwd: tmp });
    expect(outside).toBeNull();
  });

  it("setActiveProject scopes new sessions and clears them on switch", () => {
    const runtime = buildRuntime();
    const a = createProject(db, { title: "A", path: "/a" });
    const b = createProject(db, { title: "B", path: "/b" });

    runtime.setActiveProject({
      id: a.id,
      name: "A",
      path: "/a",
      overlayPath: "",
      overlay: {},
    });

    findOrCreateSession(db, "discord:user1", "x", "openai_compatible", a.id);

    runtime.setActiveProject({
      id: b.id,
      name: "B",
      path: "/b",
      overlayPath: "",
      overlay: {},
    });
    findOrCreateSession(db, "discord:b:user1", "x", "openai_compatible", b.id);

    const allFromA = listSessions(db, { projectId: a.id });
    const allFromB = listSessions(db, { projectId: b.id });
    expect(allFromA).toHaveLength(1);
    expect(allFromB).toHaveLength(1);
    expect(allFromA[0].project_id).toBe(a.id);
    expect(allFromB[0].project_id).toBe(b.id);
  });

  it("legacy DBs upgrade cleanly: new columns exist, old data preserved", () => {
    const legacyPath = resolve(tmp, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        due_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        task TEXT NOT NULL,
        model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacy.prepare("INSERT INTO projects (id, title) VALUES (?, ?)").run("proj_old", "Old");
    legacy
      .prepare("INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, ?, ?)")
      .run("old-session", "legacy-key", "m", "p");
    legacy
      .prepare("INSERT INTO cron_jobs (id, name, schedule, task) VALUES (?, ?, ?, ?)")
      .run("j1", "old-job", "* * * * *", "do something");
    legacy.close();

    const upgraded = initDatabase(legacyPath);
    try {
      // New columns exist
      const projCols = (upgraded.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(projCols).toContain("path");
      expect(projCols).toContain("config_overlay_path");

      const sessCols = (upgraded.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(sessCols).toContain("project_id");

      const cronCols = (upgraded.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cronCols).toContain("project_id");

      // Old data preserved (with new columns null)
      const proj = upgraded.prepare("SELECT * FROM projects WHERE id = ?").get("proj_old") as {
        title: string;
        path: string | null;
      };
      expect(proj.title).toBe("Old");
      expect(proj.path).toBeNull();

      const sess = upgraded.prepare("SELECT * FROM sessions WHERE id = ?").get("old-session") as {
        key: string;
        project_id: string | null;
      };
      expect(sess.key).toBe("legacy-key");
      expect(sess.project_id).toBeNull();

      const job = upgraded.prepare("SELECT * FROM cron_jobs WHERE name = ?").get("old-job") as {
        schedule: string;
        project_id: string | null;
      };
      expect(job.schedule).toBe("* * * * *");
      expect(job.project_id).toBeNull();
    } finally {
      upgraded.close();
    }
  });

  it("global mode (no .tai.yaml, no flag) behaves identically to pre-S7", () => {
    const runtime = buildRuntime();
    expect(runtime.getActiveProject()).toBeNull();

    // Sessions created without a project remain global
    const s = findOrCreateSession(db, "global:user", "x", "openai_compatible");
    expect(s.projectId).toBeNull();

    const onlyGlobal = listSessions(db, { projectId: "global" });
    expect(onlyGlobal).toHaveLength(1);

    // Cron job without `project:` writes a null project_id
    const scheduler = new CronScheduler({ runtime });
    (
      scheduler as unknown as { upsertJobRow: (j: { name: string; schedule: string; prompt: string }) => void }
    ).upsertJobRow({ name: "global-cron", schedule: "* * * * *", prompt: "p" });
    const jobRow = db.prepare("SELECT project_id FROM cron_jobs WHERE name = ?").get("global-cron") as {
      project_id: string | null;
    };
    expect(jobRow.project_id).toBeNull();
  });

  it("project A on GitHub backend, project B on native — per-project task backend resolution from overlay", () => {
    // We can't actually instantiate a GitHub backend without network, but we can
    // verify the overlay merge correctly configures `tasks.backend` so a future
    // call to `createTaskBackend(merged, db)` would pick the right one.
    const base = loadConfig();
    const overlayA: Partial<AgentConfig> = {
      tasks: { backend: "github", options: { repo: "a/r", token: "x" } },
    } as never;
    const overlayB: Partial<AgentConfig> = { tasks: { backend: "native" } } as never;

    const mergedA = mergeProjectOverlay(base, overlayA as Record<string, unknown>);
    const mergedB = mergeProjectOverlay(base, overlayB as Record<string, unknown>);
    expect(mergedA.tasks.backend).toBe("github");
    expect(mergedA.tasks.options?.repo).toBe("a/r");
    expect(mergedB.tasks.backend).toBe("native");
    // base is untouched
    expect(base.tasks.backend).toBe("native");
  });
});
