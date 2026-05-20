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
      project_id TEXT,
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

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      entity TEXT NOT NULL DEFAULT '',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      asof TEXT,
      source TEXT,
      confidence REAL,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, category, entity, key)
    );

    CREATE INDEX IF NOT EXISTS idx_facts_lookup
      ON facts(project_id, category, entity, key);
    CREATE INDEX IF NOT EXISTS idx_facts_updated ON facts(updated_at);

    CREATE TRIGGER IF NOT EXISTS trg_facts_updated_at
      AFTER UPDATE ON facts
      BEGIN
        UPDATE facts SET updated_at = datetime('now') WHERE id = NEW.id;
      END;

    CREATE TABLE IF NOT EXISTS workflow_secrets (
      workflow_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (workflow_name, key)
    );

    CREATE TABLE IF NOT EXISTS workflow_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_name TEXT NOT NULL,
      version INTEGER NOT NULL,
      yaml TEXT NOT NULL,
      saved_by TEXT,
      saved_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (workflow_name, version)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_versions_name
      ON workflow_versions(workflow_name, version DESC);

    CREATE TABLE IF NOT EXISTS workflow_form_pending (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
      step_name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      fields_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','submitted','expired','cancelled')),
      submitted_json TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_form_pending_run
      ON workflow_form_pending(run_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_form_pending_status
      ON workflow_form_pending(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_form_pending_step
      ON workflow_form_pending(run_id, step_name);

    CREATE TABLE IF NOT EXISTS notes (
      id          TEXT PRIMARY KEY,
      session_id  TEXT,
      project_id  TEXT,
      agent       TEXT,
      content     TEXT NOT NULL,
      tags        TEXT NOT NULL DEFAULT '[]',
      importance  REAL,
      ref_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      ttl_at      TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notes_ttl ON notes(ttl_at) WHERE ttl_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memory_chunks (
      id          TEXT PRIMARY KEY,
      project_id  TEXT,
      source      TEXT NOT NULL,
      content     TEXT NOT NULL,
      embedding   BLOB,
      embed_model TEXT,
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_project ON memory_chunks(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON memory_chunks(source);

    CREATE TABLE IF NOT EXISTS exploratory_state (
      agent_name             TEXT PRIMARY KEY,
      enabled                INTEGER NOT NULL DEFAULT 1,
      paused_until           TEXT,
      last_tick_at           TEXT,
      last_tick_status       TEXT,
      current_interval_ms    INTEGER,
      tokens_today           INTEGER NOT NULL DEFAULT 0,
      tokens_today_resets_at TEXT,
      runs_today             INTEGER NOT NULL DEFAULT 0,
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS exploratory_runs (
      id              TEXT PRIMARY KEY,
      agent_name      TEXT NOT NULL,
      project_id      TEXT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at        TEXT,
      status          TEXT NOT NULL
        CHECK(status IN ('running','ok','noop','budget','error')),
      tokens_used     INTEGER,
      tool_calls      INTEGER,
      note_ids        TEXT NOT NULL DEFAULT '[]',
      fact_ids        TEXT NOT NULL DEFAULT '[]',
      task_ids        TEXT NOT NULL DEFAULT '[]',
      notified_owner  INTEGER NOT NULL DEFAULT 0,
      summary         TEXT,
      error           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_xruns_agent_started
      ON exploratory_runs(agent_name, started_at);
    CREATE INDEX IF NOT EXISTS idx_xruns_project_started
      ON exploratory_runs(project_id, started_at);

    -- Agent-unification Phase 1 (see docs/agent-unification.md).
    --
    -- core_memory: the always-injected identity layer. One row per
    -- (agent, project_id, section). Sections are typed; content is
    -- agent-authored prose. Hard-capped in code at ~2K tokens total
    -- per (agent, project) so it stays cheap to inject every turn.
    CREATE TABLE IF NOT EXISTS core_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent       TEXT NOT NULL,
      project_id  TEXT,
      section     TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by  TEXT
    );

    -- SQLite treats NULL as distinct in UNIQUE constraints, so we use
    -- a COALESCE-wrapped unique index to enforce one row per
    -- (agent, project_id, section) — including project_id IS NULL.
    -- This is also the index lookups will hit, so we don't need a
    -- separate non-unique one.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_core_memory_uniq
      ON core_memory(agent, COALESCE(project_id, ''), section);

    -- tick_log: operational telemetry for every exploratory/heartbeat
    -- tick. Conventional kind values: start, noop, material, delegate,
    -- workflow, error. Open TEXT so we can add kinds without ALTER
    -- TABLE pain.
    --
    -- Critically: this table is NEVER queried by recall. It's a
    -- separate channel from semantic memory by design — that's the
    -- whole point of having it.
    CREATE TABLE IF NOT EXISTS tick_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tick_id     TEXT NOT NULL,
      agent       TEXT NOT NULL,
      project_id  TEXT,
      kind        TEXT NOT NULL,
      summary     TEXT,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tick_log_tick
      ON tick_log(tick_id);
    CREATE INDEX IF NOT EXISTS idx_tick_log_agent_created
      ON tick_log(agent, created_at);
    CREATE INDEX IF NOT EXISTS idx_tick_log_kind_created
      ON tick_log(kind, created_at);

    -- email_seen: dedup ledger so the email-fetcher agent doesn't
    -- have to remember which messages it already processed. The
    -- whole point: set membership belongs in SQL, not in an LLM
    -- prompt. message_id is Gmail's unique id; subject_hash is for
    -- "same sender + same subject template" rules later.
    CREATE TABLE IF NOT EXISTS email_seen (
      message_id   TEXT PRIMARY KEY,
      thread_id    TEXT,
      from_addr    TEXT,
      subject_hash TEXT,
      seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
      disposition  TEXT NOT NULL DEFAULT 'noted',
      notes        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_email_seen_seen_at
      ON email_seen(seen_at);
    CREATE INDEX IF NOT EXISTS idx_email_seen_from
      ON email_seen(from_addr);

    -- audit_log: append-only audit trail for config/permission changes.
    -- Cryptographic chaining via hash/prev_hash prevents tampering.
    -- No UPDATE or DELETE allowed — only INSERT.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      before      TEXT,
      after       TEXT,
      context     TEXT,
      hash        TEXT NOT NULL,
      prev_hash   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_action
      ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor
      ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
      ON audit_log(timestamp);

    -- Append-only enforcement: block UPDATE and DELETE via triggers.
    CREATE TRIGGER IF NOT EXISTS audit_log_block_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
      END;

    CREATE TRIGGER IF NOT EXISTS audit_log_block_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed');
      END;
  `);

  // Safe migration for existing DBs that lack session_key
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN session_key TEXT");
  } catch {
    // Column already exists
  }

  // Safe migration: per-job project binding
  try {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN project_id TEXT");
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

  // Safe migration: ref_count on notes (M6 — reference-count promotion).
  try {
    db.exec("ALTER TABLE notes ADD COLUMN ref_count INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Safe migration: archival flag on notes (Phase 1, docs/agent-unification.md).
  // Notes flagged archival=1 are the durable subset of recall — survive
  // aggressive sweeps, agent-promoted explicitly.
  try {
    db.exec("ALTER TABLE notes ADD COLUMN archival INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes_archival
      ON notes(archival, created_at);
  `);

  // Safe migration: session title + pinned flag (DUX1 — chat persistence).
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN title TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_pinned_updated
      ON sessions(pinned, updated_at);
  `);

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