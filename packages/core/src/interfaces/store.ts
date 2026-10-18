/**
 * Components an agent has sent, and what became of them.
 *
 * Kept so an update can find the component it changes and a response can be
 * checked against it after a restart: whether it is still open, whether the
 * action exists, who sent it. The component part in the message is what a
 * surface draws; this is the record of its state.
 */
import type Database from "better-sqlite3";
import type { ComponentSpec } from "../content/types.js";

export type ComponentStatus = "open" | "answered" | "closed" | "expired";

export interface ComponentResponse {
  actionId: string;
  value?: unknown;
  by: string;
  at: string;
}

export interface ComponentRecord {
  spec: ComponentSpec;
  agent: string;
  sessionId: string;
  status: ComponentStatus;
  response?: ComponentResponse;
  /** A closing note from the agent, if it gave one. */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  agent: string;
  session_id: string;
  spec: string;
  status: "open" | "answered" | "closed";
  response: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export class InterfaceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS interface_components (
        id          TEXT PRIMARY KEY,
        agent       TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        spec        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        response    TEXT,
        note        TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interface_components_session ON interface_components(session_id);
    `);
  }

  create(spec: ComponentSpec, agent: string, sessionId: string): ComponentRecord {
    const at = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO interface_components (id, agent, session_id, spec, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(spec.id, agent, sessionId, JSON.stringify(spec), at, at);
    return this.get(spec.id) as ComponentRecord;
  }

  get(id: string): ComponentRecord | null {
    const row = this.db.prepare("SELECT * FROM interface_components WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toRecord(row) : null;
  }

  list(ids: string[]): ComponentRecord[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM interface_components WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids) as Row[];
    return rows.map((r) => this.toRecord(r));
  }

  /** Replace the spec of a component that is still open. False when there is nothing open to update. */
  update(spec: ComponentSpec): boolean {
    const result = this.db
      .prepare("UPDATE interface_components SET spec = ?, updated_at = ? WHERE id = ? AND status = 'open'")
      .run(JSON.stringify(spec), this.now().toISOString(), spec.id);
    return result.changes > 0;
  }

  /**
   * Record the one response a component accepts. False when it is no longer
   * open — answered, closed or expired — so a second click cannot overwrite
   * the first.
   */
  respond(id: string, response: ComponentResponse): boolean {
    const record = this.get(id);
    if (!record || record.status !== "open") return false;
    const result = this.db
      .prepare(
        "UPDATE interface_components SET status = 'answered', response = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(JSON.stringify(response), this.now().toISOString(), id);
    return result.changes > 0;
  }

  close(id: string, note?: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE interface_components SET status = 'closed', note = ?, updated_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(note ?? null, this.now().toISOString(), id);
    return result.changes > 0;
  }

  private toRecord(row: Row): ComponentRecord {
    const spec = JSON.parse(row.spec) as ComponentSpec;
    // Expiry is read, not written: nothing has to run at the moment a component
    // expires for it to stop accepting answers.
    const expired =
      row.status === "open" && spec.expiresAt !== undefined && Date.parse(spec.expiresAt) <= this.now().getTime();
    return {
      spec,
      agent: row.agent,
      sessionId: row.session_id,
      status: expired ? "expired" : row.status,
      ...(row.response ? { response: JSON.parse(row.response) as ComponentResponse } : {}),
      ...(row.note ? { note: row.note } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
