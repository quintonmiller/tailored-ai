/**
 * Variable scope and `${...}` substitution for workflows.
 *
 * Two forms:
 * - String containing `${...}` chunks → result is a string with each chunk
 *   replaced by `String(value)`. Missing references render as empty string.
 * - String whose entire value is one `${...}` → returns the underlying
 *   value preserving its type (so `${input.tasks}` can resolve to an array
 *   for `loop.over`).
 */

export interface Scope {
  input?: unknown;
  steps?: Record<string, unknown>;
  prev?: unknown;
  env?: Record<string, string | undefined>;
  /** Loop iteration bindings, keyed by `loop.as`. */
  vars?: Record<string, unknown>;
}

const PLACEHOLDER = /\$\{([^}]+)\}/g;
const SOLO_PLACEHOLDER = /^\$\{([^}]+)\}$/;

export function resolveValue(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") return resolveString(value, scope);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, scope));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveValue(v, scope);
    }
    return out;
  }
  return value;
}

export function resolveString(text: string, scope: Scope): unknown {
  const solo = SOLO_PLACEHOLDER.exec(text);
  if (solo) {
    return lookup(solo[1].trim(), scope);
  }
  return text.replace(PLACEHOLDER, (_, expr) => {
    const v = lookup(String(expr).trim(), scope);
    if (v == null) return "";
    if (typeof v === "object") {
      try {
        return JSON.stringify(v);
      } catch {
        return "[unstringifiable]";
      }
    }
    return String(v);
  });
}

export function lookup(path: string, scope: Scope): unknown {
  const parts = splitPath(path);
  if (parts.length === 0) return undefined;
  const head = parts[0];
  let current: unknown;
  if (head === "input") current = scope.input;
  else if (head === "steps") current = scope.steps ?? {};
  else if (head === "prev") current = scope.prev;
  else if (head === "env") current = scope.env ?? {};
  else if (scope.vars && head in scope.vars) current = scope.vars[head];
  else return undefined;
  for (let i = 1; i < parts.length; i++) {
    if (current == null) return undefined;
    const key = parts[i];
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Split a dotted path with optional bracket indexing: `steps.foo.items[0]`. */
function splitPath(path: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (c === ".") {
      if (buf) out.push(buf);
      buf = "";
    } else if (c === "[") {
      if (buf) out.push(buf);
      buf = "";
      const close = path.indexOf("]", i);
      if (close === -1) return [];
      out.push(path.slice(i + 1, close).replace(/^['"]|['"]$/g, ""));
      i = close;
    } else {
      buf += c;
    }
  }
  if (buf) out.push(buf);
  return out;
}
