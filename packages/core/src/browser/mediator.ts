/**
 * TAI re-export of the framework-agnostic browser mediator. The
 * canonical implementation lives in `@tailored-ai/browser-mediator`;
 * TAI keeps this thin shim so existing imports under
 * `@tailored-ai/core` continue to work and so the `db`/`vaultKey`
 * convenience options (TAI-specific) can be threaded through to the
 * upstream mediator's `resolveSecret` callback.
 */

import {
  type BrowserAuditEntry as UpstreamAuditEntry,
  BrowserMediator as UpstreamBrowserMediator,
  type BrowserMediatorOptions as UpstreamOptions,
} from "@tailored-ai/browser-mediator";
import type Database from "better-sqlite3";

import { vaultGet } from "../vault/vault.js";

export {
  AlwaysHitlRefusedError,
  classifyButtonText,
  EgressBlockedError,
  type LinkRef,
} from "@tailored-ai/browser-mediator";

export type BrowserAuditEntry = UpstreamAuditEntry;

/**
 * Options accepted by TAI's mediator wrapper. Adds `db`/`vaultKey` as
 * a shorthand for "use the TAI vault for `$ns.key` expansion". When
 * both are present, a `resolveSecret` callback is constructed
 * automatically.
 */
export interface BrowserMediatorOptions extends UpstreamOptions {
  db?: Database.Database;
  vaultKey?: Buffer;
}

export class BrowserMediator extends UpstreamBrowserMediator {
  constructor(opts: BrowserMediatorOptions = {}) {
    const { db, vaultKey, resolveSecret, ...rest } = opts;
    const merged: UpstreamOptions = { ...rest };
    if (resolveSecret) {
      merged.resolveSecret = resolveSecret;
    } else if (db) {
      merged.resolveSecret = async (ns, key) => vaultGet(db, ns, key, vaultKey);
    }
    super(merged);
  }
}
