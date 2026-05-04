import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, getProjectByPath } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import {
  PROJECT_FILE,
  buildProjectFile,
  findProjectFile,
  readProjectFile,
  resolveProjectFromCwd,
} from "../projects/resolve.js";

let db: Database.Database;
let tmp: string;
let warnings: string[];

const captureWarn = (msg: string) => {
  warnings.push(msg);
};

beforeEach(() => {
  db = initDatabase(":memory:");
  tmp = mkdtempSync(resolve(tmpdir(), "tai-test-"));
  warnings = [];
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("schema migration", () => {
  it("creates path and config_overlay_path columns", () => {
    const cols = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("path");
    expect(names).toContain("config_overlay_path");
  });

  it("upgrades a legacy DB without the new columns", () => {
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
    `);
    legacy.prepare("INSERT INTO projects (id, title) VALUES (?, ?)").run("proj_legacy", "Legacy");
    legacy.close();

    const upgraded = initDatabase(legacyPath);
    const cols = upgraded.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("path");
    expect(names).toContain("config_overlay_path");

    const row = upgraded.prepare("SELECT * FROM projects WHERE id = ?").get("proj_legacy") as {
      path: string | null;
      config_overlay_path: string | null;
    };
    expect(row.path).toBeNull();
    expect(row.config_overlay_path).toBeNull();
    upgraded.close();
  });

  it("enforces unique non-null path", () => {
    createProject(db, { title: "A", path: resolve(tmp, "a") });
    expect(() => createProject(db, { title: "B", path: resolve(tmp, "a") })).toThrow();
    // Multiple null paths are fine
    createProject(db, { title: "C" });
    createProject(db, { title: "D" });
  });
});

describe("createProject + getProjectByPath", () => {
  it("round-trips path + config_overlay_path", () => {
    const path = resolve(tmp, "repo");
    const created = createProject(db, {
      title: "My repo",
      path,
      config_overlay_path: ".tai.yaml",
    });
    expect(created.path).toBe(path);
    expect(created.config_overlay_path).toBe(".tai.yaml");

    const fetched = getProjectByPath(db, path);
    expect(fetched?.id).toBe(created.id);
  });

  it("accepts an explicit id (used by `project init` to mirror disk)", () => {
    const created = createProject(db, { title: "Forced", id: "proj_forced01" });
    expect(created.id).toBe("proj_forced01");
  });
});

describe("findProjectFile", () => {
  it("finds .tai.yaml in cwd", () => {
    writeFileSync(resolve(tmp, PROJECT_FILE), "project: { id: proj_x }\n");
    const found = findProjectFile(tmp);
    expect(found?.dir).toBe(resolve(tmp));
  });

  it("walks up to parent dirs", () => {
    writeFileSync(resolve(tmp, PROJECT_FILE), "project: { id: proj_x }\n");
    const deep = resolve(tmp, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const found = findProjectFile(deep);
    expect(found?.dir).toBe(resolve(tmp));
  });

  it("returns null when nothing is found", () => {
    expect(findProjectFile(tmp)).toBeNull();
  });

  it("respects stopAt", () => {
    writeFileSync(resolve(tmp, PROJECT_FILE), "project: { id: proj_x }\n");
    const sub = resolve(tmp, "sub");
    mkdirSync(sub);
    expect(findProjectFile(sub, sub)).toBeNull();
  });
});

describe("readProjectFile", () => {
  it("parses a valid file", () => {
    const file = resolve(tmp, PROJECT_FILE);
    writeFileSync(file, buildProjectFile({ id: "proj_abc", name: "demo" }));
    const parsed = readProjectFile(file);
    expect(parsed.project.id).toBe("proj_abc");
    expect(parsed.project.name).toBe("demo");
  });

  it("includes config when present", () => {
    const file = resolve(tmp, PROJECT_FILE);
    writeFileSync(file, buildProjectFile({ id: "proj_abc", config: { agent: { temperature: 0.1 } } }));
    const parsed = readProjectFile(file);
    expect(parsed.config).toEqual({ agent: { temperature: 0.1 } });
  });

  it("rejects a file without project.id", () => {
    const file = resolve(tmp, PROJECT_FILE);
    writeFileSync(file, "project: {}\n");
    expect(() => readProjectFile(file)).toThrow(/project\.id/);
  });

  it("rejects non-object content", () => {
    const file = resolve(tmp, PROJECT_FILE);
    writeFileSync(file, "- just\n- a\n- list\n");
    expect(() => readProjectFile(file)).toThrow();
  });
});

describe("resolveProjectFromCwd", () => {
  it("returns null when no project is configured", () => {
    expect(resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn })).toBeNull();
    expect(warnings).toEqual([]);
  });

  it("resolves a project from .tai.yaml + DB row", () => {
    const id = "proj_resolved";
    createProject(db, { id, title: "Resolved", path: resolve(tmp) });
    writeFileSync(resolve(tmp, PROJECT_FILE), buildProjectFile({ id, name: "Friendly" }));

    const ctx = resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn });
    expect(ctx).not.toBeNull();
    expect(ctx?.id).toBe(id);
    expect(ctx?.name).toBe("Friendly");
    expect(ctx?.path).toBe(resolve(tmp));
    expect(ctx?.overlay).toEqual({});
  });

  it("uses DB title when .tai.yaml omits name", () => {
    const id = "proj_titlefallback";
    createProject(db, { id, title: "DB Title", path: resolve(tmp) });
    writeFileSync(resolve(tmp, PROJECT_FILE), buildProjectFile({ id }));

    const ctx = resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn });
    expect(ctx?.name).toBe("DB Title");
  });

  it("returns null and warns if .tai.yaml id is unknown", () => {
    writeFileSync(resolve(tmp, PROJECT_FILE), buildProjectFile({ id: "proj_ghost" }));
    const ctx = resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn });
    expect(ctx).toBeNull();
    expect(warnings.some((w) => w.includes("proj_ghost"))).toBe(true);
  });

  it("warns but uses disk location when registered path differs", () => {
    const id = "proj_moved";
    createProject(db, { id, title: "Moved", path: resolve(tmp, "old") });
    writeFileSync(resolve(tmp, PROJECT_FILE), buildProjectFile({ id }));

    const ctx = resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn });
    expect(ctx?.path).toBe(resolve(tmp));
    expect(warnings.some((w) => w.includes("registered path"))).toBe(true);
  });

  it("falls back to registered ancestor when no .tai.yaml on disk", () => {
    const id = "proj_lazy";
    const root = resolve(tmp);
    createProject(db, { id, title: "Lazy", path: root });
    const deep = resolve(tmp, "src", "nested");
    mkdirSync(deep, { recursive: true });

    const ctx = resolveProjectFromCwd(db, { cwd: deep, warn: captureWarn });
    expect(ctx?.id).toBe(id);
    expect(ctx?.path).toBe(root);
    expect(ctx?.overlayPath).toBe("");
  });

  it("loads overlay config from .tai.yaml when present", () => {
    const id = "proj_overlay";
    createProject(db, { id, title: "Overlay", path: resolve(tmp) });
    writeFileSync(
      resolve(tmp, PROJECT_FILE),
      buildProjectFile({ id, config: { agent: { temperature: 0.9 } } }),
    );

    const ctx = resolveProjectFromCwd(db, { cwd: tmp, warn: captureWarn });
    expect(ctx?.overlay).toEqual({ agent: { temperature: 0.9 } });
  });
});
