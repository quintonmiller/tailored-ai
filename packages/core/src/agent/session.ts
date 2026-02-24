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
}

export function newSession(db: Database.Database, model: string, provider: string, key?: string): Session {
  const id = randomUUID();
  createSession(db, id, model, provider, key);
  return { id, model, provider };
}

export function loadSession(db: Database.Database, id: string): Session | undefined {
  const row = getSession(db, id);
  if (!row) return undefined;
  return { id: row.id, model: row.model, provider: row.provider };
}

export function findOrCreateSession(db: Database.Database, key: string, model: string, provider: string): Session {
  const existing = getSessionByKey(db, key);
  if (existing) {
    // Update model/provider to current defaults so resumed sessions pick up config changes
    if (existing.model !== model || existing.provider !== provider) {
      updateSessionModelProvider(db, existing.id, model, provider);
    }
    return { id: existing.id, model, provider };
  }
  return newSession(db, model, provider, key);
}

/** Detach the key from the current session and create a fresh one with the same key. */
export function resetSession(db: Database.Database, key: string, model: string, provider: string): Session {
  clearSessionKey(db, key);
  return newSession(db, model, provider, key);
}
