/**
 * Process-global crosstalk policy. The mediator restricts its own
 * outbound network via Playwright's route() but the host application
 * almost always has sibling outbound tools (HTTP fetch, search APIs,
 * webhooks). While a mediator session is active those tools should
 * consult `isHostAllowed()` and refuse hosts outside the session's
 * allow-list. Multiple concurrent sessions intersect their lists
 * (most restrictive wins) so a second session cannot widen the first.
 *
 * The module is intentionally process-local. Distributed setups need
 * a different signal mechanism — out of scope for this layer.
 */

interface ActiveSession {
  sessionId: string;
  allowList: string[];
}

const ACTIVE = new Map<string, ActiveSession>();

export function registerMediatorSession(sessionId: string, allowList: string[]): void {
  ACTIVE.set(sessionId, {
    sessionId,
    allowList: allowList.map((h) => h.toLowerCase()),
  });
}

export function unregisterMediatorSession(sessionId: string): void {
  ACTIVE.delete(sessionId);
}

export function hasActiveMediatorSession(): boolean {
  return ACTIVE.size > 0;
}

export function activeSessionIds(): string[] {
  return [...ACTIVE.keys()];
}

export function isHostAllowed(host: string): boolean {
  if (ACTIVE.size === 0) return true;
  const lc = host.toLowerCase();
  for (const session of ACTIVE.values()) {
    if (!hostInList(lc, session.allowList)) return false;
  }
  return true;
}

function hostInList(host: string, list: string[]): boolean {
  if (list.length === 0) return false;
  if (list.includes(host)) return true;
  return list.some((entry) => host.endsWith(`.${entry}`));
}

/** Test-only — wipe all sessions. */
export function _resetEgressPolicy(): void {
  ACTIVE.clear();
}
