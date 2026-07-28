/**
 * Live room-backend lookup.
 *
 * Backends are registered at runtime rather than at import time because most
 * of them are capabilities of a *connected* transport: the Discord room
 * backend only exists once the gateway is up, and must disappear when it goes
 * down. This mirrors `runtime.registerOutbound` / `unregisterOutbound`, which
 * solves the same problem for proactive sends.
 *
 * The one exception is the built-in `local` backend, which is pure SQLite and
 * is registered when the runtime is constructed.
 */

import { Registry } from "../registry.js";
import type { RoomBackend } from "./types.js";

export const roomBackendRegistry = new Registry<RoomBackend>("room-backend");

type BackendListener = () => void;
const listeners = new Set<BackendListener>();

/**
 * Fire when the set of connected backends changes.
 *
 * The watcher needs this because backends appear LATE: `client.login()`
 * resolves before Discord's ClientReady, so the watcher is armed while the
 * registry is still empty and its push subscriptions would silently bind to
 * nothing. Re-arming on registration is what makes push work at all.
 */
export function onRoomBackendChange(listener: BackendListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error(`[rooms] Backend listener failed: ${(err as Error).message}`);
    }
  }
}

export function registerRoomBackend(backend: RoomBackend): void {
  roomBackendRegistry.register(backend.id, backend);
  notify();
}

export function unregisterRoomBackend(id: string): boolean {
  const removed = roomBackendRegistry.unregister(id);
  if (removed) notify();
  return removed;
}

export function getRoomBackend(id: string): RoomBackend | undefined {
  return roomBackendRegistry.get(id);
}

export function listRoomBackends(): RoomBackend[] {
  return roomBackendRegistry.entriesList().map(([, backend]) => backend);
}

/**
 * Look up the backend that owns a ref, with an error message that names what
 * IS available. Room refs outlive connections (they are stored in SQLite), so
 * "backend not connected" is a normal runtime state, not a bug.
 */
export function requireRoomBackend(backendId: string): RoomBackend {
  const backend = roomBackendRegistry.get(backendId);
  if (backend) return backend;
  const available = roomBackendRegistry.list();
  throw new Error(
    available.length > 0
      ? `No room backend "${backendId}" is connected. Available: ${available.join(", ")}.`
      : `No room backend "${backendId}" is connected, and no backends are available. Check that the transport is enabled and connected.`,
  );
}
