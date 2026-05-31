import type Database from "better-sqlite3";
import { formatVaultKey, vaultGet, vaultIsFetcher } from "./vault.js";

/**
 * Reference parser for `$ns.key` expansion in tool arguments.
 *
 * The mediator dereferences `$ns.key` references at the boundary before
 * passing arguments to tools. Expanded values never appear in tool returns
 * or audit logs — they are masked in outputs.
 *
 * Single-use fetcher refs trigger an external MCP fetch on expansion when
 * the value is not cached.
 */

/** Regex to find `$ns.key` references in strings. */
const REF_PATTERN = /\$([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)/g;

/** Masked output format for vault-fill regions. */
export function maskRef(ref: string): string {
  return `<masked:${ref}>`;
}

/**
 * Expand all `$ns.key` references in a string using the vault.
 * Returns the expanded string. Unresolved refs are left as-is.
 */
export async function expandRefs(
  input: string,
  db: Database.Database,
  opts?: {
    encryptionKey?: Buffer;
    /** When true, fetcher refs trigger an MCP fetch for uncached values. */
    fetcherHandler?: (namespace: string, key: string) => Promise<string | null>;
  },
): Promise<string> {
  const matches = [...input.matchAll(REF_PATTERN)];
  if (matches.length === 0) return input;

  let result = "";
  let lastEnd = 0;

  const promises = matches.map(async (match) => {
    const fullRef = match[0]; // $ns.key
    const namespace = match[1];
    const key = match[2];
    const value = vaultGet(db, namespace, key, opts?.encryptionKey);

    if (value !== null) {
      return { match: fullRef, replacement: value, resolved: true };
    }

    // Check if it's a fetcher ref and try to fetch
    if (vaultIsFetcher(db, namespace, key) && opts?.fetcherHandler) {
      const fetched = await opts.fetcherHandler(namespace, key);
      if (fetched !== null) {
        return { match: fullRef, replacement: fetched, resolved: true };
      }
    }

    return { match: fullRef, replacement: fullRef, resolved: false };
  });

  const resolutions = await Promise.all(promises);

  for (const res of resolutions) {
    const idx = input.indexOf(res.match, lastEnd);
    if (idx < lastEnd) continue; // skip if already processed
    result += input.slice(lastEnd, idx) + res.replacement;
    lastEnd = idx + res.match.length;
  }
  result += input.slice(lastEnd);

  return result;
}

/**
 * Expand refs in a tool argument object (recursive).
 * Handles nested objects and arrays.
 */
export function expandRefsInArgs(
  args: Record<string, unknown>,
  db: Database.Database,
  opts?: Parameters<typeof expandRefs>[2],
): Promise<Record<string, unknown>> {
  return expandValue(args, db, opts) as Promise<Record<string, unknown>>;
}

async function expandValue(
  value: unknown,
  db: Database.Database,
  opts?: Parameters<typeof expandRefs>[2],
): Promise<unknown> {
  if (typeof value === "string") {
    return expandRefs(value, db, opts);
  }
  if (Array.isArray(value)) {
    const expanded = await Promise.all(value.map((item) => expandValue(item, db, opts)));
    return expanded;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const expanded: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      expanded[k] = await expandValue(v, db, opts);
    }
    return expanded;
  }
  return value;
}

/**
 * Mask all `$ns.key` references in output strings.
 * Used for tool returns and audit logs to prevent secret leakage.
 */
export function maskRefsInOutput(output: string): string {
  return output.replace(REF_PATTERN, (_, ns, key) => {
    return maskRef(`$${ns}.${key}`);
  });
}

/**
 * Mask refs recursively in a tool result object.
 */
export function maskRefsInResult(result: unknown): unknown {
  if (typeof result === "string") {
    return maskRefsInOutput(result);
  }
  if (Array.isArray(result)) {
    return result.map((item) => maskRefsInResult(item));
  }
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const masked: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      masked[k] = maskRefsInResult(v);
    }
    return masked;
  }
  return result;
}

/**
 * Scan a string for any `$ns.key` references and return them.
 * Used by the audit system to detect if secrets were referenced.
 */
export function findRefsInString(input: string): string[] {
  const matches = [...input.matchAll(REF_PATTERN)];
  return matches.map((m) => formatVaultKey({ namespace: m[1], key: m[2] }));
}

/**
 * Check if a string contains any vault references.
 */
export function hasRefs(input: string): boolean {
  return REF_PATTERN.test(input);
}
