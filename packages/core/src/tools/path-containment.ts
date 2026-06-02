import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * Return true when `child` resolves inside `parent` (or equals it).
 *
 * Uses a true descendant boundary instead of `startsWith` so allowing
 * `/srv/project` doesn't accidentally allow `/srv/project-secrets`. Both
 * paths are normalized with `path.resolve` before comparison so `..` and
 * redundant separators are flattened.
 *
 * @param child - The candidate path. May be relative or absolute.
 * @param parent - The container path. May be relative or absolute.
 * @param cwd - Base directory used to normalize relative paths. Defaults to
 *   `process.cwd()`.
 */
export function isPathContained(child: string, parent: string, cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  const rChild = resolve(base, child);
  const rParent = resolve(base, parent);
  if (rChild === rParent) return true;
  // Append the platform separator so "/srv/project" matches "/srv/project/foo"
  // but NOT "/srv/project-secrets" or "/srv/projectx".
  return rChild.startsWith(rParent + sep);
}

/**
 * Like {@link isPathContained}, but resolves symlinks to defend against
 * symlink-escape attacks (e.g. a writable file under the sandbox that
 * symlinks to /etc/passwd).
 *
 * - For an existing target: resolves the full target path via realpath.
 * - For a not-yet-existing target (write case): resolves the nearest
 *   existing ancestor's realpath, then re-appends the missing suffix.
 *
 * Returns true only when the symlink-resolved child still lives inside
 * the symlink-resolved parent. Returns false (denied) when either side
 * can't be resolved.
 *
 * @param child - The candidate path.
 * @param parent - The container path.
 * @param cwd - Base directory used to normalize relative paths.
 */
export function isPathContainedRealpath(child: string, parent: string, cwd?: string): boolean {
  const base = cwd ?? process.cwd();
  const rChild = resolve(base, child);
  const rParent = resolve(base, parent);
  const realParent = tryRealpath(rParent);
  if (!realParent) return false;
  const realChild = tryRealpathOrNearestParent(rChild);
  if (!realChild) return false;
  if (realChild === realParent) return true;
  return realChild.startsWith(realParent + sep);
}

function tryRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Realpath a path that may not exist yet (write case): walk up until we
 * find an existing ancestor, realpath that, then re-append the missing
 * suffix. Returns undefined if no ancestor exists (shouldn't happen on a
 * normal filesystem since "/" always exists).
 */
function tryRealpathOrNearestParent(p: string): string | undefined {
  if (existsSync(p)) {
    return tryRealpath(p);
  }
  const parent = dirname(p);
  if (parent === p) return undefined; // hit fs root
  const realParent = tryRealpathOrNearestParent(parent);
  if (!realParent) return undefined;
  // Re-append the missing suffix. e.g. realParent=/real/srv,
  // p=/srv/project/new.txt → /real/srv/project/new.txt.
  return p.replace(parent, realParent);
}
