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

    -- runtime_settings: deployment-wide switches that must take effect NOW.
    -- Singleton, same shape as autopilot_settings above and for the same
    -- reason: the flag is read live on every check, so flipping it changes
    -- behaviour on the next tick with no restart and no reload.
    --
    -- Deliberately NOT config.yaml. A config write calls runtime.reload(),
    -- and ChannelLifecycleManager restarts a transport whose config block
    -- changed — so pausing from Discord would drop the Discord gateway, i.e.
    -- destroy the surface you just used to ask for the pause. Same reasoning
    -- that put rooms in SQLite (see docs/rooms.md).
    --
    -- pause_scope is the open label 'autonomous' | 'all'; NULL when not
    -- paused. paused_at / paused_by exist so "why is nothing running?" has an
    -- answer that does not require reading a log.
    CREATE TABLE IF NOT EXISTS runtime_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      agents_paused INTEGER NOT NULL DEFAULT 0,
      pause_scope   TEXT,
      paused_at     TEXT,
      paused_by     TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO runtime_settings (id) VALUES (1);

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

    CREATE TABLE IF NOT EXISTS collections (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      name        TEXT NOT NULL,
      notes       TEXT,
      rating      INTEGER CHECK(rating >= 1 AND rating <= 5),
      location    TEXT,
      url         TEXT,
      added_by    TEXT NOT NULL DEFAULT 'user'
        CHECK(added_by IN ('user','tai')),
      source      TEXT CHECK(source IN ('email_id','chat','manual')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_collections_type ON collections(type);
    CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name);

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

    -- email_seen: dedup ledger so a mail-polling agent doesn't
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

    -- notification_log: what the agent has already pushed at the owner unprompted.
    -- Backs the "don't tell me the same thing twice" gate (NotificationGate).
    -- One row per (source, channel, target, dedup_key); repeats bump counters
    -- instead of inserting, so the table stays small and readable.
    --
    -- Only PROACTIVE sends land here — cron deliveries, owner-notifier events,
    -- notify_owner from a background tick. Replies to something the user asked
    -- for never pass through the gate, so they are always free to repeat.
    CREATE TABLE IF NOT EXISTS notification_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      source           TEXT NOT NULL,
      channel          TEXT NOT NULL,
      target           TEXT NOT NULL,
      dedup_key        TEXT NOT NULL,
      normalized       TEXT NOT NULL,
      preview          TEXT,
      first_sent_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
      sent_count       INTEGER NOT NULL DEFAULT 0,
      suppressed_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_log_key
      ON notification_log(source, channel, target, dedup_key);
    CREATE INDEX IF NOT EXISTS idx_notification_log_recent
      ON notification_log(source, channel, target, last_sent_at);

    -- rooms: the deployment's directory of multi-party conversation rooms.
    -- A "room" is a named destination on some transport (a Discord channel, a
    -- Slack channel, a local sqlite room) that several agents and humans share.
    -- Distinct from "channels", which are the transports themselves.
    --
    -- This lives in SQLite rather than config.yaml on purpose: ChannelLifecycleManager
    -- restarts a transport whenever its config block changes (lifecycle.ts), so
    -- writing a newly-created room into channels.discord.* would drop and
    -- reconnect the Discord gateway every time an agent opened a room.
    CREATE TABLE IF NOT EXISTS rooms (
      ref         TEXT PRIMARY KEY,
      backend     TEXT NOT NULL,
      native_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      -- What the room is for, in the agents' own terms. Injected into every
      -- wake prompt, and mirrored to the transport's own description field
      -- (Discord's channel topic) so people see it too.
      purpose     TEXT,
      created_by  TEXT,
      agent_turns INTEGER NOT NULL DEFAULT 0,
      -- Who spoke last, so a reply split across several transport messages
      -- counts as the one turn it actually is.
      last_speaker TEXT,
      -- Webhook credential for transports that can post under a per-message
      -- display name (Discord). Lets each agent appear as its own participant
      -- instead of riding a "[speaker]" text prefix on one shared bot account.
      -- The token is a credential: anyone holding it can post into this room
      -- under any name, so it stays in the local database and never in config.
      webhook_id    TEXT,
      webhook_token TEXT,
      -- When this room was retired. NULL means live. A timestamp rather than a
      -- boolean so "when did we stop watching this?" is answerable at all.
      -- An archived room keeps its subscriptions, cursors, roles and check-in
      -- cadences; the watcher simply stops arming them, which is what makes
      -- archiving reversible where removeRoom is not.
      archived_at    TEXT,
      archived_by    TEXT,
      archive_reason TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- idx_rooms_name_active (unique among LIVE rooms only) is created further
    -- down, with the archive migrations: it is a partial index over
    -- archived_at, and on a database predating that column this block would
    -- abort with "no such column" before any migration had a chance to add it.
    CREATE INDEX IF NOT EXISTS idx_rooms_backend ON rooms(backend, native_id);

    -- room_subscriptions: who is watching what, and how loudly.
    --
    -- Two independent axes, because they answer different questions:
    --   deliver  = WHEN do I look?    push (transport event) | poll (interval)
    --   wake_on  = WHAT makes me run? addressed | all | none
    -- 'none' is a read-only subscription: the agent sees the room in its room
    -- list and can read it on demand, but nothing there ever starts a loop.
    --
    -- cursor is the last message the agent has SEEN (advanced by reads and by
    -- its own posts, so an agent never wakes on its own message). hour_bucket +
    -- wakes_this_hour are the runaway-loop brake: two agents talking to each
    -- other cannot exceed max_wakes_per_hour between them.
    CREATE TABLE IF NOT EXISTS room_subscriptions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      agent           TEXT NOT NULL,
      room_ref        TEXT NOT NULL,
      deliver         TEXT NOT NULL DEFAULT 'push',
      wake_on         TEXT NOT NULL DEFAULT 'addressed',
      poll_seconds    INTEGER,
      -- Wake this agent every N minutes even when nobody has said anything, so
      -- it can act on time passing rather than only on being spoken to.
      check_in_minutes INTEGER,
      -- What this agent is for in THIS room. The room purpose says what the
      -- room is about; this says what one participant's job in it is.
      role             TEXT,
      -- Opt this room into being read together with the agent's other batched
      -- rooms, in one turn with one prompt, rather than a turn of its own.
      -- Off by default: collapsing rooms trades per-room focus for one look at
      -- everything, and that is a deployment's call to make, not a default.
      batch            INTEGER NOT NULL DEFAULT 0,
      last_check_in    TEXT,
      cursor          TEXT,
      source          TEXT NOT NULL DEFAULT 'config',
      last_woke_at    TEXT,
      hour_bucket     TEXT,
      wakes_this_hour INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_room_subscriptions_key
      ON room_subscriptions(agent, room_ref);
    CREATE INDEX IF NOT EXISTS idx_room_subscriptions_room
      ON room_subscriptions(room_ref);

    -- room_messages: storage for the built-in "local" room backend only.
    -- Transport-backed rooms (Discord, Slack) keep their history on the
    -- transport and are read back through the backend's fetchSince.
    CREATE TABLE IF NOT EXISTS room_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      room_ref     TEXT NOT NULL,
      author_id    TEXT NOT NULL,
      author_label TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_room_messages_room
      ON room_messages(room_ref, id);

    -- room_members: membership for the "local" backend, and a cache of
    -- transport-side membership for backends that can report it.
    CREATE TABLE IF NOT EXISTS room_members (
      room_ref   TEXT NOT NULL,
      member_id  TEXT NOT NULL,
      label      TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'unknown',
      added_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_ref, member_id)
    );

    -- agent_schedules: wakes an agent booked for itself.
    --
    -- Distinct from cron_jobs, which the operator authors in config.yaml. These
    -- are written at runtime by the schedule tool, scoped to one agent, and
    -- can express a single future moment as well as a recurrence.
    --
    -- next_run_at is the only column the tick reads, and it is the reason this
    -- is a table rather than a set of timers: a due time in the database
    -- survives a restart, a suspend and a clock jump, none of which setInterval
    -- does.
    CREATE TABLE IF NOT EXISTS agent_schedules (
      id               TEXT PRIMARY KEY,
      agent            TEXT NOT NULL,
      -- What the agent wants to be told when it wakes. This IS the wake.
      note             TEXT NOT NULL,
      kind             TEXT NOT NULL CHECK(kind IN ('once','repeat')),
      -- Exactly one of these is set when kind='repeat'. cron is wall-clock
      -- aligned; interval_seconds is phase-anchored to starts_at.
      cron             TEXT,
      interval_seconds INTEGER,
      -- What the agent typed, echoed back by list so it recognises its own work.
      source           TEXT NOT NULL,
      starts_at        TEXT,
      ends_at          TEXT,
      next_run_at      TEXT NOT NULL,
      target_kind      TEXT NOT NULL CHECK(target_kind IN ('room','session')),
      -- roomRef for 'room', session id for 'session'.
      target           TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','done','cancelled','expired')),
      run_count        INTEGER NOT NULL DEFAULT 0,
      -- Times this wake came due and could not run (wake ceiling). Capped so a
      -- room that is permanently at its limit does not retry forever.
      deferrals        INTEGER NOT NULL DEFAULT 0,
      last_run_at      TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
      ON agent_schedules(status, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent
      ON agent_schedules(agent, status);

    -- audit_log: append-only, SHA-256 chained ledger for config/permission changes.
    -- Schema: id, timestamp, actor, action, before (JSON), after (JSON), context (JSON), hash, prev_hash.
    -- Triggers enforce append-only: UPDATE and DELETE are rejected.
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      before     TEXT,
      after      TEXT,
      context    TEXT,
      hash       TEXT NOT NULL,
      prev_hash  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor
      ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action
      ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp
      ON audit_log(timestamp);

    -- Append-only enforcement: reject UPDATE
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
      END;

    -- Append-only enforcement: reject DELETE
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
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

  // Safe migration: attribute token usage. Recording moved into the agent loop
  // so every call is counted, not just autopilot and exploratory — `source`
  // keeps the autopilot budget scoped to what it used to cover, and `agent`
  // answers "which agent is this costing me", which nothing could before.
  for (const sql of [
    "ALTER TABLE token_usage ADD COLUMN agent TEXT",
    "ALTER TABLE token_usage ADD COLUMN source TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_source_created ON token_usage(source, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_usage_agent_created ON token_usage(agent, created_at);
  `);

  try {
    db.exec("ALTER TABLE rooms ADD COLUMN agent_turns INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  // `topic` was the original name; `purpose` says what it is actually for.
  try {
    db.exec("ALTER TABLE rooms RENAME COLUMN topic TO purpose");
  } catch {
    // Already renamed, or the table was created with `purpose` from the start.
  }

  for (const sql of [
    "ALTER TABLE rooms ADD COLUMN webhook_id TEXT",
    "ALTER TABLE rooms ADD COLUMN webhook_token TEXT",
    "ALTER TABLE rooms ADD COLUMN purpose TEXT",
    "ALTER TABLE room_subscriptions ADD COLUMN check_in_minutes INTEGER",
    "ALTER TABLE room_subscriptions ADD COLUMN last_check_in TEXT",
    "ALTER TABLE rooms ADD COLUMN last_speaker TEXT",
    "ALTER TABLE room_subscriptions ADD COLUMN role TEXT",
    "ALTER TABLE room_subscriptions ADD COLUMN batch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE rooms ADD COLUMN archived_at TEXT",
    "ALTER TABLE rooms ADD COLUMN archived_by TEXT",
    "ALTER TABLE rooms ADD COLUMN archive_reason TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
  }

  // Room names are unique among LIVE rooms only, so archiving "trip" frees the
  // name for the next one — which is the usual reason to retire a room at all.
  //
  // The old index was unconditionally unique, and it has to be DROPPED rather
  // than left beside the new one: an index is a constraint, so leaving it would
  // keep rejecting the reuse this whole feature exists to allow, while the new
  // index sat there looking like it had taken effect. Runs after the ALTERs
  // above because it is partial over a column they may have just added.
  try {
    db.exec("DROP INDEX IF EXISTS idx_rooms_name");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_active ON rooms(name) WHERE archived_at IS NULL");
  } catch (err) {
    // A pre-existing duplicate name would fail the CREATE. Leave the database
    // usable and say which room to rename, rather than aborting startup.
    console.warn(`[rooms] Could not create idx_rooms_name_active: ${(err as Error).message}`);
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

  // Safe migration: global pause switch. Listed individually so a database
  // that got `runtime_settings` from an earlier cut picks up later columns.
  for (const sql of [
    "ALTER TABLE runtime_settings ADD COLUMN agents_paused INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE runtime_settings ADD COLUMN pause_scope TEXT",
    "ALTER TABLE runtime_settings ADD COLUMN paused_at TEXT",
    "ALTER TABLE runtime_settings ADD COLUMN paused_by TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists
    }
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

  // Safe migration: assistant reasoning/thinking trace (#254). Display-only —
  // captured and rendered, never re-sent to a provider. Not indexed.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN reasoning TEXT");
  } catch {
    // Column already exists
  }

  // Safe migration: conversation rewind. A rewound message keeps its row and
  // gains the number of the rewind that hid it; `getSessionMessages` skips
  // stamped rows. Soft rather than a DELETE so the transcript survives, the
  // operation is auditable, and one turn too many can be undone — which is the
  // obvious mistake to make with a rewind command.
  //
  // A counter rather than a timestamp: undo has to restore exactly one rewind,
  // and two rewinds in the same millisecond share an ISO string. That is not a
  // hypothetical — it failed on the first full test run. Ordering that decides
  // correctness should not depend on clock resolution.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN rewound_batch INTEGER");
  } catch {
    // Column already exists
  }

  // Safe migration: compaction, on the same terms as rewind above.
  //
  // Compaction used to DELETE every message in the session and write a
  // model-authored summary in their place, keeping no archive of the originals,
  // no tombstone, and emitting no event. If the summary dropped the one fact
  // that mattered, it was gone. That is a strange asymmetry to have shipped
  // next to a rewind that goes to some length to stay undoable, and it is the
  // reason compaction could not responsibly be made automatic.
  //
  // Same counter-not-timestamp reasoning as rewind: undo restores exactly one
  // compaction, and two in the same millisecond would share an ISO string.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN compacted_batch INTEGER");
  } catch {
    // Column already exists
  }

  // Which compaction a summary row stands in for. Set only on the summary
  // itself, so undoing a compaction can remove the summary it wrote without
  // pattern-matching on the message text — the originals are coming back, and a
  // summary of the conversation sitting next to the conversation is worse than
  // either alone.
  try {
    db.exec("ALTER TABLE messages ADD COLUMN compaction_summary_for INTEGER");
  } catch {
    // Column already exists
  }

  // Safe migration: prompt-cache accounting.
  //
  // `token_usage` recorded prompt and completion only, and the Anthropic
  // provider sums cache reads and writes into its input figure — so a perfect
  // cache hit and a completely cold read were stored as identical numbers, and
  // no change to prompt layout could be shown to have helped or hurt.
  //
  // Nullable rather than DEFAULT 0: most providers do not report caching at
  // all, and "not reported" is a different fact from "nothing was cached".
  // Rows written before this stay NULL rather than claiming a zero.
  for (const col of ["cache_read_tokens", "cache_write_tokens"]) {
    try {
      db.exec(`ALTER TABLE token_usage ADD COLUMN ${col} INTEGER`);
    } catch {
      // Column already exists
    }
  }

  // Safe migration: drop the legacy hard-coded type CHECK on collections so the
  // `type` column is an open label (steelbook, restaurant, book, …). Earlier DBs
  // created the table with CHECK(type IN ('steelbook',…)); rebuild them in place,
  // preserving rows. SQLite can't ALTER a CHECK away, so recreate the table.
  try {
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collections'").get() as
      | { sql?: string }
      | undefined;
    if (ddl?.sql?.includes("CHECK(type IN")) {
      db.exec(`
        BEGIN;
        ALTER TABLE collections RENAME TO collections_legacy;
        CREATE TABLE collections (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          name        TEXT NOT NULL,
          notes       TEXT,
          rating      INTEGER CHECK(rating >= 1 AND rating <= 5),
          location    TEXT,
          url         TEXT,
          added_by    TEXT NOT NULL DEFAULT 'user' CHECK(added_by IN ('user','tai')),
          source      TEXT CHECK(source IN ('email_id','chat','manual')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO collections SELECT * FROM collections_legacy;
        DROP TABLE collections_legacy;
        CREATE INDEX IF NOT EXISTS idx_collections_type ON collections(type);
        CREATE INDEX IF NOT EXISTS idx_collections_name ON collections(name);
        COMMIT;
      `);
    }
  } catch {
    // Table absent or already rebuilt
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
