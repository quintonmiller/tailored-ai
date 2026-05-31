import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  clearSessionKey,
  createSession,
  getSession,
  getSessionByKey,
  updateSessionModelProvider,
} from "../db/queries.js";

export interface Session {
  id: string;
  model: string;
  provider: string;
  projectId?: string | null;
}

export function newSession(
  db: Database.Database,
  model: string,
  provider: string,
  key?: string,
  projectId?: string | null,
): Session {
  const id = randomUUID();
  createSession(db, id, model, provider, key, projectId);
  return { id, model, provider, projectId: projectId ?? null };
}

export function loadSession(db: Database.Database, id: string): Session | undefined {
  const row = getSession(db, id);
  if (!row) return undefined;
  return { id: row.id, model: row.model, provider: row.provider, projectId: row.project_id };
}

export function findOrCreateSession(
  db: Database.Database,
  key: string,
  model: string,
  provider: string,
  projectId?: string | null,
): Session {
  const existing = getSessionByKey(db, key);
  if (existing) {
    if (existing.model !== model || existing.provider !== provider) {
      updateSessionModelProvider(db, existing.id, model, provider);
    }
    return { id: existing.id, model, provider, projectId: existing.project_id };
  }
  return newSession(db, model, provider, key, projectId);
}

/** Detach the key from the current session and create a fresh one with the same key. */
export function resetSession(
  db: Database.Database,
  key: string,
  model: string,
  provider: string,
  projectId?: string | null,
): Session {
  clearSessionKey(db, key);
  return newSession(db, model, provider, key, projectId);
}
