import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, id);

    CREATE TRIGGER IF NOT EXISTS trg_messages_update_session
      AFTER INSERT ON messages
      BEGIN
        UPDATE sessions SET updated_at = datetime('now') WHERE id = NEW.session_id;
      END;

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT,
      session_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK(status IN ('backlog','in_progress','blocked','in_review','done','archived')),
      author TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_project_tasks_status ON project_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_project_tasks_updated ON project_tasks(updated_at);

    CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, id);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','completed','archived')),
      due_date TEXT,
      path TEXT,
      config_overlay_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
    CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);

    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);

    CREATE TABLE IF NOT EXISTS autopilot_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      token_cap_1h INTEGER,
      token_cap_5h INTEGER,
      token_cap_24h INTEGER,
      quiet_start TEXT,
      quiet_end TEXT,
      disabled_start TEXT,
      disabled_end TEXT,
      paused INTEGER NOT NULL DEFAULT 0,
      digest_time TEXT DEFAULT '08:00',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO autopilot_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS digest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fired_at TEXT NOT NULL DEFAULT (datetime('now')),
      content TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      task_id TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_task ON token_usage(task_id);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('pending','running','completed','failed','interrupted','cancelled')),
      trigger TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '{}',
      output_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      generation INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_name_started
      ON workflow_runs(workflow_name, started_at);

    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      step_name TEXT NOT NULL,
      step_type TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('pending','running','completed','failed','skipped')),
      attempt INTEGER NOT NULL DEFAULT 1,
      output_json TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      parent_step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
      blocked_on TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_parent ON workflow_steps(parent_step_id);
  `);

  // Safe migration for existing DBs that lack session_key
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN session_key TEXT");
  } catch {
    // Column already exists
  }

  // Safe migration: project scoping on sessions
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
      ON sessions(project_id, updated_at);
  `);

  // Safe migration: add project_id to project_tasks
  try {
    db.exec("ALTER TABLE project_tasks ADD COLUMN project_id TEXT REFERENCES projects(id)");
  } catch {
    // Column already exists
  }

  // Safe migration: autonomous-backlog fields
  const taskColumnAdds: Array<[string, string]> = [
    ["assignee", "ALTER TABLE project_tasks ADD COLUMN assignee TEXT"],
    ["rank", "ALTER TABLE project_tasks ADD COLUMN rank INTEGER NOT NULL DEFAULT 0"],
    ["blocked_reason", "ALTER TABLE project_tasks ADD COLUMN blocked_reason TEXT"],
  ];
  const addedTaskColumns = new Set<string>();
  for (const [name, sql] of taskColumnAdds) {
    try {
      db.exec(sql);
      addedTaskColumns.add(name);
    } catch {
      // Column already exists
    }
  }

  try {
    db.exec("ALTER TABLE projects ADD COLUMN default_assignee TEXT");
  } catch {
    // Column already exists
  }

  try {
    db.exec("ALTER TABLE projects ADD COLUMN path TEXT");
  } catch {
    // Column already exists
  }

  try {
    db.exec("ALTER TABLE projects ADD COLUMN config_overlay_path TEXT");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_path ON projects(path) WHERE path IS NOT NULL;
  `);

  try {
    db.exec("ALTER TABLE autopilot_settings ADD COLUMN digest_time TEXT DEFAULT '08:00'");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_project_tasks_assignee_status_rank
      ON project_tasks(project_id, assignee, status, rank);
  `);

  // Auto-create default project and backfill orphan tasks
  const count = db.prepare("SELECT COUNT(*) as c FROM projects").get() as { c: number };
  if (count.c === 0) {
    const id = `proj_${randomUUID().slice(0, 8)}`;
    db.prepare("INSERT INTO projects (id, title, description) VALUES (?, ?, ?)").run(id, "Default", "Default project");
    db.prepare("UPDATE project_tasks SET project_id = ? WHERE project_id IS NULL").run(id);
  }

  // Backfill rank: if any task has rank=0, assign ranks per project by created_at order
  if (addedTaskColumns.has("rank")) {
    const projectIds = db
      .prepare("SELECT DISTINCT project_id FROM project_tasks WHERE project_id IS NOT NULL")
      .all() as Array<{ project_id: string }>;
    const updateRank = db.prepare("UPDATE project_tasks SET rank = ? WHERE id = ?");
    for (const { project_id } of projectIds) {
      const tasks = db
        .prepare("SELECT id FROM project_tasks WHERE project_id = ? ORDER BY created_at ASC")
        .all(project_id) as Array<{ id: string }>;
      let i = 1;
      for (const t of tasks) {
        updateRank.run(i, t.id);
        i += 1;
      }
    }
  }

  return db;
}
