import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface DocumentMeta {
  id: string;
  project_id: string;
  title: string;
  filename: string;
  created_at: string;
  updated_at: string;
}

function generateId(): string {
  return `doc_${randomUUID().slice(0, 8)}`;
}

export function createDocument(
  db: Database.Database,
  input: { project_id: string; title: string; filename: string },
): DocumentMeta {
  const id = generateId();
  db.prepare(
    "INSERT INTO documents (id, project_id, title, filename) VALUES (?, ?, ?, ?)",
  ).run(id, input.project_id, input.title, input.filename);

  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentMeta;
}

export function getDocument(db: Database.Database, id: string): DocumentMeta | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentMeta | undefined;
}

export function updateDocument(
  db: Database.Database,
  id: string,
  updates: { title?: string },
): DocumentMeta | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push("title = ?");
    values.push(updates.title);
  }

  if (fields.length === 0) return getDocument(db, id);

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const result = db.prepare(`UPDATE documents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  if (result.changes === 0) return undefined;

  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentMeta;
}

export function deleteDocument(db: Database.Database, id: string): boolean {
  const result = db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  return result.changes > 0;
}

export function listDocuments(
  db: Database.Database,
  projectId: string,
  search?: string,
): DocumentMeta[] {
  if (search) {
    return db
      .prepare("SELECT * FROM documents WHERE project_id = ? AND title LIKE ? ORDER BY updated_at DESC")
      .all(projectId, `%${search}%`) as DocumentMeta[];
  }
  return db
    .prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY updated_at DESC")
    .all(projectId) as DocumentMeta[];
}
