/**
 * Reading what a dashboard widget's endpoint sent: a value at a dotted path,
 * and a list out of the shapes lists come in. Shared by the Board's renderers
 * and the screens in the 3D world, which draw the same widgets smaller.
 */

/** Read a dotted path (`usage.input`) out of an arbitrary object. */
export function getPath(obj: unknown, path?: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

/** Coerce common list shapes ({items}, {tasks}, {runs}, {hits}, or a raw array). */
export function asArray(data: unknown, path?: string): unknown[] {
  const picked = path ? getPath(data, path) : data;
  if (Array.isArray(picked)) return picked;
  if (picked && typeof picked === "object") {
    for (const k of ["items", "tasks", "runs", "hits", "data", "notes"]) {
      const v = (picked as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}
