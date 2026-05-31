/**
 * TAI re-export of the framework-agnostic egress crosstalk policy.
 * Canonical implementation lives in `@tailored-ai/browser-mediator`.
 * The `_resetEgressPolicy` test helper is kept in this thin shim
 * because the upstream package exposes it via a private path.
 */
export {
  activeSessionIds,
  hasActiveMediatorSession,
  isHostAllowed,
  registerMediatorSession,
  unregisterMediatorSession,
} from "@tailored-ai/browser-mediator";

import { activeSessionIds, unregisterMediatorSession } from "@tailored-ai/browser-mediator";

/** Test-only — wipe all active sessions. Used by core's test suite. */
export function _resetEgressPolicy(): void {
  for (const id of activeSessionIds()) {
    unregisterMediatorSession(id);
  }
}
